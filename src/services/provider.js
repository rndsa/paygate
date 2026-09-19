import { decrypt } from "../lib/crypto.js";

const GOPAY_URL = "https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions";
const SHOPEE_URL = "https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list";

const MESSAGES = Object.freeze({
  AUTH_REJECTED: "Kredensial tidak valid atau ditolak; perbarui manual.",
  RATE_LIMITED: "Batas request provider tercapai; tunggu sebelum uji manual.",
  CHALLENGE: "Provider meminta verifikasi; selesaikan manual di aplikasi resmi.",
  BAD_RESPONSE: "Data provider tidak valid; pemeriksaan manual diperlukan.",
  NETWORK: "Koneksi provider gagal atau melewati batas waktu.",
  PAGE_LIMIT: "Pemindaian transaksi provider belum lengkap; pemeriksaan manual diperlukan.",
});
export class LabProviderError extends Error {
  constructor(code) {
    const safeCode = typeof code === "string" && Object.hasOwn(MESSAGES, code) ? code : "BAD_RESPONSE";
    super(MESSAGES[safeCode]);
    this.name = "LabProviderError";
    this.code = safeCode;
  }
}
function credentials(accountRow, encKey) {
  try {
    const value = JSON.parse(decrypt(accountRow?.credential, encKey));
    if (!object(value)) throw new Error();
    return value;
  } catch { throw new LabProviderError("AUTH_REJECTED"); }
}
function labCredentials(name, accountRow, encKey) {
  const c = credentials(accountRow, encKey);
  if ((accountRow.credential_source === "dashboard" || c.expires_at !== undefined) &&
      (!Number.isSafeInteger(c.expires_at) || c.expires_at <= Date.now())) throw new LabProviderError("AUTH_REJECTED");
  const token = name === "gopay" ? c.access_token : c.token;
  if (!cleanString(token, 4096) || !cleanString(c.merchant_id, 100) ||
    !/^[A-Za-z0-9_-]+$/.test(c.merchant_id) || (name === "shopeepay" &&
      (!token.startsWith("B:") || token.length <= 2 || shopeeId(c.merchant_id) !== c.merchant_id ||
      typeof c.store_id !== "string" || !c.store_id || shopeeId(c.store_id) !== c.store_id))) {
    throw new LabProviderError("AUTH_REJECTED");
  }
  return c;
}
function windowEnd(since) {
  const end = Date.now();
  if (!Number.isSafeInteger(since) || since <= 0 || since > end) throw new LabProviderError("BAD_RESPONSE");
  return end;
}

// Unofficial feed-only source audit: merchantid 1fa55b3e1024861ef74968f9cdb1bb1bfb899fea.
// src/api/transactionClient.ts; src/core/constants.ts; src/providers/shopee/{transactionFeed,api,constants}.ts.
// No auth/discovery, cookies, browser headers, retries, or endpoint overrides.
const MAX_BODY = 1024 * 1024;
const AUTH_CODES = new Set(["200020", "200026", "200013", "2010000"]);
function retryAfterMs(value) {
  // Headers may combine duplicate values. Do not split the weekday comma in HTTP-date.
  const values = (value ?? "").split(/,\s*(?=\d+\s*(?:,|$)|[A-Za-z]{3},)/);
  let delay = 15 * 60_000;
  for (const raw of values) {
    const part = raw.trim();
    const ms = /^\d+$/.test(part) ? Number(part) * 1000 : Date.parse(part) - Date.now();
    if (!Number.isNaN(ms)) delay = Math.max(delay, Math.min(Number.MAX_SAFE_INTEGER, ms));
  }
  return delay;
}
async function requestJson(fetch, url, init) {
  const target = new URL(url);
  if (![GOPAY_URL, SHOPEE_URL].includes(target.origin + target.pathname) || target.username || target.password || target.hash) {
    throw new LabProviderError("BAD_RESPONSE");
  }
  const controller = new AbortController();
  let timer, reader, response;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LabProviderError("NETWORK"));
    }, 15_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetch(target, { ...init, redirect: "error", credentials: "omit", signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!(response instanceof Response)) throw new LabProviderError("BAD_RESPONSE");
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new LabProviderError("CHALLENGE");
      if ([401, 403].includes(response.status)) throw new LabProviderError("AUTH_REJECTED");
      if (response.status === 429) {
        const error = new LabProviderError("RATE_LIMITED");
        error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
        throw error;
      }
      if (Number(response.headers.get("content-length")) > MAX_BODY || !response.body) throw new LabProviderError("BAD_RESPONSE");
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY) throw new LabProviderError("BAD_RESPONSE");
        chunks.push(value);
      }
      let text, payload;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)); }
      catch { throw new LabProviderError("BAD_RESPONSE"); }
      if (/captcha|recaptcha|hcaptcha|cf-chl-|challenge_required/i.test(text)) throw new LabProviderError("CHALLENGE");
      if (!response.ok) throw new LabProviderError("BAD_RESPONSE");
      try { payload = JSON.parse(text); } catch { throw new LabProviderError("BAD_RESPONSE"); }
      if (!object(payload)) throw new LabProviderError("BAD_RESPONSE");
      if ((typeof payload.code === "number" || typeof payload.code === "string") && AUTH_CODES.has(String(payload.code))) {
        throw new LabProviderError("AUTH_REJECTED");
      }
      return payload;
    })()]);
  } catch (error) {
    controller.abort();
    if (error instanceof LabProviderError) throw error;
    // Inspect only to classify; never propagate upstream errors, messages, causes, or bodies.
    const redirected = /redirect/i.test(error?.message ?? "") || /redirect/i.test(error?.cause?.message ?? "");
    throw new LabProviderError(redirected ? "CHALLENGE" : "NETWORK");
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
    else if (response instanceof Response && response.body) void response.body.cancel().catch(() => {});
  }
}
function cleanString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeTime(value) {
  if (typeof value !== "string") return 0;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return 0;
  const [, year, month, day] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 0;
  const n = Date.parse(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function shopeeId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  return typeof value === "string" && /^[1-9]\d{0,99}$/.test(value) ? value : "";
}

class LabAdapter {
  constructor(options = {}) { this.fetch = options.fetch ?? globalThis.fetch; }
  async validateCredential(raw, encKey) {
    try {
      const c = labCredentials(this.name, { credential: raw }, encKey);
      if (typeof c.qris_static !== "string" || !c.qris_static.trim() || c.qris_static.length > 4096 || /[\x00-\x1f\x7f]/.test(c.qris_static)) {
        throw new LabProviderError("AUTH_REJECTED");
      }
      return { ok: true };
    } catch { return { ok: false, error: MESSAGES.AUTH_REJECTED }; }
  }
  async testConnection(accountRow, encKey) {
    try { await this.getTransactions(accountRow, encKey, Date.now() - 60_000); return { ok: true, detail: "Token diterima" }; }
    catch (error) {
      const safe = error instanceof LabProviderError ? error : new LabProviderError("NETWORK");
      return { ok: false, detail: safe.message, code: safe.code, ...(safe.retryAfterMs ? { retryAfterMs: safe.retryAfterMs } : {}) };
    }
  }
}

function addTransaction(rows, txid, amount, time) {
  const prior = rows.get(txid);
  if (prior && (prior.amount !== amount || prior.time !== time)) throw new LabProviderError("BAD_RESPONSE");
  rows.set(txid, { txid, amount, time });
}

class GoPayLabAdapter extends LabAdapter {
  get name() { return "gopay"; }
  async getTransactions(accountRow, encKey, since) {
    const c = labCredentials(this.name, accountRow, encKey), end = windowEnd(since);
    const url = new URL(GOPAY_URL), rows = new Map();
    url.searchParams.set("size", "100");
    url.searchParams.set("statuses", "SETTLEMENT,CAPTURE");
    url.searchParams.set("payment_types", "QRIS,GOPAY");
    url.searchParams.set("start_time", new Date(since).toISOString());
    url.searchParams.set("end_time", new Date(end).toISOString());
    url.searchParams.set("merchant_ids", c.merchant_id);
    let from = 0, total;
    // ponytail: three pages maximum; widen only after audited feed capacity review.
    for (let page = 0; page < 3; page++) {
      url.searchParams.set("from", String(from));
      const payload = await requestJson(this.fetch, url, { headers: {
        Accept: "application/json", Authorization: `Bearer ${c.access_token}`, "X-User-Type": "merchant",
        "Gojek-Country-Code": "ID", "Gojek-Timezone": "Asia/Jakarta",
      } });
      if (!Array.isArray(payload.transactions) || !Number.isSafeInteger(payload.from) || payload.from < 0 ||
        !Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > 100 ||
        !Number.isSafeInteger(payload.total) || payload.total < 0 || payload.transactions.length > payload.size ||
        (total !== undefined && payload.total !== total)) throw new LabProviderError("BAD_RESPONSE");
      if (payload.from !== from) throw new LabProviderError("PAGE_LIMIT");
      total = payload.total;
      const next = from + payload.transactions.length;
      if (next > total) throw new LabProviderError("BAD_RESPONSE");
      for (const raw of payload.transactions) {
        if (!object(raw) || !Number.isSafeInteger(raw.gross_amount)) continue;
        // gross_amount is minor units. real_gross_amount and settlement_time must not replace it/time.
        const amount = raw.gross_amount / 100, time = safeTime(raw.transaction_time), txid = raw.id;
        if (cleanString(txid, 200) && raw.merchant_id === c.merchant_id &&
          ["SETTLEMENT", "CAPTURE"].includes(raw.transaction_status) && ["QRIS", "GOPAY"].includes(raw.payment_type) &&
          (raw.currency === undefined || raw.currency === "IDR") && Number.isSafeInteger(amount) &&
          amount > 0 && time >= since && time <= end) addTransaction(rows, txid, amount, time);
      }
      if (next === total) return [...rows.values()];
      if (next === from) throw new LabProviderError("PAGE_LIMIT");
      from = next;
    }
    throw new LabProviderError("PAGE_LIMIT");
  }
}

function parseShopeeAmount(value) {
  if (typeof value !== "string" || (!/^\d+$/.test(value) && !/^\d{1,3}(?:\.\d{3})+$/.test(value))) return 0;
  const amount = Number(value.replaceAll(".", ""));
  return Number.isSafeInteger(amount) ? amount : 0;
}

class ShopeePayLabAdapter extends LabAdapter {
  get name() { return "shopeepay"; }
  async getTransactions(accountRow, encKey, since) {
    const c = labCredentials(this.name, accountRow, encKey), end = windowEnd(since);
    const rows = new Map(), cursors = new Set();
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      const payload = await requestJson(this.fetch, SHOPEE_URL, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Timestamp-Ms": String(Date.now()), "X-Token": "" },
        body: JSON.stringify({ data: {
          metadata: { token: c.token, language: "id", timezone: "Asia/Jakarta" }, pageSize: 10,
          filter: { startTime: Math.floor(since / 1000), endTime: Math.floor(end / 1000), serviceList: [1, 3] },
          sorter: { field: "createTime", order: "descend" }, next_position: cursor,
        } }),
      });
      if (payload.code !== 0 || !object(payload.data) || !Array.isArray(payload.data.list) || payload.data.list.length > 10 ||
        (payload.data.next_position !== undefined && payload.data.next_position !== "" && !cleanString(payload.data.next_position, 2048))) {
        throw new LabProviderError("BAD_RESPONSE");
      }
      for (const raw of payload.data.list) {
        if (!object(raw) || !Number.isSafeInteger(raw.createTime)) continue;
        const txid = raw.transactionId, amount = parseShopeeAmount(raw.amount), time = raw.createTime * 1000;
        if (cleanString(txid, 200) && raw.status === 3 && [1, 3].includes(raw.service) &&
          shopeeId(raw.merchantId) === c.merchant_id && shopeeId(raw.storeId) === c.store_id && amount > 0 &&
          Number.isSafeInteger(time) && time >= since && time <= end) addTransaction(rows, txid, amount, time);
      }
      if (payload.data.next_position === undefined && payload.data.list.length === 10) throw new LabProviderError("PAGE_LIMIT");
      const next = payload.data.next_position ?? "";
      if (!next) return [...rows.values()];
      if (cursors.has(next)) throw new LabProviderError("PAGE_LIMIT");
      cursors.add(next);
      cursor = next;
    }
    throw new LabProviderError("PAGE_LIMIT");
  }
}

export function getProviderFor(name, options = {}) {
  if (name === "gopay") return new GoPayLabAdapter(options);
  if (name === "shopeepay") return new ShopeePayLabAdapter(options);
  throw new Error("Unsupported provider.");
}
