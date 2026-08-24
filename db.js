const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS registrations_id_seq;
CREATE TABLE IF NOT EXISTS registrations (
  id INT PRIMARY KEY DEFAULT nextval('registrations_id_seq'),
  reg_id TEXT UNIQUE NOT NULL,
  flat TEXT NOT NULL,
  contact TEXT NOT NULL,
  phone TEXT NOT NULL,
  adult_names JSONB NOT NULL DEFAULT '[]',
  kid_names JSONB NOT NULL DEFAULT '[]',
  adult_count INT NOT NULL DEFAULT 0,
  kid_count INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  txn_ref TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ
);

CREATE SEQUENCE IF NOT EXISTS coupons_id_seq;
CREATE TABLE IF NOT EXISTS coupons (
  id INT PRIMARY KEY DEFAULT nextval('coupons_id_seq'),
  coupon_id TEXT UNIQUE NOT NULL,
  token TEXT UNIQUE NOT NULL,
  reg_id TEXT NOT NULL REFERENCES registrations(reg_id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  phone TEXT,
  slot_number INT,
  slot_time TEXT,
  booked_at TIMESTAMPTZ,
  checked_in BOOLEAN NOT NULL DEFAULT false,
  checked_in_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slots (
  slot_number INT PRIMARY KEY,
  slot_time TEXT NOT NULL,
  capacity INT NOT NULL
);

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT '';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS tower TEXT NOT NULL DEFAULT '';

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS slot_overridden BOOLEAN NOT NULL DEFAULT false;

CREATE SEQUENCE IF NOT EXISTS deleted_registrations_id_seq;
CREATE TABLE IF NOT EXISTS deleted_registrations (
  id INT PRIMARY KEY DEFAULT nextval('deleted_registrations_id_seq'),
  reg_id TEXT NOT NULL,
  flat TEXT,
  phase TEXT,
  tower TEXT,
  contact TEXT,
  phone TEXT,
  adult_names JSONB NOT NULL DEFAULT '[]',
  kid_names JSONB NOT NULL DEFAULT '[]',
  coupon_ids JSONB NOT NULL DEFAULT '[]',
  was_confirmed BOOLEAN NOT NULL DEFAULT false,
  total INT NOT NULL DEFAULT 0,
  refund_amount INT NOT NULL DEFAULT 0,
  refunded BOOLEAN NOT NULL DEFAULT false,
  refunded_at TIMESTAMPTZ,
  deleted_by TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The CREATE TABLE above already includes "tower" for brand-new databases, but that has no
-- effect on a database that already had this table before tower existed - this ALTER covers
-- those already-deployed apps so the column shows up either way.
ALTER TABLE deleted_registrations ADD COLUMN IF NOT EXISTS tower TEXT;

-- Tracks whether the "Share Coupons on WhatsApp" step has actually been done for a Confirmed
-- registration, so the admin console can flag anyone still waiting instead of relying on the
-- admin to remember/spot them in a long Confirmed list.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS coupon_shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS coupon_shared_at TIMESTAMPTZ;

-- Lets the committee log complimentary coupons for artists/sponsors (settled later by the
-- treasurer) separately from real resident registrations. reg_type is 'Resident' (the normal
-- public-form flow, unchanged) or 'Sponsor' (added only via the admin console). committee_name/
-- org_name/notes are only ever populated for 'Sponsor' entries - for those, "contact"/"phone"
-- hold the committee SPOC's own name/number instead of a resident's, since that's who the
-- coupons actually get shared to.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reg_type TEXT NOT NULL DEFAULT 'Resident';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS committee_name TEXT;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS org_name TEXT;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS notes TEXT;

-- A Sponsor entry has no real flat, so flat can no longer be mandatory at the database level
-- (the public registration form still enforces it via VALID_FLATS for actual residents - this
-- only relaxes the column so the admin-only Sponsor path can leave it blank).
ALTER TABLE registrations ALTER COLUMN flat DROP NOT NULL;

-- Slot 3 & 4 start locked (no auto-unlock threshold - the committee decided a manual, judgment
-- call is safer than a fixed percentage) and only open once an admin flips this on from the new
-- Slot Management widget. Slot 1 & 2 ignore this column entirely - they're always open.
ALTER TABLE slots ADD COLUMN IF NOT EXISTS manually_unlocked BOOLEAN NOT NULL DEFAULT false;
`;

// Sized for a maximum expected turnout of ~400 people: 4 slots x 110 capacity = 440, with
// 45 minutes between each slot's start time. (Previously 5 slots, up to 3:00 PM - trimmed
// down to 4 now that the real attendance ceiling is known.)
const DEFAULT_SLOTS = [
  [1, '12:00 PM', 110],
  [2, '12:45 PM', 110],
  [3, '1:30 PM', 110],
  [4, '2:15 PM', 110]
];

async function init() {
  await pool.query(SCHEMA);
  for (const [num, time, cap] of DEFAULT_SLOTS) {
    await pool.query(
      'INSERT INTO slots (slot_number, slot_time, capacity) VALUES ($1,$2,$3) ON CONFLICT (slot_number) DO NOTHING',
      [num, time, cap]
    );
  }
  // Registration is still in testing (not yet live to residents), so there's no real slot 5
  // booking to worry about - safe to just drop any slot rows outside the current 4, in case an
  // earlier test run already seeded the old 5-slot list into this database.
  const keepNums = DEFAULT_SLOTS.map(s => s[0]);
  await pool.query('DELETE FROM slots WHERE slot_number != ALL($1::int[])', [keepNums]);
  console.log('Database schema ready.');
}

module.exports = { pool, init };
