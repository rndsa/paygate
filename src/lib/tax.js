/**
 * Pajak / potongan yang bisa diatur sendiri oleh pengguna.
 *
 * Bentuk:
 *   mode 'percent' -> tax_value = basis poin (11% = 1100, 2,5% = 250)
 *   mode 'fixed'   -> tax_value = rupiah
 *
 * Arah:
 *   'deduct' -> dipotong dari nominal (uang yang masuk lebih kecil)
 *   'add'    -> ditambahkan di atas nominal (uang yang masuk lebih besar)
 *   'info'   -> cuma dicatat, nominal yang masuk tetap utuh
 */
export const TAX_MODES = ["percent", "fixed"];
export const TAX_DIRECTIONS = ["deduct", "add", "info"];

export const DEFAULT_TAX = Object.freeze({
  enabled: false,
  mode: "percent",
  value: 0,
  direction: "info",
});

const KEYS = {
  enabled: "tax.enabled",
  mode: "tax.mode",
  value: "tax.value",
  direction: "tax.direction",
};

export function getTaxSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'tax.%'").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const mode = TAX_MODES.includes(map[KEYS.mode]) ? map[KEYS.mode] : DEFAULT_TAX.mode;
  const direction = TAX_DIRECTIONS.includes(map[KEYS.direction]) ? map[KEYS.direction] : DEFAULT_TAX.direction;
  const raw = Number(map[KEYS.value]);
  const value = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  return {
    enabled: map[KEYS.enabled] === "1",
    mode,
    value,
    direction,
  };
}

/** Simpan sebagian pengaturan; nilai tak valid diabaikan, bukan ditulis asal. */
export function saveTaxSettings(db, patch, now = Date.now()) {
  const current = getTaxSettings(db);
  const next = { ...current };

  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (TAX_MODES.includes(patch.mode)) next.mode = patch.mode;
  if (TAX_DIRECTIONS.includes(patch.direction)) next.direction = patch.direction;
  if (Number.isSafeInteger(patch.value) && patch.value >= 0) next.value = patch.value;

  // Batas wajar: persen maksimal 100%, nominal maksimal Rp1 miliar.
  if (next.mode === "percent") next.value = Math.min(next.value, 10000);
  else next.value = Math.min(next.value, 1_000_000_000);

  const stmt = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  db.exec("BEGIN IMMEDIATE");
  try {
    stmt.run(KEYS.enabled, next.enabled ? "1" : "0");
    stmt.run(KEYS.mode, next.mode);
    stmt.run(KEYS.value, String(next.value));
    stmt.run(KEYS.direction, next.direction);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  void now;
  return next;
}

/** Hitung pajak + nominal bersih dari sebuah nominal bruto. */
export function computeTax(gross, settings = DEFAULT_TAX) {
  const grossAmount = Math.max(0, Math.round(Number(gross) || 0));
  if (!settings.enabled || grossAmount <= 0 || settings.value <= 0) {
    return { taxAmount: 0, netAmount: grossAmount, direction: "info" };
  }
  const taxAmount =
    settings.mode === "percent"
      ? Math.round((grossAmount * settings.value) / 10000)
      : settings.value;

  let netAmount = grossAmount;
  if (settings.direction === "deduct") netAmount = Math.max(0, grossAmount - taxAmount);
  else if (settings.direction === "add") netAmount = grossAmount + taxAmount;

  return { taxAmount, netAmount, direction: settings.direction };
}

/** Label angka pajak untuk ditampilkan (mis. "11%" atau "Rp2.500"). */
export function formatTaxValue(mode, value) {
  if (mode === "percent") {
    const pct = value / 100;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(".", ",")}%`;
  }
  return "Rp" + Number(value || 0).toLocaleString("id-ID");
}
