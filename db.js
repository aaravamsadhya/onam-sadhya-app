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

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS slot_overridden BOOLEAN NOT NULL DEFAULT false;
`;

const DEFAULT_SLOTS = [
  [1, '12:00 PM', 110],
  [2, '12:45 PM', 110],
  [3, '1:30 PM', 110],
  [4, '2:15 PM', 110],
  [5, '3:00 PM', 110]
];

async function init() {
  await pool.query(SCHEMA);
  for (const [num, time, cap] of DEFAULT_SLOTS) {
    await pool.query(
      'INSERT INTO slots (slot_number, slot_time, capacity) VALUES ($1,$2,$3) ON CONFLICT (slot_number) DO NOTHING',
      [num, time, cap]
    );
  }
  console.log('Database schema ready.');
}

module.exports = { pool, init };
