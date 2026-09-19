import { Router } from "express";
import { db } from "../db/index.js";
import { auditAction } from "../middleware/console-audit.js";
import { cleanString } from "../lib/validate.js";
import { computeTax, getTaxSettings, formatTaxValue } from "../lib/tax.js";

const router = Router();

function serialize(row) {
  const saved = {
    enabled: !!row.tax_enabled,
    mode: row.tax_mode || "percent",
    value: row.tax_value || 0,
    direction: row.tax_direction || "info",
  };
  return {
    id: row.id,
    order_id: row.order_id,
    provider: row.provider,
    gross_amount: row.gross_amount,
    net_amount: row.net_amount,
    tax_amount: row.tax_amount,
    tax_enabled: !!row.tax_enabled,
    tax_label: row.tax_enabled ? formatTaxValue(saved.mode, saved.value) : null,
    tax_direction: row.tax_direction,
    note: row.note,
    created_at: row.created_at,
    created_at_label: new Date(row.created_at).toLocaleString("id-ID"),
  };
}

// Daftar pemasukan + ringkasan angka.
router.get("/", (req, res) => {
  const uid = req.user.id;
  const rows = db
    .prepare("SELECT * FROM income WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(uid);
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(gross_amount),0) AS gross,
         COALESCE(SUM(net_amount),0)  AS net,
         COALESCE(SUM(tax_amount),0)  AS tax,
         COUNT(*)                     AS count
       FROM income WHERE user_id = ?`
    )
    .get(uid);
  const withTax = db
    .prepare("SELECT COUNT(*) c FROM income WHERE user_id = ? AND tax_enabled = 1")
    .get(uid).c;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = db
    .prepare("SELECT COALESCE(SUM(net_amount),0) AS net FROM income WHERE user_id = ? AND created_at >= ?")
    .get(uid, startOfDay.getTime()).net;
  res.json({
    income: rows.map(serialize),
    totals: {
      gross: totals.gross,
      net: totals.net,
      tax: totals.tax,
      count: totals.count,
      with_tax: withTax,
      without_tax: totals.count - withTax,
      today,
    },
    tax: getTaxSettings(db),
  });
});

// Ubah penanda pajak pada satu catatan pemasukan (mis. order lama).
router.post("/:id/tax", auditAction("INCOME_TAX_TOGGLE"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Catatan tidak valid." });
  const row = db.prepare("SELECT * FROM income WHERE id = ? AND user_id = ?").get(id, req.user.id);
  if (!row) return res.status(404).json({ error: "Catatan pemasukan tidak ditemukan." });

  const useTax = req.body?.tax_enabled === true;
  const gross = row.gross_amount;
  let taxAmount = 0, netAmount = gross, mode = null, value = null, direction = null;
  if (useTax) {
    const settings = getTaxSettings(db);
    const result = computeTax(gross, { ...settings, enabled: true });
    taxAmount = result.taxAmount;
    netAmount = result.netAmount;
    mode = settings.mode;
    value = settings.value;
    direction = settings.direction;
  }
  db.prepare(
    "UPDATE income SET tax_enabled=?, tax_mode=?, tax_value=?, tax_direction=?, tax_amount=?, net_amount=? WHERE id=? AND user_id=?"
  ).run(useTax ? 1 : 0, mode, value, direction, taxAmount, netAmount, id, req.user.id);
  const updated = db.prepare("SELECT * FROM income WHERE id = ?").get(id);
  res.json({ ok: true, income: serialize(updated) });
});

export default router;
void cleanString;
