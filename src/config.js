import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.resolve(process.env.PAYGATE_DATA_DIR || path.join(ROOT, "data"));

// Ensure data dir exists
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnvFile(), ...process.env };

function bool(v, def = false) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

/**
 * TRUST_PROXY: `false`/`0` = jangan percaya header apapun.
 * Angka = jumlah hop proxy (Express hop-count).
 * String = daftar subnet CIDR/IP yang dipisah koma (Express pre-validated list).
 * Nilai `true` sengaja DILARANG: "trust all" bikin X-Forwarded-For bisa dipalsukan
 * klien dan melewati rate-limit / lockout login.
 */
function parseTrustProxy(v) {
  if (v === undefined || v === "") return false;
  const s = String(v).trim().toLowerCase();
  if (["", "0", "false", "off", "no"].includes(s)) return false;
  if (["1", "2", "3", "4", "5"].includes(s)) return Number(s);
  if (s === "true" || s === "on" || s === "yes" || s === "all") {
    throw new Error("TRUST_PROXY=true tidak diizinkan (X-Forwarded-For bisa dipalsukan). Pakai angka hop (mis. 1) atau daftar IP/CIDR.");
  }
  // daftar subnet/IP dipisah koma -> biarkan Express yang validasi
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
}
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const config = {
  // Server
  port: num(env.PORT, 3000),
  host: env.HOST || "127.0.0.1",
  baseUrl: env.BASE_URL || "",
  env: env.NODE_ENV || "development",
  isProd: (env.NODE_ENV || "development") === "production",

  // Security
  cookieSecret: env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex"),
  sessionTtlMs: num(env.SESSION_TTL_HOURS, 24 * 7) * 3600_000,
  rateLimitMax: num(env.RATE_LIMIT_MAX, 100),
  rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MIN, 15) * 60_000,
  loginMaxAttempts: num(env.LOGIN_MAX_ATTEMPTS, 5),
  loginLockoutMs: num(env.LOGIN_LOCKOUT_MIN, 15) * 60_000,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),

  // Encryption at rest (kredensial payment account). If not set, generate + persist to data/secret.key
  encryptionKey: env.ENCRYPTION_KEY || null,

  // Provider polling
  labUnofficialEnabled: bool(env.LAB_UNOFFICIAL, false),
  labUserId: /^[1-9][0-9]*$/.test(env.LAB_USER_ID || '') ? Number(env.LAB_USER_ID) : 0,
  labPollIntervalMs: Math.max(30_000, num(env.LAB_POLL_INTERVAL_MS, 60_000)),
  orderTtlMinutes: num(env.ORDER_TTL_MINUTES, 30),
  gopayLab: {
    accessToken: env.GOPAY_ACCESS_TOKEN || "",
    merchantId: env.GOPAY_MERCHANT_ID || "",
    staticQris: env.GOPAY_QRIS_STATIC || "",
  },
  shopeepayLab: {
    token: env.SHOPEEPAY_TOKEN || "",
    merchantId: env.SHOPEEPAY_MERCHANT_ID || "",
    storeId: env.SHOPEEPAY_STORE_ID || "",
    staticQris: env.SHOPEEPAY_QRIS_STATIC || "",
  },

  // DB path
  dbPath: env.DB_PATH || path.join(DATA_DIR, "paygate.db"),
};

if (config.labUnofficialEnabled && (!Number.isSafeInteger(config.labUserId) || config.labUserId <= 0)) {
  throw new Error('LAB_USER_ID wajib berupa ID user PayGate positif yang eksplisit');
}

// Encryption key management: stored in data/secret.key with 0600 perms, or from ENCRYPTION_KEY
export function getEncryptionKey() {
  if (config.encryptionKey) return Buffer.from(config.encryptionKey, "hex");
  const keyPath = path.join(DATA_DIR, "secret.key");
  if (fs.existsSync(keyPath)) {
    return Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

export function sessionCookieName() {
  return "paygate_sid";
}
