import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config, ROOT, getEncryptionKey } from '../config.js';
import { verifyPassword, encrypt, decrypt } from '../lib/crypto.js';
import { staticToDynamicQris } from '../lib/qris.js';
import { pauseLabAccount } from './lab.js';

// Private newline-JSON IPC: cmd start{identifier,merchant_password}, verify{otp}, cancel{}.
// Stdout: {ok:true,step:'otp'} or authenticated{credential,stores}; errors contain code only.
// No shell, browser identity spoofing, direct login requests, telemetry or credential files.
const PYTHON = process.env.SHOPEE_BROWSER_PYTHON || '/opt/paygate-browser/bin/python';
const SCRIPT = path.join(ROOT,'src/services/shopee_browser.py');
const TTL=300000, WINDOW=3600000, MAX_BODY=1024*1024;
const attempts=new Map();
const messages={
  FORBIDDEN:'Login merchant hanya untuk pemilik admin dengan sesi PayGate aktif.',
  INVALID:'Isian login tidak valid atau persetujuan belum diberikan.',
  REAUTH:'Password PayGate salah. Ini bukan password merchant.',
  EXPIRED:'Percobaan kedaluwarsa, dibatalkan, atau sesi/password PayGate berubah.',
  BUSY:'Tahap login sedang diproses atau tidak sesuai.',
  COOLDOWN:'Login dibatasi lokal. Tunggu; jangan mengulang OTP.',
  CHALLENGE:'Shopee meminta CAPTCHA atau persetujuan perangkat. Berhenti; verifikasi melalui portal resmi.',
  AUTH_REJECTED:'Shopee menolak login. Tidak ada pengulangan otomatis.',
  RATE_LIMITED:'Shopee membatasi login. Berhenti dan tunggu.',
  NETWORK:'Browser login terputus atau timeout. Tidak ada pengulangan otomatis.',
  BAD_RESPONSE:'Hasil browser tidak membuktikan sesi merchant dan toko yang valid.',
  UNSUPPORTED:'Tahap login ini belum didukung. Tidak ada akun yang diaktifkan.',
  RUNTIME_UNAVAILABLE:'Login ShopeePay belum tersedia di server ini. Hubungi administrator.',
  NO_MERCHANT:'Tidak ditemukan merchant/toko tervalidasi dalam browser.',
  PROVIDER_COOLDOWN:'Cooldown feed masih berlaku; login tidak dapat melewatinya.',
  SCOPE_CHANGED:'Merchant, toko, atau QRIS berbeda sementara akun memiliki riwayat.',
  SAVE_FAILED:'Sesi tidak dapat disimpan. Tidak ada akun diaktifkan.',
};
export class ShopeeLoginError extends Error {
  constructor(code,retryAt) { super(messages[code] || messages.BAD_RESPONSE); this.code=Object.hasOwn(messages,code)?code:'BAD_RESPONSE'; this.retryAt=retryAt; }
}
const fail=code=>{throw new ShopeeLoginError(code);};
const opaque=()=>randomBytes(24).toString('hex');
const object=v=>v && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
function exact(v,keys) {
  if(!object(v) || Reflect.ownKeys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k))) fail('INVALID');
}
const identity=user=>user && ({id:user.id,sid:user.sid,role:user.role,viaApiKey:user.viaApiKey});
function owner(user) {
  if(!config.labUnofficialEnabled || !Number.isSafeInteger(config.labUserId) || config.labUserId<=0 ||
      user?.id!==config.labUserId || user.role!=='admin' || user.viaApiKey || typeof user.sid!=='string' || !user.sid) fail('FORBIDDEN');
  const row=db.prepare(`SELECT u.password_hash,u.updated_at,s.created_at AS session_created_at FROM users u
    JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.role='admin' AND s.id=? AND s.expires_at>?`).get(user.id,user.sid,Date.now());
  if(!row) fail('FORBIDDEN');
  return row;
}
function current(a) {
  if(attempts.get(a.id)!==a || a.expires<=Date.now()) fail('EXPIRED');
  const row=owner(a.user);
  if(Object.keys(a.revision).some(k=>row[k]!==a.revision[k])) fail('EXPIRED');
}
function signalGroup(child,signal) {
  if(!child?.pid) return;
  try { process.kill(-child.pid,signal); } catch { try { child.kill(signal); } catch {} }
}
function drop(a,code='EXPIRED') {
  if(attempts.get(a.id)!==a) return;
  attempts.delete(a.id); clearTimeout(a.timer); clearInterval(a.watchdog);
  a.pending?.reject(new ShopeeLoginError(code)); a.pending=null; a.output='';
  delete a.credential; a.choices?.clear(); delete a.choices;
  const child=a.child; delete a.child;
  if(child) {
    try { child.stdin.end('{"cmd":"cancel"}\n'); } catch {}
    signalGroup(child,'SIGTERM');
    const kill=setTimeout(()=>signalGroup(child,'SIGKILL'),1000); kill.unref();
    child.once('close',()=>clearTimeout(kill));
  }
}
function safeFailure(a,error) {
  const safe=error instanceof ShopeeLoginError?error:new ShopeeLoginError('BAD_RESPONSE');
  drop(a,safe.code);
  return safe;
}
function reserve(user) {
  const now=Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Required legacy column is local bookkeeping, never a browser/device identity.
    db.prepare("INSERT OR IGNORE INTO merchant_login_limits(user_id,provider,device_id) VALUES(?,'shopeepay','local-browser-login')").run(user.id);
    const row=db.prepare("SELECT * FROM merchant_login_limits WHERE user_id=? AND provider='shopeepay'").get(user.id);
    const same=now-row.window_at<WINDOW;
    if(row.next_at>now || same && row.attempts>=5) throw new ShopeeLoginError('COOLDOWN',Math.max(row.next_at,same&&row.attempts>=5?row.window_at+WINDOW:0));
    // Twelve-minute spacing caps rolling one-hour windows at five starts, across restarts.
    db.prepare("UPDATE merchant_login_limits SET next_at=?,window_at=?,attempts=? WHERE user_id=? AND provider='shopeepay'")
      .run(now+WINDOW/5,same?row.window_at:now,same?row.attempts+1:1,user.id);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
export function shopeeBrowserAvailable() {
  try { if(!path.isAbsolute(PYTHON)) return false; accessSync(PYTHON,constants.X_OK); accessSync(SCRIPT,constants.R_OK); return true; }
  catch { return false; }
}
function launch(a,options) {
  // Test-only injection lives at service boundary; router never passes options or request overrides.
  const command=options.workerCommand || {file:PYTHON,args:['-I','-u',SCRIPT]};
  if(!path.isAbsolute(command.file) || !Array.isArray(command.args) || command.args.some(v=>typeof v!=='string')) fail('RUNTIME_UNAVAILABLE');
  if(!options.workerCommand && !shopeeBrowserAvailable()) fail('RUNTIME_UNAVAILABLE');
  a.timeoutMs=options.workerCommand && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs>0?Math.min(options.timeoutMs,90000):90000;
  a.child=spawn(command.file,command.args,{shell:false,detached:true,cwd:ROOT,stdio:['pipe','pipe','ignore'],
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME || '/tmp',LANG:'C.UTF-8',PYTHONUNBUFFERED:'1',PLAYWRIGHT_BROWSERS_PATH:'/opt/paygate-browser/browsers'}});
  a.output='';
  a.child.stdout.setEncoding('utf8');
  a.child.stdout.on('data',chunk=>{
    if(attempts.get(a.id)!==a) return;
    a.output+=chunk;
    if(Buffer.byteLength(a.output)>MAX_BODY) return drop(a,'BAD_RESPONSE');
    const end=a.output.indexOf('\n');
    if(end<0) return;
    const line=a.output.slice(0,end); a.output=a.output.slice(end+1);
    if(!a.pending || a.output.trim()) return drop(a,'BAD_RESPONSE');
    let value;
    try { value=JSON.parse(line); } catch { return drop(a,'BAD_RESPONSE'); }
    const pending=a.pending; a.pending=null; a.output=''; pending.resolve(value);
  });
  a.child.on('error',()=>drop(a,'RUNTIME_UNAVAILABLE'));
  a.child.stdin.on('error',()=>drop(a,'NETWORK'));
  a.child.on('exit',()=>{if(a.pending || a.step==='otp') drop(a,'NETWORK');});
}
function exchange(a,command) {
  let timer;
  const pending=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>drop(a,'NETWORK'),a.timeoutMs); timer.unref();
    let buffer;
    try {
      buffer=Buffer.from(JSON.stringify(command)+'\n');
      for(const key of Object.keys(command)) delete command[key];
      a.pending={resolve,reject};
      a.child.stdin.write(buffer,()=>buffer.fill(0));
    } catch { buffer?.fill(0); drop(a,'NETWORK'); reject(new ShopeeLoginError('NETWORK')); }
  });
  return pending.finally(()=>clearTimeout(timer));
}
const numericId=v=>typeof v==='string' && /^[1-9][0-9]{0,99}$/.test(v);
function validToken(v) {
  return typeof v==='string' && /^B:[\x21-\x7e]{1,4094}$/.test(v) &&
    !/[;,\%&"'{}\[\]\\]|=[^=]|cookie|SPC_|__shopee|device.?risk|fingerprint|risk.?token|Bearer|^B:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(v);
}
function validQr(value) {
  if(typeof value!=='string' || value.length>4096) return false;
  try { staticToDynamicQris(value,1); return true; } catch { return false; }
}
function workerResult(a,result) {
  if(!object(result)) fail('BAD_RESPONSE');
  if(result.ok===false) {
    const codes={CHALLENGE:'CHALLENGE',CHALLENGE_REQUIRED:'CHALLENGE',AUTH_REJECTED:'AUTH_REJECTED',
      RATE_LIMITED:'RATE_LIMITED',NETWORK:'NETWORK',TIMEOUT:'NETWORK',BAD_RESPONSE:'BAD_RESPONSE',
      UNSUPPORTED:'UNSUPPORTED',FORM_UNAVAILABLE:'UNSUPPORTED',RUNTIME_UNAVAILABLE:'RUNTIME_UNAVAILABLE',
      NO_MERCHANT:'NO_MERCHANT',PROFILE_NOT_OBSERVED:'NO_MERCHANT',STORES_NOT_OBSERVED:'NO_MERCHANT',STORES_INCOMPLETE:'NO_MERCHANT',
      PROFILE_REJECTED:'AUTH_REJECTED',STORES_REJECTED:'AUTH_REJECTED',METADATA_INVALID:'BAD_RESPONSE',SCOPE_INVALID:'BAD_RESPONSE'};
    fail(Object.hasOwn(codes,result.code)?codes[result.code]:'BAD_RESPONSE');
  }
  if(result.ok!==true) fail('BAD_RESPONSE');
  if(result.step==='otp' && a.step==='starting' && Object.keys(result).length===2) {
    a.step='otp';
    return {ok:true,step:'otp',attempt_id:a.id,expires_at:a.expires};
  }
  if(result.step!=='authenticated' || Object.keys(result).sort().join(',')!=='credential,ok,step,stores') fail('BAD_RESPONSE');
  const c=result.credential;
  if(!object(c) || Object.keys(c).sort().join(',')!=='account_id,expires_at,merchant_id,token' ||
      !validToken(c.token) || !numericId(c.account_id) || !numericId(c.merchant_id) ||
      !Number.isSafeInteger(c.expires_at) || c.expires_at<=Date.now()) fail('BAD_RESPONSE');
  // Worker must bind stores to verified GetUserInfo merchant/account. Cookie/JWT alone is insufficient.
  // ponytail: no private API fallback; missing captured metadata fails closed until audited browser support exists.
  if(!Array.isArray(result.stores) || result.stores.length>200) fail('BAD_RESPONSE');
  if(!result.stores.length) fail('NO_MERCHANT');
  const choices=new Map(), seen=new Set();
  for(const store of result.stores) {
    if(!object(store) || Object.keys(store).some(k=>!['store_id','label','qris_static'].includes(k)) || !numericId(store.store_id) || seen.has(store.store_id) ||
        typeof store.label!=='string' || !store.label.trim() || store.label.length>160 || /[\x00-\x1f\x7f]/.test(store.label) ||
        Object.hasOwn(store,'qris_static') && !validQr(store.qris_static)) fail('BAD_RESPONSE');
    seen.add(store.store_id); choices.set(opaque(),{...store});
  }
  a.credential={...c}; a.choices=choices; a.step='store';
  a.expires=Math.min(a.expires,c.expires_at);
  return {ok:true,step:'store',attempt_id:a.id,choices:[...choices].map(([id,{label}])=>({id,label})),expires_at:a.expires};
}
export async function startShopeeLogin(user,body,options={}) {
  let merchantPassword,paygatePassword,a;
  try {
    user=identity(user); const revision=owner(user);
    exact(body,['identifier','merchant_password','password','consent']);
    if(body.consent!==true || typeof body.identifier!=='string' || !body.identifier.trim() || body.identifier.length>254 || /[\x00-\x20\x7f]/.test(body.identifier) ||
        typeof body.merchant_password!=='string' || !body.merchant_password || body.merchant_password.length>128 || /[\x00\r\n]/.test(body.merchant_password) ||
        typeof body.password!=='string' || body.password.length<8 || body.password.length>128) fail('INVALID');
    const identifier=body.identifier; merchantPassword=body.merchant_password; paygatePassword=body.password;
    delete body.merchant_password; delete body.password; body=null;
    for(const old of attempts.values()) {
      try { current(old); } catch { drop(old); }
      if(attempts.has(old.id) && old.user.id===user.id) fail('BUSY');
    }
    reserve(user);
    a={id:opaque(),user,revision,step:'reauth',expires:Date.now()+TTL}; attempts.set(a.id,a);
    a.timer=setTimeout(()=>drop(a),TTL); a.timer.unref();
    a.watchdog=setInterval(()=>{try {current(a);} catch {drop(a);}},1000); a.watchdog.unref();
    const valid=await verifyPassword(paygatePassword,revision.password_hash); paygatePassword=null;
    current(a); if(!valid) fail('REAUTH');
    launch(a,options); a.step='starting';
    const pending=exchange(a,{cmd:'start',identifier,merchant_password:merchantPassword}); merchantPassword=null;
    const result=await pending; current(a);
    return workerResult(a,result);
  } catch(error) { if(a) throw safeFailure(a,error); throw error instanceof ShopeeLoginError?error:new ShopeeLoginError('BAD_RESPONSE'); }
  finally { merchantPassword=null; paygatePassword=null; if(object(body)) {delete body.password;delete body.merchant_password;} }
}
function lookup(user,attemptId,step) {
  user=identity(user); owner(user);
  const a=typeof attemptId==='string' && /^[a-f0-9]{48}$/.test(attemptId) && attempts.get(attemptId);
  if(!a || a.user.id!==user.id || a.user.sid!==user.sid) fail('EXPIRED');
  try {current(a);} catch(error) {throw safeFailure(a,error);}
  if(a.step!==step) fail('BUSY');
  return a;
}
export async function verifyShopeeLogin(user,body) {
  let a;
  try {
    exact(body,['attempt_id','otp']); a=lookup(user,body.attempt_id,'otp');
    if(typeof body.otp!=='string' || !/^[0-9]{6}$/.test(body.otp)) fail('INVALID');
    a.step='verifying';
    const pending=exchange(a,{cmd:'verify',otp:body.otp}); delete body.otp; body=null;
    const result=await pending; current(a);
    return workerResult(a,result);
  } catch(error) { if(a) throw safeFailure(a,error); throw error; }
  finally {if(object(body)) delete body.otp;}
}
export async function finishShopeeLogin(user,body) {
  let a;
  try {
    exact(body,['attempt_id','choice','qris_static']); a=lookup(user,body.attempt_id,'store');
    const choice=typeof body.choice==='string' && a.choices.get(body.choice);
    if(!choice || typeof body.qris_static!=='string') fail('INVALID');
    // Empty means use browser-captured QR. Client cannot override a captured QR.
    const qr=choice.qris_static || body.qris_static;
    if(choice.qris_static && body.qris_static && body.qris_static!==choice.qris_static || !validQr(qr)) fail('INVALID');
    a.step='saving';
    db.exec('BEGIN IMMEDIATE');
    let expires_at,expiry_source;
    try {
      current(a);
      const now=Date.now(), key=getEncryptionKey(), c=a.credential;
      const old=db.prepare("SELECT * FROM payment_accounts WHERE user_id=? AND provider='shopeepay'").get(a.user.id);
      if(old?.next_poll_at>now) throw new ShopeeLoginError('PROVIDER_COOLDOWN',old.next_poll_at);
      if(old && db.prepare('SELECT 1 FROM orders WHERE account_id=? UNION ALL SELECT 1 FROM seen_transactions WHERE account_id=? LIMIT 1').get(old.id,old.id)) {
        let prior; try {prior=JSON.parse(decrypt(old.credential,key));} catch {}
        if(!prior || prior.merchant_id!==c.merchant_id || prior.store_id!==choice.store_id || prior.qris_static!==qr) fail('SCOPE_CHANGED');
      }
      expires_at=Math.min(c.expires_at,now+12*3600000);
      expiry_source=c.expires_at<=now+12*3600000?'provider':'local_lease';
      const credential=encrypt(JSON.stringify({...c,store_id:choice.store_id,qris_static:qr,expires_at,expiry_source}),key);
      if(old) {
        pauseLabAccount('shopeepay',a.user.id);
        const revision=db.prepare('SELECT updated_at FROM payment_accounts WHERE id=?').get(old.id).updated_at;
        db.prepare("UPDATE payment_accounts SET credential=?,credential_source='dashboard',label=?,status=?,last_error=NULL,last_validated_at=NULL,updated_at=? WHERE id=?")
          .run(credential,choice.label,old.status==='paused'?'paused':'configured',Math.max(Date.now(),revision+1),old.id);
      } else db.prepare("INSERT INTO payment_accounts(user_id,provider,label,credential,status,credential_source,created_at,updated_at) VALUES(?,'shopeepay',?,?,'configured','dashboard',?,?)")
        .run(a.user.id,choice.label,credential,now,now);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error instanceof ShopeeLoginError?error:new ShopeeLoginError('SAVE_FAILED'); }
    drop(a);
    return {ok:true,expires_at,expiry_source,detail:'Sesi disimpan terenkripsi; batas waktu paling lama 12 jam. QRIS tetap perlu cocok dengan toko. Klik Periksa akun untuk validasi; pemeriksaan otomatis belum aktif.'};
  } catch(error) { if(a) throw safeFailure(a,error); throw error; }
  finally {if(object(body)) delete body.qris_static;}
}
export function cancelShopeeLogin(user,body) {
  user=identity(user); owner(user); exact(body,['attempt_id']);
  if(typeof body.attempt_id!=='string' || !/^[a-f0-9]{48}$/.test(body.attempt_id)) fail('INVALID');
  const a=attempts.get(body.attempt_id);
  if(a && a.user.id===user.id && a.user.sid===user.sid) drop(a);
  return {ok:true};
}
export function stopShopeeLogins() { for(const a of attempts.values()) drop(a); }
