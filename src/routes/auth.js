import { auditAction } from "../middleware/console-audit.js";
import { Router } from "express";
import { requireTerms } from "./terms.js";
import { asyncRoute } from "../lib/async.js";
import { db, dbNow } from "../db/index.js";
import { config } from "../config.js";
import { hashPassword, verifyPassword, randomToken } from "../lib/crypto.js";
import { isUsername, isPassword, cleanString } from "../lib/validate.js";
import { rateLimit, loginGuard, recordLoginFailure, recordLoginSuccess } from "../middleware/rateLimit.js";
import { sessionCookieName } from "../middleware/security.js";
import { verifyCode, signPendingToken, verifyPendingToken } from "../lib/totp.js";

const router = Router();
function safeNext(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://paygate.invalid");
    return url.origin === "https://paygate.invalid" && !url.pathname.startsWith("//") ? url.pathname + url.search + url.hash : "/";
  } catch { return "/"; }
}

// Middleware spesifik auth: rate limit. Cookie parsing + CSRF sudah dipasang global
// di server.js; tidak diulang di sini supaya cookie paygate_csrf tidak ter-set dobel.
router.use((req,res,next) => auditAction(req.method === 'POST' ? ({'/login':'AUTH_LOGIN','/logout':'AUTH_LOGOUT','/change-password':'AUTH_PASSWORD'}[req.path]) : null)(req,res,next));

/** Buat session baru + set cookie. Dipakai login normal dan setelah verifikasi 2FA. */
function createSession(req, res, user, ip) {
  const sid = randomToken(24);
  const expires = Date.now() + config.sessionTtlMs;
  db.prepare("INSERT INTO sessions (id, user_id, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sid, user.id, ip, req.headers["user-agent"] || "", Date.now(), expires);
  res.cookie(sessionCookieName(), sid, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    maxAge: config.sessionTtlMs,
    path: "/",
  });
  res.locals.consoleUserId = user.id;
}

const PENDING_COOKIE = "paygate_2fa";

// ---------- LOGIN ----------
router.get("/login", requireTerms, (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("login", {
    title: "Login — PayGate",
    error: null,
    next: safeNext(req.query.next),
  });
});

router.post("/login", requireTerms, rateLimit({ bucket: "login", max: 10, windowMs: 60_000 }), asyncRoute(async (req, res) => {
  const username = cleanString(req.body?.username, 32);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const next = safeNext(req.query.next || req.body?.next);
  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  // Cek lockout dulu
  const guard = loginGuard(ip, username);
  if (guard.locked) {
    const menit = Math.ceil((guard.retryAfterMs || 0) / 60000);
    return res.status(429).render("login", { title: "Login — PayGate", error: `Terlalu banyak percobaan. Coba lagi ${menit} menit lagi.`, next });
  }

  if (!isUsername(username) || !isPassword(password)) {
    recordLoginFailure(ip, username);
    return res.status(422).render("login", { title: "Login — PayGate", error: "Username atau password salah format.", next });
  }

  const user = db.prepare("SELECT id, username, password_hash, role, totp_enabled, totp_secret FROM users WHERE username = ?").get(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordLoginFailure(ip, username);
    return res.status(401).render("login", { title: "Login — PayGate", error: "Username atau password salah.", next });
  }

  // Password benar. Kalau 2FA aktif -> tahan session, minta kode OTP dulu.
  if (user.totp_enabled && user.totp_secret) {
    const expiresAt = Date.now() + 5 * 60_000;
    res.cookie(PENDING_COOKIE, signPendingToken(user.id, expiresAt), {
      httpOnly: true,
      secure: config.isProd,
      sameSite: "lax",
      maxAge: 5 * 60_000,
      path: "/",
    });
    return res.redirect("/login/otp?next=" + encodeURIComponent(next));
  }

  recordLoginSuccess(ip, username);
  createSession(req, res, user, ip);
  res.redirect(next);
}));

// ---------- LOGIN 2FA (kode OTP) ----------
router.get("/login/otp", rateLimit({ bucket: "otp", max: 30, windowMs: 60_000 }), (req, res) => {
  if (req.user) return res.redirect("/");
  const pending = verifyPendingToken(req.cookies?.[PENDING_COOKIE]);
  if (!pending) return res.redirect("/login");
  res.render("login-otp", {
    title: "Verifikasi 2FA — PayGate",
    error: null,
    next: safeNext(req.query.next),
  });
});

router.post("/login/otp", rateLimit({ bucket: "otp", max: 30, windowMs: 60_000 }), asyncRoute(async (req, res) => {
  const next = safeNext(req.query.next || req.body?.next);
  const pending = verifyPendingToken(req.cookies?.[PENDING_COOKIE]);
  if (!pending) {
    res.clearCookie(PENDING_COOKIE, { path: "/" });
    return res.redirect("/login");
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const code = cleanString(req.body?.code, 8);

  const user = db.prepare("SELECT id, username, role, totp_enabled, totp_secret FROM users WHERE id = ?").get(pending.userId);
  if (!user || !user.totp_enabled || !user.totp_secret) {
    res.clearCookie(PENDING_COOKIE, { path: "/" });
    return res.redirect("/login");
  }

  const guard = loginGuard(ip, user.username);
  if (guard.locked) {
    const menit = Math.ceil((guard.retryAfterMs || 0) / 60000);
    return res.status(429).render("login-otp", { title: "Verifikasi 2FA — PayGate", error: `Terlalu banyak percobaan. Coba lagi ${menit} menit lagi.`, next });
  }

  const check = verifyCode(user.totp_secret, user.username, code);
  if (!check.valid) {
    recordLoginFailure(ip, user.username);
    return res.status(401).render("login-otp", { title: "Verifikasi 2FA — PayGate", error: "Kode 2FA salah atau sudah kedaluwarsa.", next });
  }

  recordLoginSuccess(ip, user.username);
  res.clearCookie(PENDING_COOKIE, { path: "/" });
  createSession(req, res, user, ip);
  res.redirect(next);
}));

// ---------- LOGOUT ----------
router.post("/logout", (req, res) => {
  const sid = req.cookies?.[sessionCookieName()];
  if (sid) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
  }
  res.clearCookie(sessionCookieName(), { path: "/" });
  res.redirect("/login");
});

// ---------- CHANGE PASSWORD ----------
router.post("/change-password", asyncRoute(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const oldPw = typeof req.body?.current_password === "string" ? req.body.current_password : "";
  const newPw = typeof req.body?.new_password === "string" ? req.body.new_password : "";
  const confirmPw = typeof req.body?.confirm_password === "string" ? req.body.confirm_password : "";

  if (newPw !== confirmPw) return res.status(422).json({ error: "Password baru tidak cocok." });
  if (!isPassword(newPw)) return res.status(422).json({ error: "Password minimal 8 karakter." });

  const user = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!user || !(await verifyPassword(oldPw, user.password_hash))) {
    return res.status(401).json({ error: "Password saat ini salah." });
  }

  const hash = await hashPassword(newPw);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, Date.now(), req.user.id);
  // Invalidate all sessions except current
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.user.sid);

  res.json({ ok: true });
}));

export default router;