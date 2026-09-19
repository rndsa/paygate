import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import { config } from "../config.js";

const ISSUER = "PayGate";
const SECRET_BYTES = 20;

/**
 * Generate new TOTP secret (base32 encoded) — belum di-save ke DB.
 */
export function generateSecret() {
  return new OTPAuth.Secret({ size: SECRET_BYTES }).base32;
}

/**
 * Build TOTP instance dari secret base32.
 */
function makeTotp(secretBase32, username) {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/**
 * Verify 6-digit code terhadap user secret. window=1 ≈ ±30s tolerance.
 * Returns { valid, drift } atau { valid: false } kalau error.
 */
export function verifyCode(secretBase32, username, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return { valid: false };
  try {
    const totp = makeTotp(secretBase32, username);
    const delta = totp.validate({ token: code, window: 1 });
    return { valid: delta !== null, drift: delta ?? 0 };
  } catch {
    return { valid: false };
  }
}

/**
 * Build otpauth:// URI buat QR code.
 */
export function buildUri(secretBase32, username) {
  return makeTotp(secretBase32, username).toString();
}

/**
 * HMAC-SHA256 sign untuk pending-2FA token.
 * Format: userId.expiry.hmac — stateless, expiry pendek (default 5 menit).
 */
function hmacKey() {
  return config.cookieSecret;
}

export function signPendingToken(userId, expiresAt) {
  const payload = `${userId}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", hmacKey()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyPendingToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expStr, sig] = parts;
  const expected = crypto.createHmac("sha256", hmacKey()).update(`${userIdStr}.${expStr}`).digest("hex");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  const userId = Number(userIdStr);
  const exp = Number(expStr);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(exp)) return null;
  if (Date.now() > exp) return null;
  return { userId, expiresAt: exp };
}
