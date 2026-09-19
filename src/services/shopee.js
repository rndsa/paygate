import { db } from '../db/index.js';
import { config, getEncryptionKey } from '../config.js';
import { verifyPassword, encrypt, decrypt } from '../lib/crypto.js';
import { staticToDynamicQris } from '../lib/qris.js';
import { pauseLabAccount } from './lab.js';

const messages = {
  FORBIDDEN: 'Impor sesi hanya untuk pemilik admin yang diizinkan dengan sesi PayGate aktif.',
  INVALID: 'Isian impor tidak valid. Gunakan token B: saja, ID numerik, QRIS statis, dan persetujuan pemetaan manual.',
  REAUTH: 'Password PayGate salah. Ini bukan password Shopee.',
  EXPIRED: 'Sesi atau password PayGate berubah. Masuk kembali sebelum impor.',
  COOLDOWN: 'Impor sesi dibatasi lokal. Tunggu sebelum mencoba kembali.',
  PROVIDER_COOLDOWN: 'Cooldown feed masih berlaku. Impor tidak dapat melewati batas provider.',
  SCOPE_CHANGED: 'Merchant, toko, atau QRIS berbeda sementara akun memiliki riwayat. Penggantian ditolak.',
  SAVE_FAILED: 'Sesi tidak dapat disimpan. Tidak ada akun diaktifkan.',
};
export class ShopeeConnectError extends Error {
  constructor(code, retryAt) {
    super(messages[code] || messages.SAVE_FAILED);
    this.name = 'ShopeeConnectError';
    this.code = Object.hasOwn(messages, code) ? code : 'SAVE_FAILED';
    this.retryAt = retryAt;
  }
}
const fail = code => { throw new ShopeeConnectError(code); };
function owner(user) {
  if (!config.labUnofficialEnabled || !Number.isSafeInteger(config.labUserId) || config.labUserId <= 0 ||
      user?.id !== config.labUserId || user.role !== 'admin' || user.viaApiKey || typeof user.sid !== 'string' || !user.sid) fail('FORBIDDEN');
  const row = db.prepare(`SELECT u.password_hash,u.updated_at,s.created_at AS session_created_at FROM users u
    JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.role='admin' AND s.id=? AND s.expires_at>?`)
    .get(user.id,user.sid,Date.now());
  if (!row) fail('FORBIDDEN');
  return row;
}
function validate(body) {
  const keys = ['token','merchant_id','store_id','qris_static','password','consent'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(body)) ||
      Reflect.ownKeys(body).length !== keys.length || keys.some(k => !Object.hasOwn(body,k)) ||
      body.consent !== true || typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128 ||
      typeof body.token !== 'string' || !/^B:[\x21-\x7e]{1,4094}$/.test(body.token) ||
      /[;,\%&"'{}\[\]\\]|=[^=]|cookie|SPC_|__shopee|device.?risk|fingerprint|risk.?token|Bearer|^B:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(body.token) ||
      ['merchant_id','store_id'].some(k => typeof body[k] !== 'string' || !/^[1-9][0-9]{0,99}$/.test(body[k])) ||
      typeof body.qris_static !== 'string') fail('INVALID');
  try { staticToDynamicQris(body.qris_static,1); } catch { fail('INVALID'); }
}
function reserve(user) {
  const now = Date.now(), window = 15 * 60000;
  db.exec('BEGIN IMMEDIATE');
  try {
    // device_id is schema-required only: never a device identity or upstream telemetry.
    db.prepare("INSERT OR IGNORE INTO merchant_login_limits(user_id,provider,device_id) VALUES(?,'shopeepay','local-session-import')").run(user.id);
    const row = db.prepare("SELECT * FROM merchant_login_limits WHERE user_id=? AND provider='shopeepay'").get(user.id);
    const sameWindow = now - row.window_at < window;
    if (row.next_at > now || sameWindow && row.attempts >= 5)
      throw new ShopeeConnectError('COOLDOWN',Math.max(row.next_at,sameWindow && row.attempts >= 5 ? row.window_at + window : 0));
    // Three-minute spacing also caps rolling 15-minute windows at five attempts.
    db.prepare("UPDATE merchant_login_limits SET next_at=?,window_at=?,attempts=? WHERE user_id=? AND provider='shopeepay'")
      .run(now + window / 5,sameWindow ? row.window_at : now,sameWindow ? row.attempts + 1 : 1,user.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export async function connectShopee(user, body) {
  // Copy identity, not caller-controlled mutable references across bcrypt's await.
  user = user && {id:user.id,sid:user.sid,role:user.role,viaApiKey:user.viaApiKey};
  const authenticated = owner(user);
  validate(body);
  const {token,merchant_id,store_id,qris_static,password} = body;
  reserve(user);
  if (!(await verifyPassword(password,authenticated.password_hash))) fail('REAUTH');
  let expires_at;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = owner(user);
    if (current.password_hash !== authenticated.password_hash || current.updated_at !== authenticated.updated_at ||
        current.session_created_at !== authenticated.session_created_at) fail('EXPIRED');
    const old = db.prepare("SELECT * FROM payment_accounts WHERE user_id=? AND provider='shopeepay'").get(user.id);
    const now = Date.now(), key = getEncryptionKey();
    if (old?.next_poll_at > now) throw new ShopeeConnectError('PROVIDER_COOLDOWN',old.next_poll_at);
    if (old && db.prepare('SELECT 1 FROM orders WHERE account_id=? UNION ALL SELECT 1 FROM seen_transactions WHERE account_id=? LIMIT 1').get(old.id,old.id)) {
      let prior;
      try { prior = JSON.parse(decrypt(old.credential,key)); } catch {}
      if (!prior || prior.merchant_id !== merchant_id || prior.store_id !== store_id || prior.qris_static !== qris_static) fail('SCOPE_CHANGED');
    }
    // Local revalidation lease only. No provider expiry/ownership/acquirer permission proven.
    expires_at = now + 12 * 3600000;
    const credential = encrypt(JSON.stringify({token,merchant_id,store_id,qris_static,expires_at,expiry_source:'local_lease'}),key);
    if (old) {
      // All checks precede cancellation. Existing pause is deliberate, not auto-resumed.
      pauseLabAccount('shopeepay',user.id);
      const revision = db.prepare('SELECT updated_at FROM payment_accounts WHERE id=?').get(old.id).updated_at;
      db.prepare("UPDATE payment_accounts SET credential=?,credential_source='dashboard',label='ShopeePay',status=?,last_error=NULL,last_validated_at=NULL,updated_at=? WHERE id=?")
        .run(credential,old.status === 'paused' ? 'paused' : 'configured',Math.max(Date.now(),revision + 1),old.id);
    } else db.prepare("INSERT INTO payment_accounts(user_id,provider,label,credential,status,credential_source,created_at,updated_at) VALUES(?,'shopeepay','ShopeePay',?,'configured','dashboard',?,?)")
      .run(user.id,credential,now,now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error instanceof ShopeeConnectError) throw error;
    throw new ShopeeConnectError('SAVE_FAILED');
  }
  return {ok:true,detail:'Sesi disimpan terenkripsi dengan batas lokal 12 jam, bukan masa berlaku dari Shopee. Pemetaan merchant/toko/QRIS dinyatakan manual; kepemilikan dan izin acquirer belum terbukti. Klik Periksa akun untuk validasi; pemeriksaan otomatis belum aktif.',expires_at,expiry_source:'local_lease'};
}
