/**
 * Catatan pemasukan (buku kas masuk).
 * Satu baris dibuat setiap pembayaran QRIS berhasil diklaim.
 */
import { getTaxSettings, computeTax } from "./tax.js";

/**
 * Catat pemasukan dari sebuah order yang berhasil dibayar.
 * Idempoten: order_id yang sama tidak akan tercatat dua kali.
 * Mengembalikan baris income yang dibuat, atau null kalau sudah ada.
 */
export function recordIncome(db, { orderId, userId, provider, grossAmount, note = null, now = Date.now() }) {
  if (db.prepare("SELECT 1 FROM income WHERE order_id = ?").get(orderId)) return null;

  const tax = getTaxSettings(db);
  const { taxAmount, netAmount, direction } = computeTax(grossAmount, tax);

  db.prepare(
    `INSERT INTO income
       (user_id, order_id, provider, gross_amount, tax_enabled, tax_mode, tax_value, tax_direction, tax_amount, net_amount, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    userId,
    orderId,
    provider,
    Math.round(grossAmount),
    tax.enabled ? 1 : 0,
    tax.enabled ? tax.mode : null,
    tax.enabled ? tax.value : null,
    tax.enabled ? direction : null,
    taxAmount,
    netAmount,
    note,
    now
  );

  return { taxAmount, netAmount, taxEnabled: tax.enabled, taxMode: tax.mode, taxValue: tax.value, direction };
}
