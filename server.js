const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());

// ADMIN_USERS lets each committee member log in with their own name + PIN, instead of one
// shared PIN. Set it in Railway as a JSON array, e.g.:
//   [{"name":"Arjun Cheruvathari","pin":"9686993334"},{"name":"Anu George","pin":"9738461328"}]
// If ADMIN_USERS is not set (or fails to parse), falls back to the legacy single ADMIN_PIN
// under the name "Committee", so the app keeps working during the transition.
function loadAdminUsers() {
  const raw = process.env.ADMIN_USERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter(u => u && u.pin)
          .map(u => ({ name: String(u.name || 'Committee').trim(), pin: String(u.pin).trim() }));
      }
    } catch (e) {
      console.error('Could not parse ADMIN_USERS env variable as JSON, falling back to ADMIN_PIN:', e.message);
    }
  }
  return [{ name: 'Committee', pin: String(process.env.ADMIN_PIN || '1234').trim() }];
}

const CFG = {
  adminUsers: loadAdminUsers(),
  scannerPin: process.env.SCANNER_PIN || '5678',
  upiId: process.env.UPI_ID || '',
  upiName: process.env.UPI_NAME || 'Aaravam Sadhya Committee',
  adultPrice: Number(process.env.PRICE_ADULT || 450),
  kidPrice: Number(process.env.PRICE_KID || 250)
};

function findAdminUser(pin) {
  const p = String(pin || '').trim();
  if (!p) return null;
  return CFG.adminUsers.find(u => u.pin === p) || null;
}

function checkPin(pin, which) {
  if (which === 'scan') {
    const expected = CFG.scannerPin;
    return String(expected).trim().length > 0 && String(expected).trim() === String(pin || '').trim();
  }
  return !!findAdminUser(pin);
}

function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d;
}

function genToken() {
  return require('crypto').randomBytes(16).toString('hex');
}

async function nextSeq(seqName) {
  const r = await pool.query(`SELECT nextval('${seqName}') AS n`);
  return Number(r.rows[0].n);
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return proto + '://' + req.get('host');
}

// ================= STATIC PAGE ROUTING =================
app.get('/', (req, res) => {
  const token = req.query.t;
  const page = String(req.query.page || '').toLowerCase();
  if (token) return res.sendFile(path.join(__dirname, 'public', 'guest.html'));
  if (page === 'admin') return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  if (page === 'scan') return res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
  return res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// ================= PUBLIC CONFIG =================
app.get('/api/config', (req, res) => {
  res.json({ adultPrice: CFG.adultPrice, kidPrice: CFG.kidPrice, upiId: CFG.upiId, upiName: CFG.upiName });
});

// ================= REGISTRATION =================
async function existingRegistrationsForPhone(phone) {
  const r = await pool.query(
    `SELECT reg_id, flat, phase, contact, adult_names, kid_names, total, status
     FROM registrations WHERE phone = $1 AND status != 'Rejected' ORDER BY id ASC`,
    [phone]
  );
  return r.rows.map(row => ({
    regId: row.reg_id, flat: row.flat, phase: row.phase || '', contact: row.contact,
    adults: row.adult_names || [], kids: row.kid_names || [],
    total: row.total, status: row.status
  }));
}

app.post('/api/register', async (req, res) => {
  try {
    const body = req.body || {};
    const contact = (body.contact || '').trim();
    const flat = (body.flat || '').trim();
    const phase = (body.phase || '').trim().toUpperCase();
    const phone = normalizePhone(body.phone);
    const adults = (body.adults || []).map(n => (n || '').trim()).filter(Boolean);
    const kids = (body.kids || []).map(n => (n || '').trim()).filter(Boolean);
    const txnRef = (body.txnRef || '').trim();
    const confirmDuplicate = !!body.confirmDuplicate;

    if (!contact) return res.json({ success: false, message: 'Please enter your name' });
    if (!flat) return res.json({ success: false, message: 'Please enter your flat number' });
    if (phase !== 'PH1' && phase !== 'PH2') return res.json({ success: false, message: 'Please select a Phase (PH1 or PH2)' });
    // normalizePhone only adds the 91 prefix when the raw input is exactly 10 digits, so any
    // valid number (10 digits, or already 12 with the 91 prefix) normalizes to exactly 12
    // characters. Anything else (too short OR too long, e.g. an accidental extra digit) is invalid.
    if (phone.length !== 12) return res.json({ success: false, message: 'Please enter a valid 10-digit mobile number' });
    if (adults.length === 0 && kids.length === 0) return res.json({ success: false, message: 'Please add at least one adult or kid' });

    if (!confirmDuplicate) {
      const existing = await existingRegistrationsForPhone(phone);
      if (existing.length) {
        return res.json({ success: false, duplicate: true, existing });
      }
    }

    const total = adults.length * CFG.adultPrice + kids.length * CFG.kidPrice;
    const id = await nextSeq('registrations_id_seq');
    const regId = 'REG-' + pad3(id);

    await pool.query(
      `INSERT INTO registrations (id, reg_id, flat, phase, contact, phone, adult_names, kid_names, adult_count, kid_count, total, txn_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Pending')`,
      [id, regId, flat, phase, contact, phone, JSON.stringify(adults), JSON.stringify(kids), adults.length, kids.length, total, txnRef]
    );

    res.json({ success: true, regId, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/lookup', async (req, res) => {
  try {
    const phone = normalizePhone((req.body || {}).phone);
    // A phone number can have more than one registration (e.g. someone chose "book anyway"
    // after a duplicate warning), so return every one of them here, not just the most recent -
    // otherwise an older Confirmed registration disappears from view once a newer Pending one
    // exists for the same number.
    const r = await pool.query(
      `SELECT * FROM registrations WHERE phone = $1 AND status != 'Rejected' ORDER BY id ASC`,
      [phone]
    );
    if (!r.rows.length) return res.json({ found: false });
    const registrations = [];
    for (const reg of r.rows) {
      const entry = {
        regId: reg.reg_id, status: reg.status, flat: reg.flat, phase: reg.phase || '',
        total: reg.total, adultCount: reg.adult_count, kidCount: reg.kid_count
      };
      if (reg.status === 'Confirmed') {
        entry.coupons = await getCouponsForReg(reg.reg_id, baseUrl(req));
        entry.adultCount = entry.coupons.filter(c => c.type === 'Adult').length;
        entry.kidCount = entry.coupons.filter(c => c.type === 'Kid').length;
      }
      registrations.push(entry);
    }
    res.json({ found: true, registrations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ found: false, message: 'Server error: ' + err.message });
  }
});

async function getCouponsForReg(regId, base) {
  const r = await pool.query('SELECT * FROM coupons WHERE reg_id = $1 AND active = true ORDER BY id', [regId]);
  return r.rows.map(c => ({
    couponId: c.coupon_id, name: c.name, type: c.type,
    url: base + '/?t=' + c.token,
    slotNumber: c.slot_number, slotTime: c.slot_time
  }));
}

// ================= ADMIN: REGISTRATIONS =================
app.get('/api/admin/registrations', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const r = await pool.query('SELECT * FROM registrations ORDER BY id ASC');
    const coupR = await pool.query(
      'SELECT reg_id, coupon_id, token, name, type, slot_number, slot_time, checked_in, active FROM coupons ORDER BY id ASC'
    );
    const couponsByReg = {};
    coupR.rows.forEach(c => {
      if (!couponsByReg[c.reg_id]) couponsByReg[c.reg_id] = [];
      couponsByReg[c.reg_id].push({
        couponId: c.coupon_id, name: c.name, type: c.type,
        // url lets the admin console render the exact same QR the resident sees, so it can
        // offer a "download this person's coupon" backup without needing a separate endpoint.
        url: baseUrl(req) + '/?t=' + c.token,
        slotNumber: c.slot_number, slotTime: c.slot_time, checkedIn: c.checked_in, active: c.active
      });
    });
    const registrations = r.rows.map(row => {
      const coupons = couponsByReg[row.reg_id] || [];
      // For Confirmed registrations, the coupons table is the source of truth for who is
      // actually still part of the family (active coupon = still in). This way, even if a
      // coupon row was ever changed or removed directly in the database rather than through
      // the app, the admin console self-corrects instead of showing stale names/counts.
      // Pending registrations have no coupons yet, so they still use the submitted name lists.
      let adults, kids;
      if (row.status === 'Confirmed') {
        adults = coupons.filter(c => c.type === 'Adult' && c.active !== false).map(c => c.name);
        kids = coupons.filter(c => c.type === 'Kid' && c.active !== false).map(c => c.name);
      } else {
        adults = row.adult_names;
        kids = row.kid_names;
      }
      return {
        regId: row.reg_id, flat: row.flat, phase: row.phase || '', contact: row.contact, phone: row.phone,
        adults, kids,
        total: row.total, txnRef: row.txn_ref, status: row.status,
        submittedAt: row.submitted_at,
        confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at,
        rejectedReason: row.rejected_reason, rejectedBy: row.rejected_by, rejectedAt: row.rejected_at,
        coupons
      };
    });
    res.json({ success: true, registrations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/admin/confirm', async (req, res) => {
  if (!checkPin((req.body || {}).pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  const client = await pool.connect();
  try {
    const { regId } = req.body || {};
    const adminUser = findAdminUser((req.body || {}).pin);
    const confirmedBy = adminUser ? adminUser.name : 'Committee';
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM registrations WHERE reg_id = $1 FOR UPDATE', [regId]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Registration not found' });
    }
    const reg = r.rows[0];
    if (reg.status === 'Confirmed') {
      await client.query('ROLLBACK');
      return res.json({ success: true, alreadyConfirmed: true, coupons: await getCouponsForReg(regId, baseUrl(req)), phone: reg.phone });
    }

    const adults = reg.adult_names || [];
    const kids = reg.kid_names || [];
    const created = [];

    async function addPerson(name, type) {
      const cid = await nextSeqInClient(client, 'coupons_id_seq');
      const couponId = 'AAR-' + pad3(cid);
      const token = genToken();
      await client.query(
        `INSERT INTO coupons (id, coupon_id, token, reg_id, name, type, phone, checked_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
        [cid, couponId, token, regId, name, type, reg.phone]
      );
      created.push({ couponId, name, type, url: baseUrl(req) + '/?t=' + token });
    }
    for (const n of adults) await addPerson(n, 'Adult');
    for (const n of kids) await addPerson(n, 'Kid');

    await client.query(
      `UPDATE registrations SET status='Confirmed', confirmed_by=$1, confirmed_at=now() WHERE reg_id=$2`,
      [confirmedBy || '', regId]
    );

    await client.query('COMMIT');
    res.json({ success: true, coupons: created, phone: reg.phone });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

async function nextSeqInClient(client, seqName) {
  const r = await client.query(`SELECT nextval('${seqName}') AS n`);
  return Number(r.rows[0].n);
}

function buildWhatsAppLink(phone, message) {
  return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message);
}

app.get('/api/admin/share-coupons', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const regId = req.query.regId;
    const regR = await pool.query('SELECT * FROM registrations WHERE reg_id=$1', [regId]);
    if (!regR.rows.length) return res.json({ success: false, message: 'Registration not found' });
    const reg = regR.rows[0];
    const coupons = await getCouponsForReg(regId, baseUrl(req));
    if (!coupons.length) return res.json({ success: false, message: 'No coupons generated yet' });
    let msg = 'Happy Onam ' + reg.contact + '! Your Aaravam Sadhya coupons are ready:\n\n';
    coupons.forEach(c => { msg += c.name + ' (' + c.type + '): ' + c.url + '\n'; });
    msg += '\nOpen each link to view your coupon and pick your entry slot.';
    res.json({ success: true, waUrl: buildWhatsAppLink(reg.phone, msg), phone: reg.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.get('/api/admin/share-reminder', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const regId = req.query.regId;
    const regR = await pool.query('SELECT * FROM registrations WHERE reg_id=$1', [regId]);
    if (!regR.rows.length) return res.json({ success: false, message: 'Registration not found' });
    const reg = regR.rows[0];
    const coupons = await getCouponsForReg(regId, baseUrl(req));
    if (!coupons.length) return res.json({ success: false, message: 'No coupons generated yet' });
    let msg = 'Good morning! It\'s Aaravam Sadhya day. Please pick your entry slot now:\n\n';
    coupons.forEach(c => {
      const status = c.slotNumber ? ('already booked Slot ' + c.slotNumber + ' - ' + c.slotTime) : 'not booked yet';
      msg += c.name + ' (' + c.type + ') - ' + status + ': ' + c.url + '\n';
    });
    res.json({ success: true, waUrl: buildWhatsAppLink(reg.phone, msg), phone: reg.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// Lets the committee notify a family via WhatsApp (same pattern as sharing coupons) when their
// registration has been rejected, so they aren't just left wondering what happened.
app.get('/api/admin/share-rejection', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const regId = req.query.regId;
    const regR = await pool.query('SELECT * FROM registrations WHERE reg_id=$1', [regId]);
    if (!regR.rows.length) return res.json({ success: false, message: 'Registration not found' });
    const reg = regR.rows[0];
    if (reg.status !== 'Rejected') return res.json({ success: false, message: 'This registration is not currently rejected' });
    let msg = 'Hello ' + reg.contact + ', regarding your Aaravam Sadhya registration ' + regId + ':\n\n';
    msg += 'Unfortunately this registration could not be confirmed.\n';
    msg += 'Reason: ' + (reg.rejected_reason || 'Not specified') + '\n\n';
    msg += 'If you think this is a mistake, or would like to submit a fresh registration, please contact the Sadhya committee.';
    res.json({ success: true, waUrl: buildWhatsAppLink(reg.phone, msg), phone: reg.phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.get('/api/admin/search', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const q = '%' + (req.query.q || '').toLowerCase() + '%';
    const r = await pool.query(
      `SELECT * FROM coupons WHERE lower(coupon_id) LIKE $1 OR lower(name) LIKE $1 OR lower(phone) LIKE $1 ORDER BY id DESC LIMIT 100`,
      [q]
    );
    const results = r.rows.map(c => ({
      couponId: c.coupon_id, name: c.name, type: c.type, phone: c.phone,
      slotNumber: c.slot_number, slotTime: c.slot_time, checkedIn: c.checked_in, active: c.active
    }));
    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/admin/reset-checkin', async (req, res) => {
  if (!checkPin((req.body || {}).pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const { couponId } = req.body || {};
    const r = await pool.query(
      `UPDATE coupons SET checked_in=false, checked_in_at=NULL WHERE coupon_id=$1 RETURNING id`,
      [couponId]
    );
    if (!r.rows.length) return res.json({ success: false, message: 'Coupon not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ================= ADMIN: REJECT / RESTORE REGISTRATIONS =================
// Reject is for Pending registrations only (e.g. no payment ever received, or a test entry) -
// it keeps the record (with a reason, who rejected it, and when) instead of deleting it
// outright, so there's still an audit trail. A Confirmed family that needs to be fully removed
// should use Delete Registration instead, since coupons already exist for them.
app.post('/api/admin/reject-registration', async (req, res) => {
  const body = req.body || {};
  if (!checkPin(body.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const { regId, reason } = body;
    const admin = findAdminUser(body.pin);
    const r = await pool.query('SELECT * FROM registrations WHERE reg_id = $1', [regId]);
    if (!r.rows.length) return res.json({ success: false, message: 'Registration not found' });
    const reg = r.rows[0];
    if (reg.status !== 'Pending') {
      return res.json({ success: false, message: 'Only Pending registrations can be rejected. Use Delete Registration for a Confirmed family instead.' });
    }
    await pool.query(
      `UPDATE registrations SET status='Rejected', rejected_reason=$1, rejected_by=$2, rejected_at=now() WHERE reg_id=$3`,
      [(reason || '').trim(), admin ? admin.name : 'Committee', regId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/admin/restore-registration', async (req, res) => {
  const body = req.body || {};
  if (!checkPin(body.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const { regId } = body;
    const r = await pool.query('SELECT * FROM registrations WHERE reg_id = $1', [regId]);
    if (!r.rows.length) return res.json({ success: false, message: 'Registration not found' });
    if (r.rows[0].status !== 'Rejected') return res.json({ success: false, message: 'Only a Rejected registration can be restored' });
    await pool.query(
      `UPDATE registrations SET status='Pending', rejected_reason=NULL, rejected_by=NULL, rejected_at=NULL WHERE reg_id=$1`,
      [regId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ================= ADMIN: EDIT / DELETE REGISTRATIONS =================
function diffNames(oldNames, newNames) {
  const oldCount = {};
  oldNames.forEach(n => { oldCount[n] = (oldCount[n] || 0) + 1; });
  const newCount = {};
  newNames.forEach(n => { newCount[n] = (newCount[n] || 0) + 1; });
  const removed = [];
  const added = [];
  const all = new Set([...Object.keys(oldCount), ...Object.keys(newCount)]);
  all.forEach(n => {
    const oc = oldCount[n] || 0, nc = newCount[n] || 0;
    for (let i = 0; i < oc - nc; i++) removed.push(n);
    for (let i = 0; i < nc - oc; i++) added.push(n);
  });
  return { removed, added };
}

app.post('/api/admin/update-registration', async (req, res) => {
  if (!checkPin((req.body || {}).pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const regId = body.regId;
    const flat = (body.flat || '').trim();
    const phase = (body.phase || '').trim().toUpperCase();
    const contact = (body.contact || '').trim();
    const phone = normalizePhone(body.phone);
    const newAdults = (body.adults || []).map(n => (n || '').trim()).filter(Boolean);
    const newKids = (body.kids || []).map(n => (n || '').trim()).filter(Boolean);

    if (!flat) { client.release(); return res.json({ success: false, message: 'Flat number is required' }); }
    if (phase !== 'PH1' && phase !== 'PH2') { client.release(); return res.json({ success: false, message: 'Please select a Phase (PH1 or PH2)' }); }
    if (!contact) { client.release(); return res.json({ success: false, message: 'Contact name is required' }); }
    if (phone.length !== 12) { client.release(); return res.json({ success: false, message: 'Please enter a valid 10-digit mobile number' }); }
    if (newAdults.length === 0 && newKids.length === 0) { client.release(); return res.json({ success: false, message: 'At least one adult or kid is required' }); }

    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM registrations WHERE reg_id = $1 FOR UPDATE', [regId]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Registration not found' });
    }
    const reg = r.rows[0];
    let oldAdults, oldKids;
    if (reg.status === 'Confirmed') {
      // Diff against the live active-coupon roster, not the stored name arrays, so that any
      // drift caused by a coupon being changed/removed directly in the database (bypassing
      // this endpoint) gets reconciled the moment the registration is saved here.
      const activeR = await client.query(
        `SELECT name, type FROM coupons WHERE reg_id=$1 AND active=true`, [regId]
      );
      oldAdults = activeR.rows.filter(c => c.type === 'Adult').map(c => c.name);
      oldKids = activeR.rows.filter(c => c.type === 'Kid').map(c => c.name);
    } else {
      oldAdults = reg.adult_names || [];
      oldKids = reg.kid_names || [];
    }
    const adultsDiff = diffNames(oldAdults, newAdults);
    const kidsDiff = diffNames(oldKids, newKids);

    const disabledCoupons = [];
    const newCoupons = [];

    if (reg.status === 'Confirmed') {
      async function disableOne(name, type) {
        const cr = await client.query(
          `SELECT id, coupon_id FROM coupons WHERE reg_id=$1 AND name=$2 AND type=$3 AND active=true ORDER BY id LIMIT 1`,
          [regId, name, type]
        );
        if (cr.rows.length) {
          await client.query(`UPDATE coupons SET active=false, disabled_at=now() WHERE id=$1`, [cr.rows[0].id]);
          disabledCoupons.push(cr.rows[0].coupon_id);
        }
      }
      for (const n of adultsDiff.removed) await disableOne(n, 'Adult');
      for (const n of kidsDiff.removed) await disableOne(n, 'Kid');

      async function addPerson(name, type) {
        const cid = await nextSeqInClient(client, 'coupons_id_seq');
        const couponId = 'AAR-' + pad3(cid);
        const token = genToken();
        await client.query(
          `INSERT INTO coupons (id, coupon_id, token, reg_id, name, type, phone, checked_in)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
          [cid, couponId, token, regId, name, type, phone]
        );
        newCoupons.push({ couponId, name, type, url: baseUrl(req) + '/?t=' + token });
      }
      for (const n of adultsDiff.added) await addPerson(n, 'Adult');
      for (const n of kidsDiff.added) await addPerson(n, 'Kid');

      await client.query(`UPDATE coupons SET phone=$1 WHERE reg_id=$2`, [phone, regId]);
    }

    const adultCount = newAdults.length, kidCount = newKids.length;
    let total = reg.total;
    if (reg.status === 'Pending') {
      total = adultCount * CFG.adultPrice + kidCount * CFG.kidPrice;
    }

    await client.query(
      `UPDATE registrations SET flat=$1, phase=$2, contact=$3, phone=$4, adult_names=$5, kid_names=$6, adult_count=$7, kid_count=$8, total=$9 WHERE reg_id=$10`,
      [flat, phase, contact, phone, JSON.stringify(newAdults), JSON.stringify(newKids), adultCount, kidCount, total, regId]
    );

    await client.query('COMMIT');
    res.json({ success: true, disabledCoupons, newCoupons, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/delete-registration', async (req, res) => {
  if (!checkPin((req.body || {}).pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const { regId } = body;
    const admin = findAdminUser(body.pin);
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM registrations WHERE reg_id = $1 FOR UPDATE', [regId]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Registration not found' });
    }
    const reg = r.rows[0];

    // Snapshot the registration + its coupons into an audit table BEFORE deleting, so the
    // committee can still see who this was, which coupon codes existed, and - if this was a
    // Confirmed (paid) family - exactly how much needs to be refunded to them.
    const coupR = await client.query('SELECT coupon_id, name, type FROM coupons WHERE reg_id=$1 ORDER BY id', [regId]);
    const couponIds = coupR.rows.map(c => c.coupon_id);
    const wasConfirmed = reg.status === 'Confirmed';
    const refundAmount = wasConfirmed ? (reg.total || 0) : 0;
    // For Confirmed regs, the coupons table (not the stored name arrays) is the source of truth.
    const snapAdults = wasConfirmed ? coupR.rows.filter(c => c.type === 'Adult').map(c => c.name) : (reg.adult_names || []);
    const snapKids = wasConfirmed ? coupR.rows.filter(c => c.type === 'Kid').map(c => c.name) : (reg.kid_names || []);

    const delId = await nextSeqInClient(client, 'deleted_registrations_id_seq');
    await client.query(
      `INSERT INTO deleted_registrations
       (id, reg_id, flat, phase, contact, phone, adult_names, kid_names, coupon_ids, was_confirmed, total, refund_amount, deleted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [delId, reg.reg_id, reg.flat, reg.phase || '', reg.contact, reg.phone,
        JSON.stringify(snapAdults), JSON.stringify(snapKids), JSON.stringify(couponIds),
        wasConfirmed, reg.total || 0, refundAmount, admin ? admin.name : 'Committee']
    );

    await client.query('DELETE FROM coupons WHERE reg_id = $1', [regId]);
    await client.query('DELETE FROM registrations WHERE reg_id = $1', [regId]);
    await client.query('COMMIT');
    res.json({ success: true, wasConfirmed, refundAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

// ================= ADMIN: RESET ALL DATA (for going live after testing) =================
// Wipes every registration, coupon, and deleted-registration record, and restarts the
// REG-xxx / AAR-xxx numbering back to 1, so the app is a clean slate for the real event.
// Requires both a valid admin PIN AND the literal confirm text "RESET" (typed by the admin
// on the frontend via a prompt) as a second safeguard against an accidental click, since this
// action is irreversible and destroys real data, not just a soft-delete.
app.post('/api/admin/reset-all-data', async (req, res) => {
  const body = req.body || {};
  if (!checkPin(body.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  if (body.confirm !== 'RESET') return res.json({ success: false, message: 'Confirmation text did not match. Nothing was deleted.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM coupons');
    await client.query('DELETE FROM registrations');
    await client.query('DELETE FROM deleted_registrations');
    await client.query(`ALTER SEQUENCE registrations_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE coupons_id_seq RESTART WITH 1`);
    await client.query(`ALTER SEQUENCE deleted_registrations_id_seq RESTART WITH 1`);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

// ================= ADMIN: DELETED REGISTRATIONS (audit trail + refunds) =================
app.get('/api/admin/deleted-registrations', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const r = await pool.query('SELECT * FROM deleted_registrations ORDER BY deleted_at DESC');
    const deleted = r.rows.map(d => ({
      id: d.id, regId: d.reg_id, flat: d.flat || '', phase: d.phase || '',
      contact: d.contact || '', phone: d.phone || '',
      adults: d.adult_names || [], kids: d.kid_names || [], couponIds: d.coupon_ids || [],
      wasConfirmed: d.was_confirmed, total: d.total, refundAmount: d.refund_amount,
      refunded: d.refunded, refundedAt: d.refunded_at,
      deletedBy: d.deleted_by, deletedAt: d.deleted_at
    }));
    res.json({ success: true, deleted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/admin/mark-refunded', async (req, res) => {
  const body = req.body || {};
  if (!checkPin(body.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const { id } = body;
    const r = await pool.query(
      'UPDATE deleted_registrations SET refunded=true, refunded_at=now() WHERE id=$1 RETURNING id',
      [id]
    );
    if (!r.rows.length) return res.json({ success: false, message: 'Record not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ================= ADMIN: REVENUE / CASH FLOW DASHBOARD =================
app.get('/api/admin/revenue', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const regs = await pool.query('SELECT * FROM registrations ORDER BY id');
    const coupons = await pool.query('SELECT * FROM coupons ORDER BY id');
    const confirmedRows = regs.rows.filter(r => r.status === 'Confirmed');
    const pendingRows = regs.rows.filter(r => r.status === 'Pending');

    const activeCouponsByReg = {};
    coupons.rows.forEach(c => {
      if (!c.active) return;
      if (!activeCouponsByReg[c.reg_id]) activeCouponsByReg[c.reg_id] = [];
      activeCouponsByReg[c.reg_id].push(c);
    });
    function countFor(regId, type) {
      return (activeCouponsByReg[regId] || []).filter(c => c.type === type).length;
    }

    const confirmedRevenue = confirmedRows.reduce((s, r) => s + (r.total || 0), 0);
    const pendingRevenue = pendingRows.reduce((s, r) => s + (r.total || 0), 0);

    let totalAdultsConfirmed = 0, totalKidsConfirmed = 0;
    confirmedRows.forEach(r => {
      totalAdultsConfirmed += countFor(r.reg_id, 'Adult');
      totalKidsConfirmed += countFor(r.reg_id, 'Kid');
    });
    const adultRevenue = totalAdultsConfirmed * CFG.adultPrice;
    const kidRevenue = totalKidsConfirmed * CFG.kidPrice;

    // Revenue by Phase
    const phaseMap = {};
    confirmedRows.forEach(r => {
      const ph = r.phase || 'Unspecified';
      if (!phaseMap[ph]) phaseMap[ph] = { phase: ph, registrations: 0, adults: 0, kids: 0, revenue: 0 };
      phaseMap[ph].registrations += 1;
      phaseMap[ph].adults += countFor(r.reg_id, 'Adult');
      phaseMap[ph].kids += countFor(r.reg_id, 'Kid');
      phaseMap[ph].revenue += (r.total || 0);
    });
    const byPhase = Object.values(phaseMap).sort((a, b) => a.phase.localeCompare(b.phase));

    // Revenue by Day (based on when payment was confirmed) - gives a simple cash-flow-over-time view
    const dayMap = {};
    confirmedRows.forEach(r => {
      if (!r.confirmed_at) return;
      const day = new Date(r.confirmed_at).toISOString().slice(0, 10);
      if (!dayMap[day]) dayMap[day] = { day, registrations: 0, adults: 0, kids: 0, revenue: 0 };
      dayMap[day].registrations += 1;
      dayMap[day].adults += countFor(r.reg_id, 'Adult');
      dayMap[day].kids += countFor(r.reg_id, 'Kid');
      dayMap[day].revenue += (r.total || 0);
    });
    const byDay = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day));

    // Refunds owed - Confirmed registrations that were later deleted, and haven't been marked
    // as refunded yet. This is money the committee already counted as collected, so removing
    // the registration means it now needs to be paid back.
    const delR = await pool.query('SELECT * FROM deleted_registrations ORDER BY deleted_at ASC');
    const refundsOwedRows = delR.rows.filter(d => (d.refund_amount || 0) > 0 && !d.refunded);
    const refundsOwedTotal = refundsOwedRows.reduce((s, d) => s + (d.refund_amount || 0), 0);
    const refundsPaidTotal = delR.rows.filter(d => d.refunded).reduce((s, d) => s + (d.refund_amount || 0), 0);
    const netRevenue = confirmedRevenue - refundsOwedTotal;

    res.json({
      success: true,
      confirmedRevenue, pendingRevenue, adultRevenue, kidRevenue,
      totalAdultsConfirmed, totalKidsConfirmed,
      refundsOwedTotal, refundsOwedCount: refundsOwedRows.length, refundsPaidTotal,
      netRevenue, byPhase, byDay
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

app.get('/api/admin/dashboard', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const admin = findAdminUser(req.query.pin);
    const slots = await getSlots();
    const coupCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons');
    const bookedCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons WHERE slot_number IS NOT NULL');
    const checkedInCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons WHERE checked_in = true');
    const pendingCount = await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE status = 'Pending'");
    const confirmedCount = await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE status = 'Confirmed'");
    const rejectedCount = await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE status = 'Rejected'");
    res.json({
      success: true, slots, adminName: admin ? admin.name : 'Committee',
      issued: coupCount.rows[0].n, booked: bookedCount.rows[0].n, checkedIn: checkedInCount.rows[0].n,
      pendingRegs: pendingCount.rows[0].n, confirmedRegs: confirmedCount.rows[0].n, rejectedRegs: rejectedCount.rows[0].n
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ================= EXPORT (Excel report) =================
// For Confirmed registrations, adultNames/kidNames should be pre-derived from the live active
// coupons (see caller), so the report always matches the admin console rather than a stored
// name array that could have drifted from a direct database edit.
function regRow(r, adultNames, kidNames) {
  return {
    reg_id: r.reg_id, flat: r.flat, phase: r.phase || '', contact: r.contact, phone: r.phone,
    adults: adultNames.join(', '), kids: kidNames.join(', '),
    adult_count: adultNames.length, kid_count: kidNames.length, total: r.total,
    txn_ref: r.txn_ref || '', status: r.status,
    submitted_at: r.submitted_at ? new Date(r.submitted_at).toLocaleString('en-IN') : '',
    confirmed_by: r.confirmed_by || '',
    confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toLocaleString('en-IN') : ''
  };
}

const REG_COLUMNS = [
  { header: 'Reg ID', key: 'reg_id', width: 12 },
  { header: 'Flat', key: 'flat', width: 12 },
  { header: 'Phase', key: 'phase', width: 10 },
  { header: 'Contact Name', key: 'contact', width: 22 },
  { header: 'Phone', key: 'phone', width: 15 },
  { header: 'Adults (Names)', key: 'adults', width: 30 },
  { header: 'Kids (Names)', key: 'kids', width: 30 },
  { header: 'Adult Count', key: 'adult_count', width: 12 },
  { header: 'Kid Count', key: 'kid_count', width: 12 },
  { header: 'Total (Rs)', key: 'total', width: 12 },
  { header: 'Txn Ref (self-reported)', key: 'txn_ref', width: 20 },
  { header: 'Payment Status', key: 'status', width: 15 },
  { header: 'Submitted At', key: 'submitted_at', width: 20 },
  { header: 'Confirmed By', key: 'confirmed_by', width: 16 },
  { header: 'Confirmed At', key: 'confirmed_at', width: 20 }
];

app.get('/api/admin/export', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.status(403).json({ success: false, message: 'Invalid admin PIN' });
  try {
    const regs = await pool.query('SELECT * FROM registrations ORDER BY id');
    const coupons = await pool.query(
      `SELECT c.*, r.flat AS reg_flat, r.contact AS reg_contact
       FROM coupons c LEFT JOIN registrations r ON r.reg_id = c.reg_id
       ORDER BY c.id`
    );

    const pendingRows = regs.rows.filter(r => r.status === 'Pending');
    const confirmedRows = regs.rows.filter(r => r.status === 'Confirmed');
    const rejectedRows = regs.rows.filter(r => r.status === 'Rejected');

    // Group active coupons by reg_id so Confirmed rows can derive their real, current
    // adult/kid names and counts from the coupons table instead of the (possibly stale)
    // stored name arrays on the registration.
    const activeCouponsByReg = {};
    coupons.rows.forEach(c => {
      if (!c.active) return;
      if (!activeCouponsByReg[c.reg_id]) activeCouponsByReg[c.reg_id] = [];
      activeCouponsByReg[c.reg_id].push(c);
    });
    function namesFor(regId, type) {
      return (activeCouponsByReg[regId] || []).filter(c => c.type === type).map(c => c.name);
    }

    const totalAdults = pendingRows.reduce((s, r) => s + (r.adult_count || 0), 0) +
      confirmedRows.reduce((s, r) => s + namesFor(r.reg_id, 'Adult').length, 0);
    const totalKids = pendingRows.reduce((s, r) => s + (r.kid_count || 0), 0) +
      confirmedRows.reduce((s, r) => s + namesFor(r.reg_id, 'Kid').length, 0);
    const confirmedRevenue = confirmedRows.reduce((s, r) => s + (r.total || 0), 0);
    const pendingRevenue = pendingRows.reduce((s, r) => s + (r.total || 0), 0);
    const checkedInCount = coupons.rows.filter(c => c.checked_in).length;
    const bookedCount = coupons.rows.filter(c => c.slot_number).length;

    const wb = new ExcelJS.Workbook();

    // -------- Summary --------
    const wsSum = wb.addWorksheet('Summary');
    wsSum.columns = [{ key: 'label', width: 32 }, { key: 'value', width: 20 }];
    const summaryData = [
      ['Report generated at', new Date().toLocaleString('en-IN')],
      ['', ''],
      ['Total registrations (families)', regs.rows.length],
      ['  - Pending payment', pendingRows.length],
      ['  - Confirmed (paid)', confirmedRows.length],
      ['  - Rejected', rejectedRows.length],
      ['', ''],
      ['Total people registered', totalAdults + totalKids],
      ['  - Adults', totalAdults],
      ['  - Kids', totalKids],
      ['', ''],
      ['Revenue confirmed (Rs)', confirmedRevenue],
      ['Revenue pending (Rs)', pendingRevenue],
      ['', ''],
      ['Coupons issued', coupons.rows.length],
      ['Slots booked', bookedCount],
      ['Checked in at entrance', checkedInCount]
    ];
    summaryData.forEach(row => wsSum.addRow({ label: row[0], value: row[1] }));
    wsSum.getColumn('label').font = { bold: true };

    // -------- Pending Registrations --------
    const wsPending = wb.addWorksheet('Pending Registrations');
    wsPending.columns = REG_COLUMNS;
    pendingRows.forEach(r => wsPending.addRow(regRow(r, r.adult_names || [], r.kid_names || [])));
    wsPending.getRow(1).font = { bold: true };
    wsPending.autoFilter = { from: 'A1', to: 'O1' };

    // -------- Confirmed Registrations --------
    const wsConfirmed = wb.addWorksheet('Confirmed Registrations');
    wsConfirmed.columns = REG_COLUMNS;
    confirmedRows.forEach(r => wsConfirmed.addRow(regRow(r, namesFor(r.reg_id, 'Adult'), namesFor(r.reg_id, 'Kid'))));
    wsConfirmed.getRow(1).font = { bold: true };
    wsConfirmed.autoFilter = { from: 'A1', to: 'O1' };

    // -------- Rejected Registrations --------
    const wsRejected = wb.addWorksheet('Rejected Registrations');
    wsRejected.columns = [
      { header: 'Reg ID', key: 'reg_id', width: 12 },
      { header: 'Flat', key: 'flat', width: 12 },
      { header: 'Phase', key: 'phase', width: 10 },
      { header: 'Contact Name', key: 'contact', width: 22 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Adults (Names)', key: 'adults', width: 30 },
      { header: 'Kids (Names)', key: 'kids', width: 30 },
      { header: 'Total (Rs)', key: 'total', width: 12 },
      { header: 'Reason', key: 'reason', width: 26 },
      { header: 'Rejected By', key: 'rejected_by', width: 16 },
      { header: 'Rejected At', key: 'rejected_at', width: 20 }
    ];
    rejectedRows.forEach(r => {
      wsRejected.addRow({
        reg_id: r.reg_id, flat: r.flat, phase: r.phase || '', contact: r.contact, phone: r.phone,
        adults: (r.adult_names || []).join(', '), kids: (r.kid_names || []).join(', '), total: r.total,
        reason: r.rejected_reason || '', rejected_by: r.rejected_by || '',
        rejected_at: r.rejected_at ? new Date(r.rejected_at).toLocaleString('en-IN') : ''
      });
    });
    wsRejected.getRow(1).font = { bold: true };
    wsRejected.autoFilter = { from: 'A1', to: 'K1' };

    // -------- Coupon Details (one row per person) --------
    const wsCoupons = wb.addWorksheet('Coupon Details');
    wsCoupons.columns = [
      { header: 'Coupon ID', key: 'coupon_id', width: 12 },
      { header: 'Reg ID', key: 'reg_id', width: 12 },
      { header: 'Flat', key: 'flat', width: 12 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Status', key: 'active', width: 12 },
      { header: 'Slot Number', key: 'slot_number', width: 12 },
      { header: 'Slot Time', key: 'slot_time', width: 12 },
      { header: 'Checked In', key: 'checked_in', width: 12 },
      { header: 'Checked In At', key: 'checked_in_at', width: 20 },
      { header: 'Coupon Generated At', key: 'generated_at', width: 20 }
    ];
    coupons.rows.forEach(c => {
      wsCoupons.addRow({
        coupon_id: c.coupon_id, reg_id: c.reg_id, flat: c.reg_flat || '',
        name: c.name, type: c.type, phone: c.phone || '',
        active: c.active ? 'Active' : 'Disabled',
        slot_number: c.slot_number || '', slot_time: c.slot_time || '',
        checked_in: c.checked_in ? 'Yes' : 'No',
        checked_in_at: c.checked_in_at ? new Date(c.checked_in_at).toLocaleString('en-IN') : '',
        generated_at: c.generated_at ? new Date(c.generated_at).toLocaleString('en-IN') : ''
      });
    });
    wsCoupons.getRow(1).font = { bold: true };
    wsCoupons.autoFilter = { from: 'A1', to: 'L1' };

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Aaravam_Sadhya_Report_${today}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Export failed: ' + err.message });
  }
});

// ================= SLOTS =================
async function getSlots() {
  const slotR = await pool.query('SELECT * FROM slots ORDER BY slot_number');
  const countR = await pool.query(
    'SELECT slot_number, COUNT(*)::int AS n FROM coupons WHERE slot_number IS NOT NULL GROUP BY slot_number'
  );
  const counts = {};
  countR.rows.forEach(row => { counts[row.slot_number] = row.n; });
  return slotR.rows.map(s => ({
    number: s.slot_number, time: s.slot_time, capacity: s.capacity,
    booked: counts[s.slot_number] || 0, remaining: s.capacity - (counts[s.slot_number] || 0)
  }));
}

app.get('/api/slots', async (req, res) => {
  try { res.json(await getSlots()); }
  catch (err) { console.error(err); res.status(500).json([]); }
});

app.post('/api/book-slot', async (req, res) => {
  const client = await pool.connect();
  try {
    const { token, slotNumber } = req.body || {};
    const slotNum = Number(slotNumber);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [slotNum]);

    const cR = await client.query('SELECT * FROM coupons WHERE token=$1', [token]);
    if (!cR.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Coupon not found. Use the link shared with you.' });
    }
    const coupon = cR.rows[0];
    if (!coupon.active) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'This coupon has been cancelled by the committee and can no longer be used.' });
    }

    const slotR = await client.query('SELECT * FROM slots WHERE slot_number=$1', [slotNum]);
    if (!slotR.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Invalid slot selected' });
    }
    const slot = slotR.rows[0];

    const countR = await client.query('SELECT COUNT(*)::int AS n FROM coupons WHERE slot_number=$1', [slotNum]);
    let booked = countR.rows[0].n;
    if (coupon.slot_number === slotNum) booked -= 1;
    if (booked >= slot.capacity) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Sorry, Slot ' + slot.slot_number + ' (' + slot.slot_time + ') is full. Please pick another slot.' });
    }

    await client.query(
      'UPDATE coupons SET slot_number=$1, slot_time=$2, booked_at=now() WHERE token=$3',
      [slotNum, slot.slot_time, token]
    );
    await client.query('COMMIT');
    res.json({ success: true, slotNumber: slot.slot_number, slotTime: slot.slot_time });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

// ================= COUPON LOOKUP (Guest page) =================
app.get('/api/coupon', async (req, res) => {
  try {
    const token = req.query.t;
    const r = await pool.query('SELECT * FROM coupons WHERE token=$1', [token]);
    if (!r.rows.length) return res.json({ found: false });
    const c = r.rows[0];
    res.json({
      found: true, couponId: c.coupon_id, name: c.name, type: c.type,
      slotNumber: c.slot_number, slotTime: c.slot_time,
      checkedIn: c.checked_in, checkedInTime: c.checked_in_at, active: c.active
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ found: false, message: 'Server error: ' + err.message });
  }
});

// ================= SCANNER =================
app.post('/api/scan/peek', async (req, res) => {
  const { token, pin } = req.body || {};
  if (!checkPin(pin, 'scan')) return res.json({ found: false, status: 'bad_pin', message: 'Invalid scanner PIN' });
  try {
    const r = await pool.query('SELECT * FROM coupons WHERE token=$1', [token]);
    if (!r.rows.length) return res.json({ found: false, status: 'not_found', message: 'Coupon not recognized' });
    const c = r.rows[0];
    if (!c.active) {
      return res.json({ found: true, status: 'disabled', name: c.name, type: c.type, couponId: c.coupon_id,
        message: 'This coupon has been cancelled by the committee' });
    }
    if (c.checked_in) {
      return res.json({ found: true, status: 'already_used', name: c.name, type: c.type, couponId: c.coupon_id,
        slotNumber: c.slot_number, slotTime: c.slot_time, checkedInTime: c.checked_in_at });
    }
    if (!c.slot_number) {
      return res.json({ found: true, status: 'no_slot', name: c.name, type: c.type, couponId: c.coupon_id });
    }
    res.json({ found: true, status: 'ready', name: c.name, type: c.type, couponId: c.coupon_id,
      slotNumber: c.slot_number, slotTime: c.slot_time });
  } catch (err) {
    console.error(err);
    res.status(500).json({ found: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/scan/checkin', async (req, res) => {
  const client = await pool.connect();
  try {
    const { token, pin } = req.body || {};
    if (!checkPin(pin, 'scan')) { client.release(); return res.json({ success: false, status: 'bad_pin', message: 'Invalid scanner PIN' }); }
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM coupons WHERE token=$1 FOR UPDATE', [token]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, status: 'not_found', message: 'Coupon not recognized' });
    }
    const c = r.rows[0];
    if (!c.active) {
      await client.query('ROLLBACK');
      return res.json({ success: false, status: 'disabled', message: 'This coupon has been cancelled by the committee',
        name: c.name, couponId: c.coupon_id });
    }
    if (c.checked_in) {
      await client.query('ROLLBACK');
      return res.json({ success: false, status: 'already_used', message: 'Already checked in',
        name: c.name, couponId: c.coupon_id, slotTime: c.slot_time, checkedInTime: c.checked_in_at });
    }
    if (!c.slot_number) {
      await client.query('ROLLBACK');
      return res.json({ success: false, status: 'no_slot', message: 'No slot booked yet', name: c.name, couponId: c.coupon_id });
    }
    await client.query('UPDATE coupons SET checked_in=true, checked_in_at=now() WHERE token=$1', [token]);
    await client.query('COMMIT');
    res.json({ success: true, status: 'ok', name: c.name, couponId: c.coupon_id, slotNumber: c.slot_number, slotTime: c.slot_time });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

// ================= SCANNER: GROUP CHECK-IN (reduce gate delay) =================
// A family sharing one phone with, say, 10 coupons open in separate tabs is slow to scan one by
// one. Instead, scan/type any ONE member's code and the gate sees the whole family's coupons at
// once, with checkboxes, so the whole group can be admitted together in a single tap.
app.post('/api/scan/family', async (req, res) => {
  const { token, pin } = req.body || {};
  if (!checkPin(pin, 'scan')) return res.json({ found: false, status: 'bad_pin', message: 'Invalid scanner PIN' });
  try {
    const cR = await pool.query('SELECT * FROM coupons WHERE token=$1', [token]);
    if (!cR.rows.length) return res.json({ found: false, message: 'Coupon not recognized' });
    const regId = cR.rows[0].reg_id;
    const regR = await pool.query('SELECT flat, contact, phase, phone FROM registrations WHERE reg_id=$1', [regId]);
    const phone = regR.rows[0] ? regR.rows[0].phone : cR.rows[0].phone;

    // A family may have registered more than once under the same phone number (e.g. they used
    // "book anyway" after a duplicate warning). Pull every non-rejected registration sharing
    // that phone number so group check-in covers ALL of their coupons at once, not just the
    // one registration the scanned coupon happens to belong to.
    const siblingRegsR = await pool.query(
      `SELECT reg_id, flat, contact, phase FROM registrations WHERE phone=$1 AND status != 'Rejected' ORDER BY id ASC`,
      [phone]
    );
    const regIds = siblingRegsR.rows.map(r => r.reg_id);

    let members = [];
    if (regIds.length) {
      const placeholders = regIds.map((_, i) => '$' + (i + 1)).join(',');
      const famR = await pool.query(
        `SELECT * FROM coupons WHERE reg_id IN (${placeholders}) AND active=true ORDER BY id`,
        regIds
      );
      members = famR.rows.map(c => ({
        couponId: c.coupon_id, name: c.name, type: c.type, regId: c.reg_id,
        slotNumber: c.slot_number, slotTime: c.slot_time,
        checkedIn: c.checked_in, checkedInAt: c.checked_in_at
      }));
    }

    const primary = siblingRegsR.rows[0] || regR.rows[0] || {};
    res.json({
      found: true, regId,
      flat: primary.flat || '',
      contact: primary.contact || '',
      phase: primary.phase || '',
      regCount: regIds.length,
      members
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ found: false, message: 'Server error: ' + err.message });
  }
});

app.post('/api/scan/checkin-batch', async (req, res) => {
  const { couponIds, pin } = req.body || {};
  if (!checkPin(pin, 'scan')) return res.json({ success: false, status: 'bad_pin', message: 'Invalid scanner PIN' });
  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN');
    for (const couponId of (couponIds || [])) {
      const r = await client.query('SELECT * FROM coupons WHERE coupon_id=$1 FOR UPDATE', [couponId]);
      if (!r.rows.length) { results.push({ couponId, ok: false, reason: 'not_found' }); continue; }
      const c = r.rows[0];
      if (!c.active) { results.push({ couponId, name: c.name, ok: false, reason: 'disabled' }); continue; }
      if (c.checked_in) { results.push({ couponId, name: c.name, ok: false, reason: 'already_used' }); continue; }
      if (!c.slot_number) { results.push({ couponId, name: c.name, ok: false, reason: 'no_slot' }); continue; }
      await client.query('UPDATE coupons SET checked_in=true, checked_in_at=now() WHERE coupon_id=$1', [couponId]);
      results.push({ couponId, name: c.name, ok: true });
    }
    await client.query('COMMIT');
    res.json({ success: true, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

// ================= SCANNER: SLOT OVERRIDE AT THE GATE =================
// For cases like a kid without a phone whose coupon was booked into a different slot by a
// parent, but who wants to join friends in the slot that's actually running right now. The
// committee can move that one coupon into the current slot at the gate (if there's room) and
// admit them immediately, instead of turning them away or breaking the schedule.
app.post('/api/scan/override-slot', async (req, res) => {
  const { token, slotNumber, pin } = req.body || {};
  if (!checkPin(pin, 'scan')) return res.json({ success: false, status: 'bad_pin', message: 'Invalid scanner PIN' });
  const client = await pool.connect();
  try {
    const slotNum = Number(slotNumber);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [slotNum]);

    const cR = await client.query('SELECT * FROM coupons WHERE token=$1 FOR UPDATE', [token]);
    if (!cR.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Coupon not recognized' });
    }
    const coupon = cR.rows[0];
    if (!coupon.active) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'This coupon has been cancelled by the committee.' });
    }

    const slotR = await client.query('SELECT * FROM slots WHERE slot_number=$1', [slotNum]);
    if (!slotR.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Invalid slot selected' });
    }
    const slot = slotR.rows[0];
    const countR = await client.query('SELECT COUNT(*)::int AS n FROM coupons WHERE slot_number=$1', [slotNum]);
    let booked = countR.rows[0].n;
    if (coupon.slot_number === slotNum) booked -= 1;
    if (booked >= slot.capacity) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Slot ' + slot.slot_number + ' (' + slot.slot_time + ') is already full - cannot move them into it.' });
    }

    await client.query(
      'UPDATE coupons SET slot_number=$1, slot_time=$2, booked_at=now(), slot_overridden=true WHERE token=$3',
      [slotNum, slot.slot_time, token]
    );
    await client.query('COMMIT');
    res.json({ success: true, slotNumber: slot.slot_number, slotTime: slot.slot_time, name: coupon.name, couponId: coupon.coupon_id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log('Aaravam Sadhya app listening on port ' + PORT));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
