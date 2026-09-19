import { auditAction } from "../middleware/console-audit.js";
import { Router } from "express";
import crypto from "node:crypto";
import { asyncRoute } from "../lib/async.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { getEncryptionKey } from "../config.js";
import { qrisImageDataUrl, staticToDynamicQris } from "../lib/qris.js";
import { allocateUniqueAmount, collectTakenAmounts } from "../lib/amount-allocator.js";
import { isAmount, cleanString, isOrderId, isProvider } from "../lib/validate.js";
import { requireAuth, optionalApiKeyAuth } from "../middleware/security.js";
import { getLabAccount } from "../services/lab.js";

const router = Router();
router.use((req,res,next) => auditAction(req.method === 'POST' ? (req.path === '/' ? 'ORDER_CREATE' : /^\/[^/]+\/check$/.test(req.path) ? 'ORDER_CHECK' : null) : null)(req,res,next));

// ---------- Generate Order ID ----------
function generateOrderId() {
  const suffix = crypto.randomBytes(6).toString("hex"); // 12 hex chars
  return `ORD-${Date.now().toString(36).toUpperCase().slice(-4)}-${suffix.toUpperCase()}`;
}

// ---------- Create order (api-key protected) ----------
router.post("/create", optionalApiKeyAuth, requireAuth, asyncRoute(async (req, res) => {
  const description = cleanString(req.body?.description || "", 200);
  const providerName = req.body?.provider;
  const autoAllocate = req.body?.auto_allocate === true || req.body?.amount == null;
  const baseRaw = req.body?.base_amount ?? req.body?.amount;

  if (!isProvider(providerName)) return res.status(422).json({ error: "Metode pembayaran tidak dikenal." });
  // Amount validation must come before the LAB gate so callers get a 422 for
  // malformed payloads even when the unofficial provider surface is disabled.
  if (autoAllocate) {
    if (!isAmount(baseRaw)) return res.status(422).json({ error: "Nominal harus angka positif (IDR)." });
  } else if (!isAmount(baseRaw)) {
    return res.status(422).json({ error: "Nominal harus angka positif (IDR)." });
  }
  if (!config.labUnofficialEnabled || req.user.id !== config.labUserId) return res.status(503).json({ error: "Metode pembayaran ini belum tersedia untuk akun Anda." });

  const orderId = generateOrderId();
  const account = getLabAccount(providerName, req.user.id);
  if (!account || account.status !== 'active' || !account.last_validated_at) return res.status(503).json({ error: 'Akun pembayaran belum siap. Buka halaman Akun lalu selesaikan pemeriksaan koneksi.' });
  let qrisPayload;
  let amount;
  try {
    const credential = JSON.parse(decrypt(account.credential, getEncryptionKey()) || 'null');
    if (autoAllocate) {
      const baseAmount = Math.round(Number(baseRaw));
      const taken = collectTakenAmounts(db, { provider: providerName, accountId: account.id, now: Date.now() });
      const { uniqueAmount } = allocateUniqueAmount(baseAmount, taken);
      amount = uniqueAmount;
    } else {
      amount = Math.round(Number(baseRaw));
    }
    if (amount > 100000) return res.status(422).json({ error: 'Maksimal Rp100.000 per order.' });
    qrisPayload = staticToDynamicQris(credential.qris_static, amount);
  } catch (e) {
    if (e?.code === 'AMOUNT_POOL_EXHAUSTED') return res.status(503).json({ error: e.message, code: e.code });
    return res.status(503).json({ error: 'QRIS merchant tidak terbaca. Periksa ulang di halaman Akun.' });
  }
  const qrisImage = await qrisImageDataUrl(qrisPayload);
  // No await inside transaction: account state rechecked after asynchronous QR rendering.
  const now = Date.now(), ttlEnd = now + config.orderTtlMinutes * 60000;
  // Coarse feed timestamps must not accept payments from the fraction after expiry.
  const expiresAt = Math.floor(ttlEnd / 1000) * 1000;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getLabAccount(providerName, req.user.id);
    if (!current || current.status !== 'active' || current.updated_at !== account.updated_at || current.credential !== account.credential) {
      db.exec('ROLLBACK'); return res.status(503).json({ error: 'Akun berubah/dijeda; order tidak dibuat.' });
    }
    // ponytail: no amount reuse in this lab DB. Old locally-built QR cannot be revoked upstream.
    if (db.prepare('SELECT 1 FROM orders WHERE provider=? AND amount=? LIMIT 1').get(providerName, amount)) {
      db.exec('ROLLBACK'); return res.status(409).json({ error: 'Nominal pernah dipakai provider ini. Gunakan nominal unik; QR lama tidak bisa dicabut.' });
    }
    db.prepare(`INSERT INTO orders(id,user_id,provider,payment_origin,account_id,amount,description,status,qris_payload,qris_image,expires_at,created_at,updated_at) VALUES(?,?,?,'live',?,?,?,'pending',?,?,?,?,?)`)
      .run(orderId, req.user.id, providerName, account.id, amount, description, qrisPayload, qrisImage, expiresAt, now, now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  res.status(201).json({ order_id: orderId, provider: providerName, payment_origin: 'live', lab_unofficial: true, amount, expires_at: expiresAt, qris_payload: qrisPayload, qris_image: qrisImage, status: 'pending' });
}));

// ---------- Check payment status (api-key or session) ----------
router.get("/:id/status", optionalApiKeyAuth, (req, res) => {
  if (!req.user && !req.apiKey) return res.status(401).json({ error: "Auth required." });
  const oid = cleanString(req.params.id || "", 30);
  if (!isOrderId(oid)) return res.status(400).json({ error: "Order ID invalid." });

  const userId = req.user?.id || req.apiKey?.user_id;
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(oid, userId);
  if (!order) return res.status(404).json({ error: "Order tidak ditemukan." });

  const live = order.payment_origin === "live" && isProvider(order.provider);
  const expired = live && order.expires_at <= Date.now() && order.status === "pending";
  if (expired) {
    db.prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), order.id);
    order.status = "expired";
  }

  // QR only ever leaves the server while the tagihan can still be paid. Once it is
  // paid or expired the payload is dead weight: stop shipping it, so a stale client
  // or a cached response can never be reused to settle the same tagihan twice.
  const payable = live && order.status === "pending" && order.expires_at > Date.now();

  res.json({
    order_id: order.id,
    provider: order.provider,
    payment_origin: order.payment_origin,
    lab_unofficial: live,
    claimed_txid: order.claimed_txid,
    amount: order.amount,
    status: order.status,
    claimed: !!order.claimed_txid,
    created_at: order.created_at,
    expires_at: order.expires_at,
    qris_payload: payable ? order.qris_payload : null,
    qris_image: payable ? order.qris_image : null,
  });
});

// ---------- List recent pending orders ----------
router.get("/", optionalApiKeyAuth, (req, res) => {
  if (!req.user && !req.apiKey) return res.status(401).json({ error: "Auth required." });
  const userId = req.user?.id || req.apiKey?.user_id;

  const rows = db
    .prepare("SELECT id, provider, payment_origin, amount, description, status, claimed_txid, claimed_at, created_at, expires_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(userId);
  res.json({ orders: rows.map(order => ({ ...order, lab_unofficial: order.payment_origin === "live" && isProvider(order.provider) })) });
});

export default router;