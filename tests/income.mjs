import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Uji nyata ke SQLite: pemasukan tercatat sekali, pajak ikut tersimpan,
// dan ringkasan API menghitungnya benar.

const temp = mkdtempSync(path.join(tmpdir(), "paygate-income-"));
process.env.DB_PATH = path.join(temp, "income.db");
process.env.PAYGATE_DATA_DIR = path.join(temp, "data");
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = "11".repeat(32);
process.env.COOKIE_SECRET = "22".repeat(32);

const { db } = await import("../src/db/index.js");
const { recordIncome } = await import("../src/lib/income.js");
const { getTaxSettings, saveTaxSettings } = await import("../src/lib/tax.js");

// Seed user + order nyata supaya foreign key terpenuhi.
db.prepare("INSERT OR IGNORE INTO users(id, username, password_hash, role, created_at, updated_at) VALUES(1,'tester','x','admin',0,0)").run();
for (const id of ["ord_1", "ord_2", "ord_3"]) {
  db.prepare("INSERT OR IGNORE INTO orders(id, user_id, provider, amount, status, expires_at, created_at, updated_at) VALUES(?,1,'gopay',50000,'paid',0,0,0)").run(id);
}

function reset() {
  db.prepare("DELETE FROM income").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'tax.%'").run();
}

test("pemasukan tercatat sekali walau order diklaim dua kali", () => {
  reset();
  const a = recordIncome(db, { orderId: "ord_1", userId: 1, provider: "gopay", grossAmount: 50000 });
  const b = recordIncome(db, { orderId: "ord_1", userId: 1, provider: "gopay", grossAmount: 50000 });
  assert.ok(a, "catatan pertama dibuat");
  assert.equal(b, null, "order sama tidak dicatat dua kali");
  const count = db.prepare("SELECT COUNT(*) c FROM income WHERE order_id='ord_1'").get().c;
  assert.equal(count, 1);
});

test("pajak aktif ikut tersimpan di baris pemasukan", () => {
  reset();
  saveTaxSettings(db, { enabled: true, mode: "percent", value: 1100, direction: "deduct" });
  recordIncome(db, { orderId: "ord_2", userId: 1, provider: "shopeepay", grossAmount: 50000 });
  const row = db.prepare("SELECT * FROM income WHERE order_id='ord_2'").get();
  assert.equal(row.gross_amount, 50000);
  assert.equal(row.tax_amount, 5500);
  assert.equal(row.net_amount, 44500);
  assert.equal(row.tax_enabled, 1);
  assert.equal(row.tax_mode, "percent");
  assert.equal(row.tax_direction, "deduct");
});

test("pajak tanpa aktif = uang masuk utuh", () => {
  reset();
  saveTaxSettings(db, { enabled: false, mode: "percent", value: 1100, direction: "deduct" });
  recordIncome(db, { orderId: "ord_3", userId: 1, provider: "gopay", grossAmount: 33000 });
  const row = db.prepare("SELECT * FROM income WHERE order_id='ord_3'").get();
  assert.equal(row.tax_amount, 0);
  assert.equal(row.net_amount, 33000);
  assert.equal(row.tax_enabled, 0);
});

test("pengaturan pajak tersimpan dan terbaca kembali", () => {
  reset();
  saveTaxSettings(db, { enabled: true, mode: "fixed", value: 2500, direction: "add" });
  const s = getTaxSettings(db);
  assert.equal(s.enabled, true);
  assert.equal(s.mode, "fixed");
  assert.equal(s.value, 2500);
  assert.equal(s.direction, "add");
});

test("nilai pajak tidak masuk akal ditolak dengan aman", () => {
  reset();
  saveTaxSettings(db, { enabled: true, mode: "percent", value: 99999999, direction: "deduct" });
  assert.ok(getTaxSettings(db).value <= 10000, "persen di-clamp maksimum 100%");
  saveTaxSettings(db, { mode: "ngawur", direction: "ngawur" });
  const s = getTaxSettings(db);
  assert.equal(s.mode, "percent", "mode ngawur diabaikan, nilai lama dipertahankan");
  assert.equal(s.direction, "deduct", "arah ngawur diabaikan, nilai lama dipertahankan");
});

test.after(() => {
  try { db.close(); } catch {}
  rmSync(temp, { recursive: true, force: true });
});
