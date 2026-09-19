import { config } from "../config.js";
import { db } from "../db/index.js";
import { csrfToken, hashToken, safeEqual } from "../lib/crypto.js";
import { cleanString } from "../lib/validate.js";

/** Security headers (selalu dipasang, kecuali endpoint yang perlu framing) */
export function securityHeaders(req, res, next) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-XSS-Protection": "0", // deprecated; diganti CSP
  });
  // CSP ketat tapi izinin style inline (untuk SPA-lite + data: image QR)
  res.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  if (config.isProd) {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

/**
 * Session auth — cookie httpOnly+secure+sameSite.
 * Session disimpan di DB; divalidasi tiap request.
 */
export function sessionCookieName() {
  return "paygate_sid";
}

export function sessionMiddleware(req, res, next) {
  req.user = null;
  const sid = req.cookies?.[sessionCookieName()] || null;
  if (!sid) return next();
  try {
    const row = db
      .prepare(
        `SELECT s.id, s.user_id, s.expires_at, u.username, u.role, u.totp_enabled
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`
      )
      .get(sid);
    if (!row) return next();
    if (row.expires_at < Date.now()) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
      return next();
    }
    // sliding expiration: perpanjang kalau < 50% TTL tersisa
    const ttl = config.sessionTtlMs;
    if (row.expires_at - Date.now() < ttl / 2) {
      const newExp = Date.now() + ttl;
      db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(newExp, sid);
      row.expires_at = newExp;
    }
    req.user = {
      id: row.user_id,
      username: row.username,
      role: row.role,
      totp_enabled: !!row.totp_enabled,
      sid,
    };
    res.locals.user = req.user;
  } catch {
    req.user = null;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    // Kalau minta JSON/API -> 401; kalau browsing -> redirect login
    if (req.path.startsWith("/api/") || req.xhr) {
      return res.status(401).json({ error: "Unauthorized. Silakan login." });
    }
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  }
  next();
}

/** Hanya admin role (saat ini semua user admin; disiapkan buat masa depan) */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

/** CSRF protection (double-submit cookie pattern).
 *  1. GET: pastikan cookie paygate_csrf ada + set res.locals.csrfToken buat template.
 *  2. Non-GET: wajib kirim token di header X-CSRF-Token / field _csrf yang match cookie.
 */
export function csrf(req, res, next) {
  const existing = req.cookies?.paygate_csrf || "";
  const token = existing && existing.length >= 16 ? existing : csrfToken();
  if (!existing || existing !== token) {
    res.cookie("paygate_csrf", token, {
      httpOnly: false, // perlu dibaca JS (dikirim sbg header AJAX)
      sameSite: "lax",
      secure: config.isProd,
      path: "/",
    });
  }
  res.locals.csrfToken = token;

  // Method aman: tanpa validasi
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  // Only an already-validated API identity may bypass cookie CSRF.
  if (req.apiKey && req.user?.viaApiKey) return next();

  const sent = req.headers["x-csrf-token"] || req.body?._csrf || "";
  if (!sent || !safeEqual(token, sent)) {
    return res.status(403).json({ error: "CSRF token invalid. Refresh halaman & coba lagi." });
  }
  next();
}

/** API Key auth — tiap request API wajib punya key valid */
export function requireApiKey(req, res, next) {
  const header = req.headers["x-api-key"] || req.headers.authorization || "";
  const token = String(header).replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return res.status(401).json({ error: "API key required. Kirim header X-Api-Key." });
  }
  const keyHash = hashToken(token);
  const row = db
    .prepare(`SELECT id, user_id, name, revoked_at FROM api_keys WHERE key_hash = ?`)
    .get(keyHash);

  if (!row || row.revoked_at) {
    return res.status(401).json({ error: "API key invalid atau telah di-revoke." });
  }
  db.prepare("UPDATE api_keys SET last_used = ? WHERE id = ?").run(Date.now(), row.id);
  const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(row.user_id);
  if (!user) return res.status(401).json({ error: "User tidak ditemukan." });

  req.apiKey = { id: row.id, name: row.name };
  req.user = { id: user.id, username: user.username, role: user.role, viaApiKey: true };
  next();
}

/**
 * Optional auth: kalau ada header API key, resolve & set req.user.
 * Dipakai endpoint yang boleh diakses via session ATAU API key.
 * (req.user dari session sudah diset sessionMiddleware lebih dulu.)
 */
export function optionalApiKeyAuth(req, res, next) {
  if (req.apiKey) return next();
  if (req.headers["x-api-key"] !== undefined || req.headers.authorization !== undefined) {
    return requireApiKey(req, res, next);
  }
  next();
}

export function parseCookies(req, res, next) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    let v;
    try { v = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { return res.status(400).json({ error: "Cookie invalid." }); }
    if (k) out[k] = v;
  }
  req.cookies = out;
  next();
}
