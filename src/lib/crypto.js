import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

// ---------- Password hashing (bcrypt) ----------
export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

// ---------- Timing-safe comparison ----------
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- Random tokens ----------
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}
export function randomApiKey() {
  // Format: pgk_live_<32 hex> — dipakai sekali buat ditampilkan, disimpan hashed
  return `pgk_live_${crypto.randomBytes(24).toString("hex")}`;
}
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// ---------- AES-256-GCM encryption at rest ----------
export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}
export function decrypt(payload, key) {
  try {
    const [ivHex, tagHex, dataHex] = String(payload).split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

// ---------- CSRF token ----------
export function csrfToken() {
  return crypto.randomBytes(24).toString("hex");
}
