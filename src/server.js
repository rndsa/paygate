import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ROOT } from "./config.js";
import { db } from "./db/index.js";
import { parseCookies, securityHeaders, sessionMiddleware, csrf, requireAuth, optionalApiKeyAuth } from "./middleware/security.js";
import { rateLimit, requestId } from "./middleware/rateLimit.js";
import { startPolling, stopPolling } from "./services/poller.js";
import { stopLogins } from "./services/login.js";
import { renderPage } from "./lib/render.js";
import { asyncRoute } from "./lib/async.js";

import authRoutes from "./routes/auth.js";
import termsRoutes, { requireTerms } from "./routes/terms.js";
import dashboardRoutes from "./routes/dashboard.js";
import accountRoutes from "./routes/accounts.js";
import shopeeLoginRoutes from "./routes/shopee-login.js";
import { stopShopeeLogins } from "./services/shopee-login.js";
import apikeyRoutes from "./routes/apikeys.js";
import orderRoutes from "./routes/orders.js";
import settingsRoutes from "./routes/settings.js";
import incomeRoutes from "./routes/income.js";
import qrisRoutes from "./routes/qris.js";
import consoleRoutes from "./routes/console.js";
import { recordEvent, requireConsoleAdmin } from "./services/console-log.js";
import { auditAction } from "./middleware/console-audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");

// trust proxy hanya kalau dibelakang reverse proxy tepercaya.
// Pakai nilai dari config (angka hop / daftar IP), BUKAN `true`, supaya XFF tidak bisa dipalsukan.
if (config.trustProxy) app.set("trust proxy", config.trustProxy);

// Body parsers dengan limit ketat
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

// Static (css/js) — long cache di production
app.use(
  "/static",
  express.static(path.join(ROOT, "public"), {
    maxAge: config.isProd ? "7d" : 0,
    index: false,
  })
);

app.use(requestId);
app.use(securityHeaders);
app.use(parseCookies);
app.use(rateLimit({ bucket: "global", max: config.rateLimitMax, windowMs: config.rateLimitWindowMs }));
app.use(sessionMiddleware);
app.use("/api/orders", optionalApiKeyAuth);
app.use(csrf);
// Admin history has its own live-session guard and never accepts API keys.
app.use("/api/console", consoleRoutes);

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));
app.locals.config = config;

// ---- Routes ----
app.use(termsRoutes); // public consent, FAQ, visual MIT licence and /license.txt
app.use("/", authRoutes); // login/logout/change-password (get/post)

// Health (tanpa auth — buat monitoring/uptime)
app.get("/healthz", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---- API publik: autentikasi via API key (BUKAN session cookie) ----
// Dipasang SEBELUM requireAuth global supaya request API-key tidak ditolak.
app.use("/api/orders", orderRoutes);

// ---- Semua halaman dashboard butuh login ----
app.use(requireAuth);

// Authenticated, fixed allowlist only; never expose project/config paths.
for (const name of ["API.md", "LAB.md", "WEBSITE.md", "SHOPEE_CONNECT.md"]) {
  app.get(`/docs/${name}`, (req, res) => res.download(path.join(ROOT, "docs", name), name));
}
app.get('/docs/website.mjs', (req, res) => res.download(path.join(ROOT, 'examples', 'website.mjs'), 'website.mjs'));

app.get("/console", requireConsoleAdmin, requireTerms, asyncRoute((req,res) => renderPage(res, 'console', {title:'Console Log',active:'console',user:req.user})));

const pages = [
  ["/dashboard", "dashboard", "Dashboard"],
  ["/orders", "orders", "Orders"],
  ["/accounts", "accounts", "Payment Accounts"],
  ["/api-keys", "apikeys", "API Keys"],
  ["/transactions", "transactions", "Transactions"],
  ["/income", "income", "Pemasukan"],
  ["/docs", "docs", "Dokumentasi"],
  ["/settings", "settings", "Settings"],
  ["/tos", "tos", "Syarat Penggunaan"],
];
for (const [route, page, title] of pages) {
  app.get(route, requireTerms, asyncRoute((req, res) => renderPage(res, page, { title, active: page, user: req.user })));
}

app.get("/", requireTerms, (req, res) => {
  res.redirect("/dashboard");
});

// API (butuh session/API key per-route)
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/accounts/shopee/login", shopeeLoginRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/api-keys", apikeyRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/income", incomeRoutes);
app.use("/api/qris", qrisRoutes);

// Logout dari semua perangkat
app.post("/api/logout-all", auditAction("AUTH_LOGOUT_ALL"), requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.user.id);
  res.clearCookie("paygate_sid", { path: "/" });
  res.json({ ok: true });
});

// Transaksi (buat tabel) — data dari seen_transactions + orders
app.get("/api/transactions", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT st.provider, st.txid, st.amount, st.tx_time, st.seen_at, st.consumed_by, o.status AS order_status, o.payment_origin
       FROM seen_transactions st
       LEFT JOIN orders o ON o.id = st.consumed_by
       WHERE o.user_id = ? OR (st.consumed_by IS NULL AND st.account_id IN (SELECT id FROM payment_accounts WHERE user_id = ?))
       ORDER BY st.seen_at DESC LIMIT 100`
    )
    .all(req.user.id, req.user.id);
  res.json({
    transactions: rows.map((r) => ({
      provider: r.provider,
      txid: r.txid,
      amount: r.amount,
      tx_time: r.tx_time,
      seen_at: r.seen_at,
      consumed_by: r.consumed_by,
      order_status: r.order_status,
      payment_origin: r.payment_origin,
    })),
  });
});

// 404 API
app.use("/api", (req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));

// Error handler
app.use((err, req, res, next) => {
  // Body melebihi limit -> 413 (bukan 500)
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413)) {
    if (req.path.startsWith("/api/")) {
      return res.status(413).json({ error: "Permintaan terlalu besar." });
    }
    return res.status(413).send("Permintaan terlalu besar.");
  }
  if (err && (err.type === "entity.parse.failed" || err.status === 400)) {
    if (req.path.startsWith("/api/")) {
      return res.status(400).json({ error: "Format permintaan tidak valid." });
    }
    return res.status(400).send("Format permintaan tidak valid.");
  }
  console.error("[error]", {requestId:req.id,type:err instanceof Error ? err.name : "Error"});
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "Internal server error." });
  }
  res.status(500).send("Internal server error.");
});

// ---- Start ----
const server = app.listen(config.port, config.host, () => {
  console.log(`PayGate running on http://${config.host}:${config.port} (${config.env})`);
  recordEvent({event:"SERVER_START",code:"OK",stage:"server_start"});
  startPolling();
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  recordEvent({event:"SERVER_STOP",code:"OK",stage:"server_stop"});
  stopShopeeLogins();
  stopPolling();
  stopLogins();
  try { server.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
