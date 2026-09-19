import { db } from '../db/index.js';
import { recordEvent } from './console-log.js';
import { config, getEncryptionKey } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { staticToDynamicQris } from '../lib/qris.js';
import { getProviderFor } from './provider.js';
import { recordIncome } from '../lib/income.js';

const inFlight = new Map();
export const LAB_PROVIDERS = ['gopay', 'shopeepay'];
export function labCredential(provider) {
  if (provider === 'gopay') return { access_token: config.gopayLab.accessToken, merchant_id: config.gopayLab.merchantId, qris_static: config.gopayLab.staticQris };
  if (provider === 'shopeepay') return { token: config.shopeepayLab.token, merchant_id: config.shopeepayLab.merchantId, store_id: config.shopeepayLab.storeId, qris_static: config.shopeepayLab.staticQris };
  return null;
}
function complete(c) { return c && Object.values(c).every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\r\n]/.test(v)); }
export function getLabAccount(provider, userId) {
  if (!LAB_PROVIDERS.includes(provider) || !config.labUnofficialEnabled || userId !== config.labUserId) return null;
  const row = db.prepare('SELECT * FROM payment_accounts WHERE user_id=? AND provider=?').get(userId, provider);
  if (!row || (row.credential_source !== 'dashboard' && !complete(labCredential(provider)))) return null;
  if (row.credential_source === 'dashboard') {
    let valid = false;
    try { const c = JSON.parse(decrypt(row.credential, getEncryptionKey())); valid = Number.isSafeInteger(c?.expires_at) && c.expires_at > Date.now(); } catch {}
    if (!valid && (row.status !== 'blocked' || row.last_error !== 'AUTH_REJECTED' || row.last_validated_at !== null)) {
      row.updated_at = Math.max(Date.now(), row.updated_at + 1);
      db.prepare("UPDATE payment_accounts SET status='blocked',last_error='AUTH_REJECTED',last_validated_at=NULL,updated_at=? WHERE id=?").run(row.updated_at, row.id);
      inFlight.get(row.id)?.abort();
      Object.assign(row, {status:'blocked',last_error:'AUTH_REJECTED',last_validated_at:null});
    }
  }
  return row;
}
export function syncLabAccounts() {
  if (!config.labUnofficialEnabled) return;
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(config.labUserId)) throw new Error('LAB_USER_ID tidak ditemukan');
  const key = getEncryptionKey();
  for (const provider of LAB_PROVIDERS) {
    const c = labCredential(provider), now = Date.now();
    const old = db.prepare('SELECT * FROM payment_accounts WHERE user_id=? AND provider=?').get(config.labUserId, provider);
    if (old?.credential_source === 'dashboard') continue; // dashboard session is authoritative; never overwrite from env
    if (!complete(c)) {
      if (old) db.prepare("UPDATE payment_accounts SET status='paused',last_error='ENV_INCOMPLETE',last_validated_at=NULL,updated_at=? WHERE id=?").run(now, old.id);
      continue;
    }
    try { staticToDynamicQris(c.qris_static, 1); }
    catch { throw new Error(`QRIS statis ${provider} invalid`); }
    const plain = JSON.stringify(c);
    if (old && decrypt(old.credential, key) === plain) continue; // pause/error/cooldown survives restart
    if (old) {
      const previous = JSON.parse(decrypt(old.credential, key) || 'null');
      const changedScope = !previous || previous.merchant_id !== c.merchant_id || previous.store_id !== c.store_id || previous.qris_static !== c.qris_static;
      if (changedScope && (db.prepare('SELECT 1 FROM orders WHERE account_id=? LIMIT 1').get(old.id) || db.prepare('SELECT 1 FROM seen_transactions WHERE account_id=? LIMIT 1').get(old.id))) throw new Error(`Scope ${provider} memiliki riwayat order; gunakan DB lab terpisah untuk merchant baru`);
      db.prepare("UPDATE payment_accounts SET credential=?,status='configured',last_error=NULL,last_validated_at=NULL,updated_at=? WHERE id=?").run(encrypt(plain, key), Math.max(now, old.updated_at + 1), old.id);
    } else {
      db.prepare("INSERT INTO payment_accounts(user_id,provider,label,credential,status,created_at,updated_at) VALUES(?,?,?,?,'configured',?,?)")
        .run(config.labUserId, provider, `${provider} LAB`, encrypt(plain, key), now, now);
    }
  }
}
// One path for background, Test and Resume. GET status never makes upstream calls.
export async function pollLabAccount(provider, userId, options = {}) {
  const account = getLabAccount(provider, userId), now = Date.now();
  if (!account) return { ok: false, code: 'UNCONFIGURED' };
  if (!options.test && account.status !== 'active') return { ok: false, code: 'PAUSED' };
  if (inFlight.has(account.id) || account.next_poll_at > now) return { ok: false, code: 'COOLDOWN', next_poll_at: account.next_poll_at };
  const earliest = db.prepare("SELECT MIN(created_at) AS t FROM orders WHERE account_id=? AND user_id=? AND provider=? AND payment_origin='live' AND status IN ('pending','expired') AND expires_at>?").get(account.id, userId, provider, now - 86400000).t;
  if (!options.test && earliest == null) return { ok: true, skipped: true };
  const lease = db.prepare('UPDATE payment_accounts SET next_poll_at=? WHERE id=? AND next_poll_at<=? AND updated_at=?')
    .run(now + Math.max(config.labPollIntervalMs, 120000), account.id, now, account.updated_at);
  if (!lease.changes) return { ok: false, code: 'COOLDOWN' };
  const controller = new AbortController();
  inFlight.set(account.id, controller);
  let pollCode = 'CANCELLED';
  try {
    const since = earliest == null ? now - 60000 : Math.max(earliest - 1000, now - 86400000);
    const fetch = options.fetch ?? globalThis.fetch;
    const rows = await getProviderFor(provider, { ...options, fetch: (url, init) => {
      const current = getLabAccount(provider, userId);
      if (!current || current.updated_at !== account.updated_at || current.credential !== account.credential) controller.abort();
      controller.signal.throwIfAborted();
      return fetch(url, { ...init, signal: AbortSignal.any([controller.signal, init.signal]) });
    } }).getTransactions(account, getEncryptionKey(), since);
    const current = getLabAccount(provider, userId);
    if (!current || current.updated_at !== account.updated_at || current.credential !== account.credential) return { ok: false, code: 'CANCELLED' };
    const done = Date.now();
    db.prepare("UPDATE payment_accounts SET status='active',last_error=NULL,last_validated_at=?,next_poll_at=? WHERE id=?").run(done, done + config.labPollIntervalMs, account.id);
    // Test also reconciles pending orders; rows only arrive from server-side adapter.
    for (const tx of rows) handleLabTransaction({ ...account, status: 'active' }, tx);
    pollCode = 'OK';
    return { ok: true, detail: 'Feed diterima. Pembayaran dan settlement tetap perlu diverifikasi.', count: rows.length };
  } catch (error) {
    const current = getLabAccount(provider, userId);
    if (controller.signal.aborted || !current || current.updated_at !== account.updated_at || current.credential !== account.credential) return { ok: false, code: 'CANCELLED' };
    const codes = ['AUTH_REJECTED','RATE_LIMITED','CHALLENGE','BAD_RESPONSE','NETWORK','PAGE_LIMIT'];
    const code = codes.includes(error?.code) ? error.code : 'POLL_FAILED';
    const blocked = ['AUTH_REJECTED','RATE_LIMITED','CHALLENGE'].includes(code);
    const retry = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
    const delay = Math.max(config.labPollIntervalMs, blocked ? 900000 : 0, retry);
    db.prepare("UPDATE payment_accounts SET status=?,last_error=?,next_poll_at=? WHERE id=? AND updated_at=?")
      .run(blocked ? 'blocked' : 'error', code, Date.now() + delay, account.id, account.updated_at);
    pollCode = code === 'POLL_FAILED' ? 'PROVIDER_ERROR' : code;
    return { ok: false, code }; // no raw upstream text, JSON or token in errors
  } finally {
    inFlight.delete(account.id);
    recordEvent({event:'PROVIDER_POLL',user_id:userId,module:provider,code:pollCode,stage:'provider_poll',duration_ms:Date.now()-now});
  }
}

export function handleLabTransaction(account, tx) {
  const current = account && getLabAccount(account.provider, account.user_id), now = Date.now();
  if (!current || current.id !== account.id || current.status !== 'active' || current.credential !== account.credential ||
      !tx || typeof tx.txid !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(tx.txid) ||
      !Number.isSafeInteger(tx.amount) || tx.amount <= 0 || !Number.isSafeInteger(tx.time) || tx.time <= 0 || tx.time > now) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM seen_transactions WHERE provider=? AND txid=?').get(account.provider, tx.txid)) { db.exec('ROLLBACK'); return false; }
    // Include terminal orders when checking ambiguity: never redirect their payments to another order.
    const candidates = db.prepare('SELECT id,status,payment_origin FROM orders WHERE account_id=? AND user_id=? AND provider=? AND amount=? AND created_at<=? AND expires_at>? LIMIT 2')
      .all(account.id, account.user_id, account.provider, tx.amount, tx.time, tx.time);
    const matched = candidates.length === 1 && candidates[0].payment_origin === 'live' && ['pending','expired'].includes(candidates[0].status) ? candidates[0].id : null;
    db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at,consumed_by) VALUES(?,?,?,?,?,?,?)')
      .run(account.provider, tx.txid, account.id, tx.amount, tx.time, now, matched);
    if (matched) {
      db.prepare("UPDATE orders SET status='paid',claimed_txid=?,claimed_at=?,updated_at=? WHERE id=? AND status IN ('pending','expired')").run(tx.txid, now, now, matched);
      // Catat pemasukan pada transaksi yang sama: QRIS berhasil = langsung masuk buku.
      const order = db.prepare('SELECT user_id, provider, amount FROM orders WHERE id=?').get(matched);
      if (order) recordIncome(db, { orderId: matched, userId: order.user_id, provider: order.provider, grossAmount: order.amount, now });
    }
    db.exec('COMMIT');
    recordEvent({event:matched?'PAYMENT_MATCH':'PAYMENT_UNMATCHED',user_id:account.user_id,code:matched?'MATCHED':'UNMATCHED',stage:'transaction_match'});
    return Boolean(matched);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function pauseLabAccount(provider, userId) {
  const account = getLabAccount(provider, userId);
  if (!account) return false;
  db.prepare("UPDATE payment_accounts SET status='paused',updated_at=? WHERE id=?")
    .run(Math.max(Date.now(), account.updated_at + 1), account.id);
  inFlight.get(account.id)?.abort();
  return true;
}
