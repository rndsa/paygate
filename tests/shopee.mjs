// Real isolated SQLite/encryption. Synthetic owner input only; no provider access.
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=path.resolve(import.meta.dirname,'..'), temp=mkdtempSync(path.join(tmpdir(),'paygate-shopee-'));
const nativeFetch=globalThis.fetch;
let db, calls=0;
try {
  cpSync(path.join(root,'src'),path.join(temp,'src'),{recursive:true});
  symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'));
  Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(temp,'db'),PAYGATE_DATA_DIR:temp,ENCRYPTION_KEY:'aa'.repeat(32),LAB_UNOFFICIAL:'1',LAB_USER_ID:'1',GOPAY_ACCESS_TOKEN:'',GOPAY_MERCHANT_ID:'',GOPAY_QRIS_STATIC:'',SHOPEEPAY_TOKEN:'',SHOPEEPAY_MERCHANT_ID:'',SHOPEEPAY_STORE_ID:'',SHOPEEPAY_QRIS_STATIC:''});
  globalThis.fetch=()=>{calls++;throw new Error('Upstream forbidden during import');};
  const load=f=>import(pathToFileURL(path.join(temp,'src',f)));
  ({db}=await load('db/index.js'));
  const {hashPassword,decrypt,encrypt}=await load('lib/crypto.js');
  const {config,getEncryptionKey}=await load('config.js');
  const {crc16ccitt}=await load('lib/qris.js');
  const password='Local-test-pass-123!', now=Date.now(), hash=await hashPassword(password);
  for(const uid of [1,2]) {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(uid,'user'+uid,hash,now,now);
    db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run('session'+uid,uid,now,now+600000);
  }
  const q='00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304', qr=q+crc16ccitt(q);
  const user={id:1,sid:'session1',role:'admin'}, body={token:'B:synthetic-session-only',merchant_id:'123',store_id:'456',qris_static:qr,password,consent:true};
  const shopee=await load('services/shopee.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  assert.equal(typeof shopee.connectShopee,'function','owner session import must exist');
  const account=()=>db.prepare("SELECT * FROM payment_accounts WHERE user_id=1 AND provider='shopeepay'").get();
  const credentials=()=>JSON.parse(decrypt(account().credential,getEncryptionKey()));
  const before=Date.now(), result=await shopee.connectShopee(user,body);
  assert.deepEqual(Object.keys(result).sort(),['detail','expires_at','expiry_source','ok']);
  assert.equal(result.ok,true); assert.equal(result.expiry_source,'local_lease');
  assert.ok(result.expires_at>=before+43200000&&result.expires_at<=Date.now()+43200000);
  assert.match(result.detail,/batas lokal 12 jam/); assert.match(result.detail,/Periksa akun/);
  assert.equal(account().status,'configured'); assert.equal(account().credential_source,'dashboard');
  assert.equal(account().last_validated_at,null); assert.equal(account().next_poll_at,0);
  assert.equal(credentials().token,body.token); assert.equal(credentials().expires_at,result.expires_at);
  assert.equal(credentials().expiry_source,'local_lease');
  for(const secret of [body.token,password,qr]) {
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!account().credential.includes(secret));
  }
  assert.ok(!JSON.stringify(credentials()).includes(password)); assert.equal(calls,0);
  console.log('PASS encrypted configured-only import, safe DTO, explicit local 12h lease, zero upstream');
  const unlock=()=>db.prepare("UPDATE merchant_login_limits SET next_at=0,attempts=0,window_at=0 WHERE provider='shopeepay'").run();
  const denied=async(who,input,code)=>{
    const prior=account();
    await assert.rejects(shopee.connectShopee(who,input),e=>e instanceof shopee.ShopeeConnectError&&e.code===code);
    assert.deepEqual(account(),prior,'denied import must not pause/overwrite account');
  };
  for(const who of [null,{...user,id:2,sid:'session2'},{...user,viaApiKey:true},{...user,role:'viewer'},{...user,sid:'missing'}]) await denied(who,body,'FORBIDDEN');
  config.labUnofficialEnabled=false; await denied(user,body,'FORBIDDEN'); config.labUnofficialEnabled=true;
  config.labUserId=0; await denied(user,body,'FORBIDDEN'); config.labUserId=1;
  db.prepare("UPDATE users SET role='viewer' WHERE id=1").run(); await denied(user,body,'FORBIDDEN'); db.prepare("UPDATE users SET role='admin' WHERE id=1").run();
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now(),user.sid); await denied(user,body,'FORBIDDEN');
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now()+600000,user.sid);
  for(const input of [null,[],{...body,extra:'no'},{...body,consent:'true'},{...body,consent:false},{...body,password:1},{...body,password:'x'.repeat(129)},
    ...['B:','B:a\n','B:a b','B:abc;sid=x','B:{"deviceRisk":"x"}','B:eyJhbGciOiJIUzI1NiJ9.e30.c2ln','eyJ.e30.c2ln','__shopee_partner_website_x_token_live=B:a','B:abc\u007f','B:'+'x'.repeat(4095)].map(token=>({...body,token})),
    ...['0','01','-1','1e3','1.2',' 1','1\n','1\r','1\r\n','1'.repeat(101),123].flatMap(value=>[{...body,merchant_id:value},{...body,store_id:value}]),
    {...body,qris_static:'bad QR'},{...body,qris_static:123},{...body,qris_static:qr.slice(0,-1)+'X'},
    {...body,qris_static:(await load('lib/qris.js')).staticToDynamicQris(qr,1)}]) await denied(user,input,'INVALID');
  unlock(); await denied(user,{...body,password:'wrong-password'},'REAUTH');
  const limit=db.prepare("SELECT * FROM merchant_login_limits WHERE user_id=1 AND provider='shopeepay'").get();
  assert.ok(limit&&limit.attempts===1&&limit.next_at>Date.now(),'password attempt reserves durable local budget');
  const fresh=await import(pathToFileURL(path.join(temp,'src/services/shopee.js'))+'?restart=1');
  await assert.rejects(fresh.connectShopee(user,body),e=>e.code==='COOLDOWN'&&e.retryAt===limit.next_at);
  unlock(); db.prepare("UPDATE merchant_login_limits SET attempts=5,window_at=? WHERE provider='shopeepay'").run(Date.now());
  await denied(user,body,'COOLDOWN');
  assert.equal(account().next_poll_at,0,'import budget never aliases provider budget');
  console.log('PASS exact input contract, live owner/admin/session checks, reauth denial, durable local budget');
  unlock(); db.prepare('UPDATE payment_accounts SET next_poll_at=?,status=?,last_error=? WHERE id=?').run(Date.now()+600000,'blocked','RATE_LIMITED',account().id);
  await denied(user,body,'PROVIDER_COOLDOWN');
  unlock(); db.prepare("UPDATE payment_accounts SET next_poll_at=123,status='active',last_validated_at=?,updated_at=? WHERE id=?").run(Date.now(),Date.now()+10000,account().id);
  let prior=account(); await shopee.connectShopee(user,{...body,token:'B:replacement'});
  assert.equal(account().id,prior.id); assert.equal(account().status,'configured'); assert.equal(account().last_validated_at,null);
  assert.equal(account().next_poll_at,123); assert.ok(account().updated_at>prior.updated_at); assert.equal(credentials().token,'B:replacement');
  const lab=await load('services/lab.js');
  lab.pauseLabAccount('shopeepay',1); unlock(); prior=account(); await shopee.connectShopee(user,body);
  assert.equal(account().status,'paused'); assert.ok(account().updated_at>prior.updated_at); assert.equal(account().next_poll_at,123);
  prior=account(); lab.syncLabAccounts(); assert.deepEqual(account(),prior,'absent env cannot override dashboard');
  Object.assign(config.shopeepayLab,{token:'B:unrelated-env',merchantId:'999',storeId:'888',staticQris:qr});
  lab.syncLabAccounts(); assert.deepEqual(account(),prior,'complete env cannot override dashboard');
  const changedQ=q.replace('PAYGATE LAB','PAYGATE NEW'), changedQr=changedQ+crc16ccitt(changedQ);
  db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at) VALUES(?,?,?,?,?,?)').run('shopeepay','scope-history',account().id,1,now,now);
  for(const change of [{merchant_id:'789'},{store_id:'789'},{qris_static:changedQr}]) {unlock();await denied(user,{...body,...change},'SCOPE_CHANGED');}
  db.prepare('DELETE FROM seen_transactions').run();
  db.prepare('INSERT INTO orders(id,user_id,provider,account_id,amount,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('history',1,'shopeepay',account().id,1,now,now,now);
  for(const change of [{merchant_id:'789'},{store_id:'789'},{qris_static:changedQr}]) {unlock();await denied(user,{...body,...change},'SCOPE_CHANGED');}
  unlock(); await shopee.connectShopee(user,{...body,token:'B:same-scope-renewal'}); assert.equal(account().status,'paused');
  const expired={...credentials(),expires_at:Date.now()-1};
  db.prepare("UPDATE payment_accounts SET credential=?,status='active',last_validated_at=? WHERE id=?").run(encrypt(JSON.stringify(expired),getEncryptionKey()),Date.now(),account().id);
  assert.equal(lab.getLabAccount('shopeepay',1).status,'blocked'); assert.equal(account().last_validated_at,null);
  assert.equal(calls,0);
  console.log('PASS provider cooldown preserved, monotonic replacement, paused retention, immutable historical scope, dashboard authority, local expiry');
  // Bcrypt yields: revoke/change live authorization before final write, without mocks.
  for(const [change,restore,code] of [
    [()=>db.prepare('DELETE FROM sessions WHERE id=?').run(user.sid),()=>db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(user.sid,1,now,Date.now()+600000),'FORBIDDEN'],
    [()=>db.prepare("UPDATE users SET password_hash='changed' WHERE id=1").run(),()=>db.prepare('UPDATE users SET password_hash=? WHERE id=1').run(hash),'EXPIRED'],
    [()=>db.prepare('UPDATE users SET updated_at=updated_at+1 WHERE id=1').run(),()=>db.prepare('UPDATE users SET updated_at=? WHERE id=1').run(now),'EXPIRED'],
    [()=>db.prepare("UPDATE users SET role='viewer' WHERE id=1").run(),()=>db.prepare("UPDATE users SET role='admin' WHERE id=1").run(),'FORBIDDEN']
  ]) {
    unlock(); const unchanged=account(), pending=shopee.connectShopee(user,body); change();
    await assert.rejects(pending,e=>e.code===code); assert.deepEqual(account(),unchanged); restore();
  }
  unlock(); const pending=shopee.connectShopee(user,body);
  db.prepare('UPDATE payment_accounts SET next_poll_at=? WHERE id=?').run(Date.now()+600000,account().id);
  prior=account(); await assert.rejects(pending,e=>e.code==='PROVIDER_COOLDOWN'); assert.deepEqual(account(),prior);
  db.prepare('UPDATE payment_accounts SET next_poll_at=0 WHERE id=?').run(account().id);
  unlock(); const input={...body}, identity={...user}, immutable=shopee.connectShopee(identity,input);
  input.token='B:unvalidated'; input.store_id='999'; identity.id=2;
  await immutable; assert.equal(credentials().token,body.token); assert.equal(credentials().store_id,body.store_id);
  for(const token of ['B:session=value','B:abc,other=value','B:eyJh.e30.signature','B:%7B%22deviceRisk%22%3A%22x%22%7D']) {unlock();await denied(user,{...body,token},'INVALID');}
  unlock(); await shopee.connectShopee(user,{...body,token:'B:'+'x'.repeat(4094)}); assert.equal(credentials().token.length,4096);
  console.log('PASS live revocation/password revision/cooldown races, frozen input, token boundaries');
  // Synthetic, held transport exercises real poll cancellation; no network requests.
  let release, signal, feedCalls=0;
  const poll=lab.pollLabAccount('shopeepay',1,{test:true,fetch:(_url,init)=>{
    feedCalls++; signal=init.signal; return new Promise(r=>release=r);
  }});
  assert.equal(feedCalls,1); assert.equal(signal.aborted,false);
  unlock(); await denied(user,{...body,consent:false},'INVALID'); assert.equal(signal.aborted,false);
  unlock(); await denied(user,{...body,password:'wrong-password'},'REAUTH'); assert.equal(signal.aborted,false);
  unlock(); await denied(user,body,'PROVIDER_COOLDOWN'); assert.equal(signal.aborted,false);
  // Model an elapsed poll lease without sleeping; held request remains in flight.
  db.prepare('UPDATE payment_accounts SET next_poll_at=0 WHERE id=?').run(account().id);
  unlock(); await shopee.connectShopee(user,body); assert.equal(signal.aborted,true);
  release(Response.json({code:0,data:{list:[],next_position:''}}));
  assert.equal((await poll).code,'CANCELLED'); assert.equal(account().status,'configured'); assert.equal(account().last_validated_at,null);
  assert.equal(calls,0); assert.equal(feedCalls,1,'import never calls transport');
  console.log('PASS invalid/reauth/cooldown never cancel feed; valid import aborts old poll without activation');
  // Real SQLite write failure must roll back pause, credential, and revision together.
  db.exec("CREATE TEMP TRIGGER deny_shopee_save BEFORE UPDATE OF credential ON payment_accounts BEGIN SELECT RAISE(ABORT,'SECRET-MUST-NOT-LEAK'); END");
  unlock(); prior=account();
  await assert.rejects(shopee.connectShopee(user,body),e=>e.code==='SAVE_FAILED'&&!e.message.includes('SECRET-MUST-NOT-LEAK'));
  assert.deepEqual(account(),prior); db.exec('DROP TRIGGER deny_shopee_save');
  // Actual five failed reauth attempts, advancing only test clock; sixth denied durably.
  const nativeNow=Date.now, clockStart=nativeNow();
  try {
    unlock();
    for(let i=0;i<5;i++) {
      Date.now=()=>clockStart+i*180000;
      db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now()+3600000,user.sid);
      await denied(user,{...body,password:'wrong-password'},'REAUTH');
    }
    Date.now=()=>clockStart+14*60000;
    await denied(user,body,'COOLDOWN');
    assert.equal(db.prepare("SELECT attempts FROM merchant_login_limits WHERE provider='shopeepay'").get().attempts,5);
  } finally {Date.now=nativeNow;}
  assert.equal(calls,0);
  console.log('PASS atomic save rollback, sanitized DB error, five actual attempts per 15-minute local budget');
} finally {globalThis.fetch=nativeFetch;db?.close();rmSync(temp,{recursive:true,force:true});}
