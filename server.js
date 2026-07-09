const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());

const CFG = {
  adminPin: process.env.ADMIN_PIN || '1234',
  scannerPin: process.env.SCANNER_PIN || '5678',
  upiId: process.env.UPI_ID || '',
  upiName: process.env.UPI_NAME || 'Aaravam Sadhya Committee',
  adultPrice: Number(process.env.PRICE_ADULT || 450),
  kidPrice: Number(process.env.PRICE_KID || 250)
};

function checkPin(pin, which) {
  const expected = which === 'scan' ? CFG.scannerPin : CFG.adminPin;
  return String(expected).trim().length > 0 && String(expected).trim() === String(pin || '').trim();
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
app.post('/api/register', async (req, res) => {
  try {
    const body = req.body || {};
    const contact = (body.contact || '').trim();
    const flat = (body.flat || '').trim();
    const phone = normalizePhone(body.phone);
    const adults = (body.adults || []).map(n => (n || '').trim()).filter(Boolean);
    const kids = (body.kids || []).map(n => (n || '').trim()).filter(Boolean);
    const txnRef = (body.txnRef || '').trim();

    if (!contact) return res.json({ success: false, message: 'Please enter your name' });
    if (!flat) return res.json({ success: false, message: 'Please enter your flat number' });
    if (phone.length < 12) return res.json({ success: false, message: 'Please enter a valid 10-digit phone number' });
    if (adults.length === 0 && kids.length === 0) return res.json({ success: false, message: 'Please add at least one adult or kid' });

    const total = adults.length * CFG.adultPrice + kids.length * CFG.kidPrice;
    const id = await nextSeq('registrations_id_seq');
    const regId = 'REG-' + pad3(id);

    await pool.query(
      `INSERT INTO registrations (id, reg_id, flat, contact, phone, adult_names, kid_names, adult_count, kid_count, total, txn_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Pending')`,
      [id, regId, flat, contact, phone, JSON.stringify(adults), JSON.stringify(kids), adults.length, kids.length, total, txnRef]
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
    const r = await pool.query(
      'SELECT * FROM registrations WHERE phone = $1 ORDER BY id DESC LIMIT 1',
      [phone]
    );
    if (!r.rows.length) return res.json({ found: false });
    const reg = r.rows[0];
    const result = {
      found: true, regId: reg.reg_id, status: reg.status,
      total: reg.total, adultCount: reg.adult_count, kidCount: reg.kid_count
    };
    if (reg.status === 'Confirmed') {
      result.coupons = await getCouponsForReg(reg.reg_id, baseUrl(req));
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ found: false, message: 'Server error: ' + err.message });
  }
});

async function getCouponsForReg(regId, base) {
  const r = await pool.query('SELECT * FROM coupons WHERE reg_id = $1 ORDER BY id', [regId]);
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
    const r = await pool.query('SELECT * FROM registrations ORDER BY id DESC');
    const registrations = r.rows.map(row => ({
      regId: row.reg_id, flat: row.flat, contact: row.contact, phone: row.phone,
      adults: row.adult_names, kids: row.kid_names,
      total: row.total, txnRef: row.txn_ref, status: row.status,
      submittedAt: row.submitted_at
    }));
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
    const { regId, confirmedBy } = req.body || {};
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
    let msg = 'Happy Onam ' + reg.contact + '! Your Aaravam Sadhya coupons for 5th Sept (DSR White Waters) are ready:\n\n';
    coupons.forEach(c => { msg += c.name + ' (' + c.type + '): ' + c.url + '\n'; });
    msg += '\nOpen each link to view your coupon and pick your entry slot on the morning of 5th Sept.';
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
    let msg = 'Good morning! It\'s Aaravam Sadhya day (DSR White Waters). Please pick your entry slot now:\n\n';
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
      slotNumber: c.slot_number, slotTime: c.slot_time, checkedIn: c.checked_in
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

app.get('/api/admin/dashboard', async (req, res) => {
  if (!checkPin(req.query.pin, 'admin')) return res.json({ success: false, message: 'Invalid admin PIN' });
  try {
    const slots = await getSlots();
    const coupCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons');
    const bookedCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons WHERE slot_number IS NOT NULL');
    const checkedInCount = await pool.query('SELECT COUNT(*)::int AS n FROM coupons WHERE checked_in = true');
    const pendingCount = await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE status = 'Pending'");
    const confirmedCount = await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE status = 'Confirmed'");
    res.json({
      success: true, slots,
      issued: coupCount.rows[0].n, booked: bookedCount.rows[0].n, checkedIn: checkedInCount.rows[0].n,
      pendingRegs: pendingCount.rows[0].n, confirmedRegs: confirmedCount.rows[0].n
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ================= EXPORT (Excel report) =================
function regRow(r) {
  return {
    reg_id: r.reg_id, flat: r.flat, contact: r.contact, phone: r.phone,
    adults: (r.adult_names || []).join(', '), kids: (r.kid_names || []).join(', '),
    adult_count: r.adult_count, kid_count: r.kid_count, total: r.total,
    txn_ref: r.txn_ref || '', status: r.status,
    submitted_at: r.submitted_at ? new Date(r.submitted_at).toLocaleString('en-IN') : '',
    confirmed_by: r.confirmed_by || '',
    confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toLocaleString('en-IN') : ''
  };
}

const REG_COLUMNS = [
  { header: 'Reg ID', key: 'reg_id', width: 12 },
  { header: 'Flat', key: 'flat', width: 12 },
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

    const totalAdults = regs.rows.reduce((s, r) => s + (r.adult_count || 0), 0);
    const totalKids = regs.rows.reduce((s, r) => s + (r.kid_count || 0), 0);
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
    pendingRows.forEach(r => wsPending.addRow(regRow(r)));
    wsPending.getRow(1).font = { bold: true };
    wsPending.autoFilter = { from: 'A1', to: 'N1' };

    // -------- Confirmed Registrations --------
    const wsConfirmed = wb.addWorksheet('Confirmed Registrations');
    wsConfirmed.columns = REG_COLUMNS;
    confirmedRows.forEach(r => wsConfirmed.addRow(regRow(r)));
    wsConfirmed.getRow(1).font = { bold: true };
    wsConfirmed.autoFilter = { from: 'A1', to: 'N1' };

    // -------- Coupon Details (one row per person) --------
    const wsCoupons = wb.addWorksheet('Coupon Details');
    wsCoupons.columns = [
      { header: 'Coupon ID', key: 'coupon_id', width: 12 },
      { header: 'Reg ID', key: 'reg_id', width: 12 },
      { header: 'Flat', key: 'flat', width: 12 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Phone', key: 'phone', width: 15 },
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
        slot_number: c.slot_number || '', slot_time: c.slot_time || '',
        checked_in: c.checked_in ? 'Yes' : 'No',
        checked_in_at: c.checked_in_at ? new Date(c.checked_in_at).toLocaleString('en-IN') : '',
        generated_at: c.generated_at ? new Date(c.generated_at).toLocaleString('en-IN') : ''
      });
    });
    wsCoupons.getRow(1).font = { bold: true };
    wsCoupons.autoFilter = { from: 'A1', to: 'K1' };

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
      checkedIn: c.checked_in, checkedInTime: c.checked_in_at
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

const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log('Aaravam Sadhya app listening on port ' + PORT));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
