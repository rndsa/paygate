import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * In-memory sliding-window rate limiter.
 * Key by IP (+ route bucket). Dipakai global & untuk login (stricter).
 */

const buckets = new Map(); // key -> { hits: [], blockedUntil }

function keyFor(ip, bucket) {
  return `${bucket}:${ip || "unknown"}`;
}

export function rateLimit({ windowMs = config.rateLimitWindowMs, max = config.rateLimitMax, bucket = "global" } = {}) {
  return function rateLimitMw(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = keyFor(ip, bucket);
    const now = Date.now();
    let rec = buckets.get(key);

    if (!rec) {
      rec = { hits: [], blockedUntil: 0 };
      buckets.set(key, rec);
    }
    if (now < rec.blockedUntil) {
      res.set("Retry-After", String(Math.ceil((rec.blockedUntil - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Coba lagi nanti." });
    }
    // buang hit lama
    rec.hits = rec.hits.filter((t) => now - t < windowMs);
    if (rec.hits.length >= max) {
      rec.blockedUntil = now + 60_000; // cooldown 1 menit setelah limit penuh
      return res.status(429).json({ error: "Too many requests. Coba lagi nanti." });
    }
    rec.hits.push(now);
    next();
  };
}

/**
 * Login brute-force guard: per IP + per username.
 * Mencatat gagal; setelah LOGIN_MAX_ATTEMPTS -> lockout LOGIN_LOCKOUT_MIN.
 */
const loginAttempts = new Map(); // key -> { count, lockedUntil }

export function loginGuard(ip, username) {
  const now = Date.now();
  const keys = [`ip:${ip || "unknown"}`, `user:${String(username).toLowerCase()}`];
  const isLocked = keys.some((k) => {
    const r = loginAttempts.get(k);
    return r && r.lockedUntil && now < r.lockedUntil;
  });
  if (isLocked) return { locked: true, retryAfterMs: remainingMs(keys, now) };
  return { locked: false };
}

export function recordLoginFailure(ip, username) {
  const now = Date.now();
  for (const k of [`ip:${ip || "unknown"}`, `user:${String(username).toLowerCase()}`]) {
    const r = loginAttempts.get(k) || { count: 0, lockedUntil: 0 };
    r.count += 1;
    if (r.count >= config.loginMaxAttempts) {
      r.lockedUntil = now + config.loginLockoutMs;
      r.count = 0;
    }
    loginAttempts.set(k, r);
  }
}

export function recordLoginSuccess(ip, username) {
  for (const k of [`ip:${ip || "unknown"}`, `user:${String(username).toLowerCase()}`]) {
    loginAttempts.delete(k);
  }
}

function remainingMs(keys, now) {
  let max = 0;
  for (const k of keys) {
    const r = loginAttempts.get(k);
    if (r && r.lockedUntil) max = Math.max(max, r.lockedUntil - now);
  }
  return max;
}

export function requestId(req, res, next) {
  req.id = crypto.randomBytes(6).toString("hex");
  res.set("X-Request-Id", req.id);
  next();
}
