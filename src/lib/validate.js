/**
 * Input validation & sanitization (anti SQLi/XSS).
 * Semua input user lewat sini sebelum dipakai.
 */

// Trim + buang karakter kontrol
export function cleanString(v, maxLen = 500) {
  if (typeof v !== "string") return "";
  // Normalisasi: buang null bytes & kontrol chars (kecuali \n biar aman di textarea)
  // eslint-disable-next-line no-control-regex
  let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Teks bebas: buang karakter yang berbahaya buat SQL & HTML
export function sanitizeText(v, maxLen = 500) {
  let s = cleanString(v, maxLen);
  // Buang karakter yang sering dipakai injection
  s = s.replace(/['";\\]/g, ""); // hapus quote, semicolon, backslash
  s = s.replace(/[<>]/g, ""); // hapus angle bracket (anti tag HTML)
  return s;
}

// Alias
export const cleanText = sanitizeText;

export function isUsername(v) {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(v);
}

export function isPassword(v) {
  return typeof v === "string" && v.length >= 8 && v.length <= 128;
}

// Rupiah amount — hanya angka, minimal 1 (nilai 1 = Rp1), max 1 milyar
export function isAmount(v) {
  if (typeof v !== "string" && typeof v !== "number") return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000_000;
}

export function isProvider(v) {
  return v === "shopeepay" || v === "gopay";
}

export function isApiKeyName(v) {
  return /^[a-zA-Z0-9 _-]{1,60}$/.test(v);
}

export function isOrderId(v) {
  return /^ORD-[A-Z0-9]{4}-[A-F0-9]{12}$/.test(v);
}
