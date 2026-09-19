import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config, getEncryptionKey } from '../config.js';
import { verifyPassword, encrypt, decrypt } from '../lib/crypto.js';
import { staticToDynamicQris } from '../lib/qris.js';
import { pauseLabAccount } from './lab.js';

// Audited wire contract: merchantid@1fa55b3e1024861ef74968f9cdb1bb1bfb899fea.
// GoBiz /goid/* is the web-dashboard OTP endpoint; without the portal client headers
// (origin/referer/appid/appversion/platform/UA) it answers HTTP 400 at otp_request.
// Owner accepted full portal-header emulation on 2026-09-09. Constants below are the
// public web client's own identifiers — NOT credentials, stolen tokens, or a replayed
// fingerprint. No CAPTCHA/rate-limit/device-binding bypass; challenge handling unchanged.
// Public first-party client ID is not provider-issued permission. Acceptance unverified.
const CLIENT_ID = 'go-biz-web-new', BASE = 'https://api.gobiz.co.id';
const GOPAY_ORIGIN = 'https://portal.gofoodmerchant.co.id';
const GOPAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const TTL = 5 * 60000, MAX_BODY = 1024 * 1024;
const attempts = new Map();
// Server-only log context; never serialized on error objects or sent to the client.
const logContext = new WeakMap();
export const loginLogDetails = error => logContext.get(error) || {};
const messages = {
  FORBIDDEN: 'Login merchant hanya untuk pemilik yang diizinkan dengan sesi PayGate aktif.',
  UNSUPPORTED: 'Metode login ini belum didukung. Gunakan portal resmi provider.',
  INVALID: 'Isian login tidak valid atau persetujuan risiko belum diberikan.',
  REAUTH: 'Password PayGate salah. Ini bukan password merchant.',
  COOLDOWN: 'Login dibatasi. Tunggu sebelum mencoba kembali; jangan mengulang OTP.',
  EXPIRED: 'Percobaan login kedaluwarsa, dibatalkan, atau sesi berubah.',
  BUSY: 'Tahap login sedang diproses atau tidak sesuai.',
  CHALLENGE: 'Provider meminta verifikasi perangkat/CAPTCHA. Berhenti; gunakan aplikasi resmi.',
  AUTH_REJECTED: 'GoBiz menolak permintaan login ini. Coba lagi dengan kanal OTP yang lain (WhatsApp/SMS), atau periksa akun lewat portal resmi GoBiz.',
  PHONE_REJECTED: 'GoBiz menolak permintaan login ini. Ini bukan soal nomornya — server menolak identitas/permintaan. Coba kanal OTP yang lain, lalu cek akun lewat portal resmi GoBiz.',
  PROVIDER_ERROR: 'Layanan GoBiz sedang bermasalah. Tunggu beberapa saat sebelum mencoba kembali; permintaan tidak diulang otomatis.',
  REQUEST_REJECTED: 'Provider menolak permintaan ini. Biasanya karena kode OTP salah/kedaluwarsa atau sesi kode sudah lewat. Minta kode baru lalu masukkan kode terbaru; kalau masih gagal, gunakan portal resmi GoBiz.',
  RATE_LIMITED: 'Provider membatasi login. Berhenti dan tunggu sesuai batas server.',
  BUSINESS_REJECTED: 'Provider menyatakan permintaan OTP tidak berhasil. Penyebab belum diketahui; login tidak diulang otomatis.',
  OTP_INVALID: 'Kode OTP tidak diterima. Kemungkinan salah ketik atau sudah kedaluwarsa. Minta kode baru lalu masukkan kode terbaru dengan cepat.',
  BAD_RESPONSE: 'Hasil login belum dapat diproses. Akun belum dihubungkan. Hubungi administrator jika masalah berlanjut.',
  NETWORK: 'Koneksi login terputus atau timeout. OTP tidak dikirim ulang otomatis.',
  NO_MERCHANT: 'Tidak ditemukan akun merchant dengan QRIS yang dapat digunakan. Periksa akun merchant melalui portal resmi GoBiz.',
  MULTI_OUTLET: 'Merchant dengan lebih dari satu outlet/POP belum didukung; feed tidak membuktikan scope outlet.' ,
  SCOPE_CHANGED: 'Merchant/QRIS berbeda sementara akun memiliki riwayat. Penggantian ditolak.',
  SAVE_FAILED: 'Penyimpanan sesi merchant di PayGate gagal. Penyimpanan tidak diulang otomatis.',
};
export class MerchantLoginError extends Error {
  constructor(code, retryAt, stage, providerStatus=null) {
    super(Object.hasOwn(messages, code) ? messages[code] : messages.BAD_RESPONSE);
    this.code = Object.hasOwn(messages, code) ? code : 'BAD_RESPONSE'; this.retryAt = retryAt;
    if (!stage) {
      const localStages = {INVALID:'local_validation',FORBIDDEN:'local_validation',UNSUPPORTED:'local_validation',COOLDOWN:'cooldown',EXPIRED:'attempt_validation',BUSY:'attempt_validation',SCOPE_CHANGED:'merchant_selection'};
      if (Object.hasOwn(localStages,this.code)) stage = localStages[this.code];
    }
    if (stage) {
      const providerStage = ['otp_request','otp_verify','merchant_discovery'].includes(stage);
      const localStage = ['local_validation','reauth','cooldown','attempt_validation','otp_validation','merchant_selection','merchant_save'].includes(stage);
      this.diagnostic = Object.freeze({
        id: randomUUID(),
        stage: providerStage || localStage ? stage : 'local_validation',
        provider_status: providerStage && Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599 ? providerStatus : null,
        classification: this.code,
      });
    }
  }
}
const fail = code => { throw new MerchantLoginError(code); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const token = x => typeof x === 'string' && x.length > 0 && x.length <= 4096 && /^[\x21-\x7e]+$/.test(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const opaque = () => randomBytes(24).toString('hex');

function owner(user, provider) {
  if (!config.labUnofficialEnabled || user?.id !== config.labUserId || !user.sid || user.viaApiKey ||
      !db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(user.sid, user.id, Date.now())) fail('FORBIDDEN');
  if (provider !== 'gopay') fail(provider === 'shopeepay' ? 'UNSUPPORTED' : 'INVALID');
}
function drop(a) { clearTimeout(a.timer); a.controller.abort(); attempts.delete(a.id); }
function current(user, a) {
  owner(user, a.provider);
  if (attempts.get(a.id) !== a || a.sid !== user.sid || a.userId !== user.id || a.expires <= Date.now()) fail('EXPIRED');
  const password = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash;
  if (password !== a.passwordHash) fail('EXPIRED');
}
function lookup(user, body, step) {
  owner(user, body?.provider);
  const a = typeof body?.attempt_id === 'string' && attempts.get(body.attempt_id);
  if (!a || a.userId !== user.id || a.sid !== user.sid) fail('EXPIRED');
  current(user, a);
  if (a.step !== step) fail('BUSY');
  return a;
}
function reserve(user) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO merchant_login_limits(user_id,provider,device_id) VALUES(?,?,?)').run(user.id, 'gopay', randomUUID());
  const row = db.prepare('SELECT * FROM merchant_login_limits WHERE user_id=? AND provider=?').get(user.id, 'gopay');
  if (row.next_at > now) throw new MerchantLoginError('COOLDOWN', row.next_at);
  const sameWindow = now - row.window_at < 3600000;
  if (sameWindow && row.attempts >= 5) throw new MerchantLoginError('COOLDOWN', row.window_at + 3600000);
  db.prepare('UPDATE merchant_login_limits SET next_at=?,window_at=?,attempts=? WHERE user_id=? AND provider=?')
    .run(now + 120000, sameWindow ? row.window_at : now, sameWindow ? row.attempts + 1 : 1, user.id, 'gopay');
  return row.device_id;
}
function failed(a, error) {
  const safe = error instanceof MerchantLoginError ? error : new MerchantLoginError('BAD_RESPONSE');
  const until = Math.max(Date.now() + 900000, safe.retryAt || 0);
  db.prepare('UPDATE merchant_login_limits SET next_at=MAX(next_at,?) WHERE user_id=? AND provider=?').run(until, a.userId, a.provider);
  drop(a);
  const result = new MerchantLoginError(safe.code, until, a.stage || 'otp_request', a.providerStatus);
  if (a.logContext) logContext.set(result, a.logContext);
  return result;
}
function retryAt(value) {
  let result = Date.now() + 900000;
  for (const v of (value || '').split(/,\s*(?=\d+\s*(?:,|$)|[A-Za-z]{3},)/)) {
    const n = /^\d+$/.test(v.trim()) ? Date.now() + Number(v) * 1000 : Date.parse(v);
    if (Number.isFinite(n)) result = Math.max(result, Math.min(n, Number.MAX_SAFE_INTEGER));
  }
  return result;
}
async function request(a, path, body, access, options) {
  if (!['/goid/login/request', '/goid/token', '/v1/merchants/search'].includes(path)) fail('INVALID');
  a.stage = {'/goid/login/request':'otp_request','/goid/token':'otp_verify','/v1/merchants/search':'merchant_discovery'}[path];
  a.providerStatus = null;
  delete a.logContext;
  const controller = new AbortController();
  const signal = AbortSignal.any([a.controller.signal, controller.signal]);
  let timer, reader;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new MerchantLoginError('NETWORK')); controller.abort(); }, 15000); });
  const cancelled = new Promise((_, reject) => {
    if (signal.aborted) reject(new MerchantLoginError('EXPIRED'));
    else signal.addEventListener('abort', () => reject(new MerchantLoginError('EXPIRED')), {once:true});
  });
  try {
    return await Promise.race([timeout, cancelled, (async () => {
      // GoBiz /goid/* is a web-dashboard endpoint: it rejects (HTTP 400) any request
      // that does not present the portal client identity. Owner accepted full portal-header
      // emulation (2026-09-09). These are public client constants (appid/version/origin/UA),
      // NOT credentials or stolen tokens; no CAPTCHA/rate-limit/device-binding bypass is added.
      // x-uniqueid stays our per-attempt random id; no replay of a captured fingerprint.
      const headers = {
        'Accept':'application/json, text/plain, */*',
        'Accept-Language':'id',
        'Content-Type':'application/json',
        'Authentication-Type':'go-id',
        'Gojek-Country-Code':'ID',
        'Gojek-Timezone':'Asia/Jakarta',
        'Origin':GOPAY_ORIGIN,
        'Referer':GOPAY_ORIGIN + '/',
        'User-Agent':GOPAY_UA,
        'X-AppId':'go-biz-web-dashboard',
        'X-AppVersion':'platform-v3.111.0-1708bc9a',
        'X-DeviceOs':'Web',
        'X-PhoneMake':'Windows 10 64-bit',
        'X-PhoneModel':'Chrome 150.0.0.0 on Windows 10 64-bit',
        'X-Platform':'Web',
        'X-User-Locale':'en-GB',
        'X-User-Type':'merchant',
        'x-uniqueid':a.device
      };
      // GoBiz OTP endpoints (/goid/*) must NOT carry Authorization at all — an empty
      // 'Bearer' is rejected as 401. Only discovery (/v1/merchants/search) sends a real token.
      if (access) headers.Authorization = `Bearer ${access}`;
      const response = await (options.fetch || globalThis.fetch)(BASE + path, {method:'POST', headers, body:JSON.stringify(body), redirect:'manual', credentials:'omit', signal});
      signal.throwIfAborted();
      if (!(response instanceof Response)) fail('BAD_RESPONSE');
      a.providerStatus = response.status;
      if (response.redirected || response.status >= 300 && response.status < 400) fail('CHALLENGE');
      if (response.status === 429) throw new MerchantLoginError('RATE_LIMITED', retryAt(response.headers.get('Retry-After')));
      if (response.status >= 500) fail('PROVIDER_ERROR');
      const rejection = [401,403].includes(response.status) ? 'AUTH_REJECTED' : 'REQUEST_REJECTED';
      // HTTP 400 while verifying an OTP is the provider's "code not accepted" answer
      // (wrong/expired code). Give the user an actionable message instead of the generic one.
      if (response.status === 400 && a.stage === 'otp_verify') fail('OTP_INVALID');
      if (!response.body) fail(response.ok ? 'BAD_RESPONSE' : rejection);
      if (Number(response.headers.get('Content-Length')) > MAX_BODY) fail('BAD_RESPONSE');
      reader = response.body.getReader(); let size = 0; const parts=[];
      while (true) {
        const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        size += next.value.length; if (size > MAX_BODY) fail('BAD_RESPONSE'); parts.push(next.value);
      }
      let text, value;
      try { text = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)); }
      catch { fail('BAD_RESPONSE'); }
      if (/cf-chl-|recaptcha|hcaptcha|"(?:captcha_required|challenge_required)"\s*:\s*true|unusual.device|device.verification|captcha.signature/i.test(text)) fail('CHALLENGE');
      if (!response.ok) {
        // Only the observed unsuccessful OTP envelope gets specific client guidance.
        // Never echo arbitrary provider codes, message/title, body, cookies or tokens.
        // This identifies a login rejection, not the account's registration/lock status.
        if (response.status === 401 && a.stage === 'otp_request') {
          let parsed;
          try { parsed = JSON.parse(text); } catch { /* stay generic */ }
          if (object(parsed) && parsed.success === false && parsed.data === null &&
              Array.isArray(parsed.errors) && parsed.errors.length === 1 &&
              object(parsed.errors[0]) && parsed.errors[0].code === 'goid:error:unauthorized') {
            const rid = response.headers.get('Request-ID') || '';
            a.logContext = Object.freeze({
              event: 'gopay_otp_request_phone_rejected',
              upstream_codes: Object.freeze(['goid:error:unauthorized']),
              upstream_request_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rid) ? rid : null,
            });
            fail('PHONE_REJECTED');
          }
        }
        fail(rejection);
      }
      try { value = JSON.parse(text); } catch { fail('BAD_RESPONSE'); }
      if (!object(value)) fail('BAD_RESPONSE');
      return value;
    })()]);
  } catch (error) {
    if (error instanceof MerchantLoginError) throw error;
    throw new MerchantLoginError(signal.aborted ? 'EXPIRED' : 'NETWORK');
  } finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(()=>{}); }
}

export async function startLogin(user, body, options={}) {
  owner(user, body?.provider);
  if (body.consent !== true || typeof body.phone !== 'string' || !/^(?:\+62|62|0)8\d{7,11}$/.test(body.phone) ||
      typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) fail('INVALID');
  // User picks the OTP channel. wire values: 'whatsapp' -> login_type=whatsapp (accepted),
  // 'sms' -> login_type=sms. The legacy value login_type=otp_whatsapp now returns
  // HTTP 401 goid:error:unauthorized ("Harap perbarui versi aplikasi resmi Anda") and is
  // no longer sent. GoBiz may still override the channel server-side; we report what it chose.
  const channel = body.otp_channel === undefined || body.otp_channel === null || body.otp_channel === '' ? 'whatsapp' : body.otp_channel;
  if (channel !== 'whatsapp' && channel !== 'sms') throw new MerchantLoginError('INVALID', undefined, 'local_validation');
  const device = reserve(user);
  for (const old of attempts.values()) if (old.userId === user.id && old.provider === body.provider) drop(old);
  const a = {id:opaque(), userId:user.id, sid:user.sid, provider:'gopay', device, step:'reauth', stage:'reauth', providerStatus:null, expires:Date.now()+TTL, controller:new AbortController(),
    passwordHash:db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash};
  a.timer = setTimeout(()=>drop(a),TTL); a.timer.unref(); attempts.set(a.id,a);
  try {
    if (!(await verifyPassword(body.password,a.passwordHash))) fail('REAUTH');
    current(user,a);
    const phone = body.phone.replace(/^(?:\+62|62|0)/,'');
    const r = await request(a,'/goid/login/request',{client_id:CLIENT_ID,phone_number:phone,country_code:'62',login_type:channel},null,options);
    current(user,a);
    // Audited authClient.ts requestOtp/assertSuccess; never surface upstream errors[].
    if (r.success === false) fail('BUSINESS_REJECTED');
    const challenge = r.data?.otp_token ?? r.data?.token;
    if (r.success !== true || !token(challenge)) fail('BAD_RESPONSE');
    a.challenge=challenge; a.step='otp';
    const rawChannel = r.data?.next_state?.state;
    // next_state.state may be a list like "sms,whatsapp"; keep it honest instead of
    // pretending we know the channel when the provider did not commit to one.
    a.channel = typeof rawChannel === 'string' && /^(sms|whatsapp)(,(sms|whatsapp))*$/.test(rawChannel) ? rawChannel : null;
    return {ok:true,attempt_id:a.id,step:'otp',expires_at:a.expires,channel:a.channel};
  } catch (error) { throw failed(a,error); }
}
export async function verifyLogin(user, body, options={}) {
  const a = lookup(user,body,'otp');
  if (typeof body.otp !== 'string' || !/^\d{4,10}$/.test(body.otp)) throw new MerchantLoginError('INVALID',undefined,'otp_validation');
  a.step='verifying';
  try {
    const r = await request(a,'/goid/token',{client_id:CLIENT_ID,data:{otp:body.otp,otp_token:a.challenge},grant_type:'otp'},null,options);
    current(user,a); delete a.challenge;
    // Live GoID answers 201 with token_type "GoBearer"; the audited source contract also
    // tolerates an absent token_type (defaults Bearer) and an absent expires_in (defaults
    // ~30 min). The scheme is never replayed downstream -- discovery always sends
    // `Bearer <access_token>` -- so only a bounded shape is enforced, not an exact literal.
    const tokenType = r.token_type === undefined ? 'Bearer' : r.token_type;
    const expiresIn = r.expires_in === undefined ? 1800 : r.expires_in;
    if (!token(r.access_token) || (r.refresh_token !== undefined && !token(r.refresh_token)) ||
        !(typeof tokenType === 'string' && /^[A-Za-z][A-Za-z0-9]{0,19}$/.test(tokenType)) ||
        !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 86400*30) fail('BAD_RESPONSE');
    a.access=r.access_token; a.refresh=r.refresh_token || ''; a.tokenExpires=Date.now()+expiresIn*1000;
    const result = await request(a,'/v1/merchants/search',{from:0,size:200,_source:['id','merchant_name','outlet_name','pops']},a.access,options);
    current(user,a);
    if (result.success === false || !Array.isArray(result.hits) || result.hits.length > 200 ||
        (result.total !== undefined && (!Number.isSafeInteger(result.total) || result.total < result.hits.length || result.total > 200))) fail('BAD_RESPONSE');
    const choices = new Map(), scopes = new Set();
    for (const merchant of result.hits) {
      if (!object(merchant) || !id(merchant.id) || !Array.isArray(merchant.pops)) fail('BAD_RESPONSE');
      // ponytail: merchant-wide feed, only one POP allowed; widen after audited outlet filtering.
      if (merchant.pops.length > 1) fail('MULTI_OUTLET');
      for (const pop of merchant.pops) {
        const qr = pop?.gopay?.aspi_qr_string;
        if (!qr) continue;
        if (!id(pop.pop_id) || scopes.has(merchant.id+':'+pop.pop_id)) fail('BAD_RESPONSE');
        scopes.add(merchant.id+':'+pop.pop_id);
        try { staticToDynamicQris(qr,1); } catch { continue; }
        if (choices.size >= 200) fail('BAD_RESPONSE');
        const label = [merchant.merchant_name,merchant.outlet_name,pop.name].filter(v=>typeof v==='string').join(' · ').replace(/[\x00-\x1f\x7f]/g,'').slice(0,160) || 'Merchant';
        choices.set(opaque(),{label,merchant_id:merchant.id,qris_static:qr,outlet_id:pop.pop_id});
      }
    }
    if (!choices.size) fail('NO_MERCHANT');
    a.choices=choices; a.step='merchant';
    return {ok:true,attempt_id:a.id,step:'merchant',merchants:[...choices].map(([id,{label}])=>({id,label}))};
  } catch (error) { throw failed(a,error); }
}
export async function finishLogin(user, body) {
  const a = lookup(user,body,'merchant'), choice = a.choices.get(body.merchant);
  if (!choice) throw new MerchantLoginError('INVALID',undefined,'merchant_selection');
  if (a.tokenExpires <= Date.now()) { drop(a); fail('EXPIRED'); }
  try {
    const old=db.prepare('SELECT * FROM payment_accounts WHERE user_id=? AND provider=?').get(user.id,a.provider);
    if (old) {
      const prior=JSON.parse(decrypt(old.credential,getEncryptionKey()) || 'null');
      const history=db.prepare('SELECT 1 FROM orders WHERE account_id=? UNION ALL SELECT 1 FROM seen_transactions WHERE account_id=? LIMIT 1').get(old.id,old.id);
      if (history && (!prior || prior.merchant_id!==choice.merchant_id || prior.outlet_id!==choice.outlet_id || prior.qris_static!==choice.qris_static)) fail('SCOPE_CHANGED');
      pauseLabAccount(a.provider,user.id);
    }
    const c={access_token:a.access,refresh_token:a.refresh,expires_at:a.tokenExpires,device_id:a.device,merchant_id:choice.merchant_id,outlet_id:choice.outlet_id,qris_static:choice.qris_static};
    const blob=encrypt(JSON.stringify(c),getEncryptionKey()), now=Date.now();
    if (old) db.prepare("UPDATE payment_accounts SET credential=?,credential_source='dashboard',label=?,status='configured',last_error=NULL,last_validated_at=NULL,updated_at=? WHERE id=?")
      .run(blob,choice.label,Math.max(now,old.updated_at+2),old.id);
    else db.prepare("INSERT INTO payment_accounts(user_id,provider,label,credential,status,credential_source,created_at,updated_at) VALUES(?,?,?,?,'configured','dashboard',?,?)")
      .run(user.id,a.provider,choice.label,blob,now,now);
  } catch (error) {
    if (error instanceof MerchantLoginError) throw error;
    throw new MerchantLoginError('SAVE_FAILED',undefined,'merchant_save');
  }
  drop(a);
  return {ok:true,detail:'Sesi merchant tersimpan terenkripsi. Klik Periksa akun untuk validasi; pemeriksaan otomatis belum aktif.'};
}
export function cancelLogin(user,body) {
  owner(user,body?.provider);
  const a=attempts.get(body?.attempt_id);
  if (a && a.userId===user.id && a.sid===user.sid) drop(a);
  return {ok:true};
}
export function stopLogins() { for (const a of attempts.values()) drop(a); }
