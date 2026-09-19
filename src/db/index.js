import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

export const db = new DatabaseSync(config.dbPath);

// Pragmas for safety & performance
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  prefix     TEXT NOT NULL,
  last_used  INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS payment_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,               -- 'shopeepay' | 'gopay'
  label       TEXT NOT NULL,
  credential  TEXT NOT NULL,               -- encrypted blob JSON (token/session)
  status      TEXT NOT NULL DEFAULT 'active', -- active | error
  last_error  TEXT,
  last_validated_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(user_id, provider)                 -- HANYA 1 akun per provider per user (no mass add)
);
CREATE INDEX IF NOT EXISTS idx_pa_user ON payment_accounts(user_id);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,           -- order id unik (mis. ORD-xxxx)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  account_id    INTEGER REFERENCES payment_accounts(id) ON DELETE SET NULL,
  amount        INTEGER NOT NULL,           -- dalam rupiah
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | failed
  qris_payload  TEXT,                       -- dynamic qris string
  qris_image    TEXT,                       -- data-url PNG
  claimed_txid  TEXT,
  claimed_at    INTEGER,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_claimed ON orders(claimed_txid);

CREATE TABLE IF NOT EXISTS seen_transactions (
  provider    TEXT NOT NULL,
  txid        TEXT NOT NULL,
  account_id  INTEGER,
  amount      INTEGER NOT NULL,
  tx_time     INTEGER,
  seen_at     INTEGER NOT NULL,
  consumed_by TEXT REFERENCES orders(id),
  PRIMARY KEY (provider, txid)
);
CREATE INDEX IF NOT EXISTS idx_seen_tx_consumed ON seen_transactions(consumed_by);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Catatan pemasukan: satu baris setiap QRIS berhasil dibayar.
-- Pajak disimpan per-baris supaya riwayat lama tidak berubah saat
-- pengaturan pajak diganti.
CREATE TABLE IF NOT EXISTS income (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL,
  gross_amount  INTEGER NOT NULL,            -- nominal yang dibayar customer
  tax_enabled   INTEGER NOT NULL DEFAULT 0,  -- 1 = dengan pajak, 0 = tanpa pajak
  tax_mode      TEXT,                        -- 'percent' | 'fixed'
  tax_value     INTEGER,                     -- percent: basis points (11% = 1100); fixed: rupiah
  tax_direction TEXT,                        -- 'deduct' | 'add' | 'info'
  tax_amount    INTEGER NOT NULL DEFAULT 0,  -- nilai pajak hasil hitung
  net_amount    INTEGER NOT NULL,            -- yang benar-benar masuk
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_income_user ON income(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_income_order ON income(order_id);
`);

// Additive, restart-safe migration; existing history and credentials remain intact.
if (!db.prepare('PRAGMA table_info(payment_accounts)').all().some(c => c.name === 'next_poll_at')) {
  db.exec('ALTER TABLE payment_accounts ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0');
}

if (!db.prepare('PRAGMA table_info(payment_accounts)').all().some(c => c.name === 'credential_source')) {
  db.exec("ALTER TABLE payment_accounts ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'env'");
}
if (!db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'payment_origin')) {
  db.exec("ALTER TABLE orders ADD COLUMN payment_origin TEXT NOT NULL DEFAULT 'legacy_unverified'");
}
// Persistent owner/provider budget: reconnect/restart cannot bypass OTP cooldown.
db.exec(`CREATE TABLE IF NOT EXISTS merchant_login_limits (
  user_id INTEGER NOT NULL REFERENCES users(id), provider TEXT NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0, window_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, device_id TEXT NOT NULL,
  PRIMARY KEY(user_id,provider)
)`);

// Additive Console history only: never alter existing credentials or login budgets.
// Deliberately no ON DELETE SET NULL: private events must never become system events.
db.exec(`
CREATE TABLE IF NOT EXISTS console_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  module TEXT NOT NULL,
  event TEXT NOT NULL,
  summary TEXT NOT NULL,
  code TEXT,
  request_id TEXT,
  stage TEXT,
  http_status INTEGER,
  provider_status INTEGER,
  duration_ms INTEGER,
  upstream_code TEXT,
  upstream_request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_console_owner_id ON console_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_console_created ON console_events(created_at);
`);

export const dbNow = () => Date.now();
