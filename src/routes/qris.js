import { auditAction } from "../middleware/console-audit.js";
import { Router } from "express";
import { config } from "../config.js";
import { asyncRoute } from "../lib/async.js";
import { cleanString } from "../lib/validate.js";
import { hasTerms } from "./terms.js";
import { analyzeQris } from "../lib/qris-analyzer.js";
import { isValidQris, staticToDynamicQris, qrisImageDataUrl } from "../lib/qris.js";

const router = Router();

router.use((req, res, next) =>
  auditAction(
    req.method === "POST"
      ? { "/analyze": "QRIS_ANALYZE", "/test-render": "QRIS_TEST_RENDER" }[req.path]
      : null
  )(req, res, next)
);

function parsePayload(req) {
  const raw = cleanString(req.body?.payload || "", 4096);
  if (!raw) {
    const e = new Error("Payload QRIS kosong.");
    e.code = "INVALID";
    throw e;
  }
  return raw;
}

// POST /api/qris/analyze — read-only analysis (no provider HTTP). Available to any logged-in user.
router.post(
  "/analyze",
  asyncRoute(async (req, res) => {
    let payload;
    try {
      payload = parsePayload(req);
    } catch (e) {
      return res.status(422).json({ error: e.message, code: e.code || "INVALID" });
    }
    const info = analyzeQris(payload);
    res.json({
      valid: info.valid,
      type: info.type,
      merchant_name: info.merchantName,
      city: info.city,
      postal: info.postal,
      currency: info.currency,
      country: info.country,
      merchant_category: info.merchantCategory,
      has_amount: info.hasAmount,
      amount: info.amount,
      pan_masked: info.panMasked,
      crc_valid: info.crcValid,
      errors: info.errors,
    });
  })
);

// POST /api/qris/test-render — LAB owner only. Renders a dynamic QR from a static
// payload so the user can preview a payable QR before saving. Does NOT persist
// anything. Requires terms consent + explicit confirmation.
router.post(
  "/test-render",
  asyncRoute(async (req, res) => {
    if (!hasTerms(req)) {
      return res.status(403).json({ error: "Baca dan setujui Syarat Penggunaan terlebih dahulu.", code: "TERMS_REQUIRED" });
    }
    if (!config.labUnofficialEnabled || req.user.id !== config.labUserId) {
      return res.status(503).json({ error: "Test render hanya untuk pemilik LAB.", code: "UNCONFIGURED" });
    }
    if (req.body?.consent !== true) {
      return res.status(422).json({ error: "Konfirmasi test render (consent=true).", code: "TERMS_REQUIRED" });
    }
    const amountRaw = req.body?.amount;
    const amount = Number(amountRaw);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) {
      return res.status(422).json({ error: "Nominal harus bilangan bulat 1–100.000 (IDR).", code: "INVALID" });
    }
    let payload;
    try {
      payload = parsePayload(req);
    } catch (e) {
      return res.status(422).json({ error: e.message, code: e.code || "INVALID" });
    }
    if (!isValidQris(payload)) {
      return res.status(422).json({ error: "QRIS rusak: TLV atau CRC tidak valid.", code: "INVALID" });
    }
    const info = analyzeQris(payload);
    if (info.type !== "static") {
      return res.status(422).json({ error: "Test render hanya untuk QRIS statis.", code: "INVALID" });
    }
    try {
      const dynamic = staticToDynamicQris(payload, amount);
      const image = await qrisImageDataUrl(dynamic);
      res.json({
        ok: true,
        amount,
        qris_payload: dynamic,
        qris_image: image,
        preview: {
          merchant_name: info.merchantName,
          city: info.city,
          country: info.country,
          currency: info.currency,
          pan_masked: info.panMasked,
        },
      });
    } catch (e) {
      res.status(422).json({ error: "Render gagal: " + (e?.message ?? "QRIS statis tidak valid"), code: "INVALID" });
    }
  })
);

export default router;
