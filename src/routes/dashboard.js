import { Router } from "express";
import { db } from "../db/index.js";

const router = Router();

// Ringkasan dashboard
router.get("/summary", (req, res) => {
  const uid = req.user.id;
  const now = Date.now();

  const stats = {
    orders_total: db.prepare("SELECT COUNT(*) c FROM orders WHERE payment_origin = 'live' AND provider IN ('gopay','shopeepay') AND user_id = ?").get(uid).c,
    orders_pending: db.prepare("SELECT COUNT(*) c FROM orders WHERE payment_origin = 'live' AND provider IN ('gopay','shopeepay') AND user_id = ? AND status = 'pending' AND expires_at > ?").get(uid, now).c,
    orders_paid: db.prepare("SELECT COUNT(*) c FROM orders WHERE payment_origin = 'live' AND provider IN ('gopay','shopeepay') AND user_id = ? AND status = 'paid'").get(uid).c,
    revenue_paid: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE payment_origin = 'live' AND provider IN ('gopay','shopeepay') AND user_id = ? AND status = 'paid'").get(uid).s,
    accounts: db.prepare("SELECT COUNT(*) c FROM payment_accounts WHERE user_id = ?").get(uid).c,
    api_keys: db.prepare("SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(uid).c,
  };

  const recentOrders = db
    .prepare("SELECT id, provider, payment_origin, amount, description, status, created_at, expires_at FROM orders WHERE payment_origin = 'live' AND provider IN ('gopay','shopeepay') AND user_id = ? ORDER BY created_at DESC LIMIT 8")
    .all(uid);

  res.json({
    stats,
    recentOrders: recentOrders.map((o) => ({
      ...o,
      is_expired: o.status === "pending" && o.expires_at <= now,
      created_at_label: new Date(o.created_at).toLocaleString("id-ID"),
    })),
  });
});

// Polling manual: jalankan 1 siklus & balikin status
router.post("/poll-now", (req, res) => {
  // dynamic import biar ga circular
  import("../services/poller.js").then(async ({ runLabPollCycle }) => {
    const lab = await runLabPollCycle(req.user.id);
    res.json({ ok: true, message: "Polling diperiksa; cooldown tetap berlaku.", lab });
  }).catch(() => res.status(500).json({ error: "Gagal polling." }));
});

export default router;