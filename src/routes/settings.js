import { auditAction } from "../middleware/console-audit.js";
import { Router } from "express";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { asyncRoute } from "../lib/async.js";
import { verifyPassword } from "../lib/crypto.js";
import { cleanString } from "../lib/validate.js";
import { generateSecret, verifyCode, buildUri } from "../lib/totp.js";
import { getTaxSettings, saveTaxSettings, TAX_MODES, TAX_DIRECTIONS } from "../lib/tax.js";
import QRCode from "qrcode";

const router = Router();
router.use((req, res, next) => auditAction(req.method === 'POST' ? 'SETTINGS_UPDATE' : null)(req, res, next));
// Runtime settings are read-only until a scoped, effective settings layer exists.
router.get("/", (req, res) => res.json({
  read_only: true,
  lab_enabled: config.labUnofficialEnabled,
  poll_interval_ms: config.labPollIntervalMs,
  payment_tolerance: 0,
  order_ttl_minutes: config.orderTtlMinutes,
}));
router.post("/", (req, res) => res.status(503).json({ error: "Pengaturan runtime read-only; perubahan lewat konfigurasi server." }));

// ---------- Pajak (bisa diatur sendiri) ----------
router.get("/tax", (req, res) => {
  res.json({ ...getTaxSettings(db), modes: TAX_MODES, directions: TAX_DIRECTIONS });
});

router.post("/tax", auditAction("TAX_UPDATE"), (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.mode === "string") patch.mode = body.mode;
  if (typeof body.direction === "string") patch.direction = body.direction;
  const rawValue = Number(body.value);
  if (!Number.isFinite(rawValue) || rawValue < 0) {
    return res.status(422).json({ error: "Angka pajak harus 0 atau lebih." });
  }
  patch.value = Math.round(rawValue);
  if (patch.mode && !TAX_MODES.includes(patch.mode)) {
    return res.status(422).json({ error: "Jenis pajak tidak dikenal." });
  }
  if (patch.direction && !TAX_DIRECTIONS.includes(patch.direction)) {
    return res.status(422).json({ error: "Cara hitung pajak tidak dikenal." });
  }
  if (patch.enabled === true && patch.value <= 0) {
    return res.status(422).json({ error: "Isi angka pajak lebih dulu, lalu simpan." });
  }
  const saved = saveTaxSettings(db, patch);
  res.json({ ok: true, ...saved });
});

// ---------- Two-factor (TOTP) ----------
router.get("/2fa", (req, res) => {
  const row = db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(req.user.id);
  res.json({ enabled: !!row?.totp_enabled });
});

// Generate a fresh secret. Not active until a valid code is confirmed.
router.post("/2fa/setup", asyncRoute(async (req, res) => {
  const secret = generateSecret();
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?")
    .run(secret, Date.now(), req.user.id);
  const uri = buildUri(secret, req.user.username);
  const qr = await QRCode.toDataURL(uri, { width: 200, margin: 1 });
  res.json({ secret, uri, qr });
}));

router.post("/2fa/enable", asyncRoute(async (req, res) => {
  const code = cleanString(req.body?.code, 8);
  const row = db.prepare("SELECT username, totp_secret FROM users WHERE id = ?").get(req.user.id);
  if (!row?.totp_secret) return res.status(409).json({ error: "Belum ada kode 2FA. Mulai pengaturan terlebih dahulu." });
  if (!verifyCode(row.totp_secret, row.username, code).valid) {
    return res.status(401).json({ error: "Kode 2FA salah atau sudah kedaluwarsa." });
  }
  db.prepare("UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?").run(Date.now(), req.user.id);
  res.json({ ok: true, enabled: true });
}));

router.post("/2fa/disable", asyncRoute(async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return res.status(401).json({ error: "Password salah." });
  }
  db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?").run(Date.now(), req.user.id);
  res.json({ ok: true, enabled: false });
}));

export default router;
