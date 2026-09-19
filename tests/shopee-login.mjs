// Synthetic child process + real isolated SQLite/bcrypt/AES/HTTP. Never provider access.
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv[2] === '--worker') {
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: process.stdin });
  const mode=process.argv[3] || 'otp';
  const result=()=>{
    const value={ok:true,step:'authenticated',credential:{token:'B:synthetic-token',account_id:'123',merchant_id:'456',expires_at:Date.now()+(mode==='lease'?86400000:3600000)},stores:[{store_id:'789',label:'Synthetic store'}]};
    const changes=mode.startsWith('json:')?JSON.parse(Buffer.from(mode.slice(5),'base64url').toString()):{};
    return {...value,...changes,credential:{...value.credential,...changes.credential}};
  };
  for await (const line of lines) {
    const command = JSON.parse(line);
    if (command.cmd === 'cancel') process.exit(0);
    if (command.cmd === 'start') {
      if (Object.keys(command).sort().join(',') !== 'cmd,identifier,merchant_password' ||
          command.identifier !== 'synthetic@example.invalid' || command.merchant_password !== 'Synthetic-merchant-secret!') process.exit(2);
      if(mode==='hang') continue;
      if(mode==='malformed') {process.stdout.write('secret provider debug not JSON\n'); continue;}
      if(mode==='oversize') {process.stdout.write('x'.repeat(1048577)); continue;}
      if(mode==='duplicate') {process.stdout.write('{"ok":true,"step":"otp"}\n{"ok":true,"step":"otp"}\n');continue;}
      if(mode==='exit') process.exit(9);
      process.stdout.write(JSON.stringify(mode==='otp'?{ok:true,step:'otp'}:result())+'\n');
    } else if(command.cmd==='verify') {
      if(Object.keys(command).sort().join(',')!=='cmd,otp' || command.otp!=='123456') process.exit(2);
      process.stdout.write(JSON.stringify(result())+'\n');
    }
  }
  process.exit(0);
}

const root=path.resolve(import.meta.dirname,'..'), temp=mkdtempSync(path.join(tmpdir(),'paygate-shopee-login-'));
const environment={...process.env}, nativeFetch=globalThis.fetch;
let db, shopee, calls=0;
const nativeSpawn=childProcess.spawn, children=[];
childProcess.spawn=(...args)=>{const child=nativeSpawn(...args);children.push({child,args});return child;};
syncBuiltinESMExports();
const waitFor=async test=>{
  const deadline=Date.now()+4000;
  while(!test()) {if(Date.now()>deadline) assert.fail('condition timeout');await new Promise(r=>setTimeout(r,10));}
};
try {
  cpSync(path.join(root,'src'),path.join(temp,'src'),{recursive:true});
  symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'));
  Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(temp,'db'),PAYGATE_DATA_DIR:temp,ENCRYPTION_KEY:'aa'.repeat(32),LAB_UNOFFICIAL:'1',LAB_USER_ID:'1',GOPAY_ACCESS_TOKEN:'',GOPAY_MERCHANT_ID:'',GOPAY_QRIS_STATIC:'',SHOPEEPAY_TOKEN:'',SHOPEEPAY_MERCHANT_ID:'',SHOPEEPAY_STORE_ID:'',SHOPEEPAY_QRIS_STATIC:''});
  globalThis.fetch=()=>{calls++;throw new Error('No provider calls permitted');};
  const load=f=>import(pathToFileURL(path.join(temp,'src',f)));
  ({db}=await load('db/index.js'));
  const {hashPassword}=await load('lib/crypto.js');
  const password='Synthetic-PayGate-secret!', hash=await hashPassword(password), now=Date.now();
  db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,?,?,?,?)').run('owner',hash,now,now);
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,1,?,?)').run('session1',now,now+7200000);
  const user={id:1,sid:'session1',role:'admin'};
  const input=()=>({identifier:'synthetic@example.invalid',merchant_password:'Synthetic-merchant-secret!',password,consent:true});
  const options={workerCommand:{file:process.execPath,args:[fileURLToPath(import.meta.url),'--worker']}};
  shopee=await load('services/shopee-login.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  assert.equal(typeof shopee.startShopeeLogin,'function','browser login service must exist');
  const body=input(), result=await shopee.startShopeeLogin(user,body,options);
  assert.deepEqual(Object.keys(result).sort(),['attempt_id','expires_at','ok','step']);
  assert.equal(result.ok,true); assert.equal(result.step,'otp'); assert.match(result.attempt_id,/^[a-f0-9]{48}$/);
  assert.ok(result.expires_at>Date.now()&&result.expires_at<=Date.now()+300000);
  assert.equal(body.password,undefined); assert.equal(body.merchant_password,undefined);
  const limit=db.prepare("SELECT * FROM merchant_login_limits WHERE provider='shopeepay' AND user_id=1").get();
  assert.equal(limit.attempts,1); assert.ok(limit.next_at>Date.now());
  assert.equal(calls,0);
  console.log('PASS real child OTP IPC, ephemeral passwords, safe DTO, durable reservation');
  assert.equal(typeof shopee.verifyShopeeLogin,'function','OTP verification must exist');
  const otp={attempt_id:result.attempt_id,otp:'123456'};
  const selected=await shopee.verifyShopeeLogin(user,otp);
  assert.equal(otp.otp,undefined);
  assert.deepEqual(Object.keys(selected).sort(),['attempt_id','choices','expires_at','ok','step']);
  assert.equal(selected.step,'store'); assert.equal(selected.choices.length,1);
  assert.deepEqual(Object.keys(selected.choices[0]).sort(),['id','label']);
  assert.match(selected.choices[0].id,/^[a-f0-9]{48}$/); assert.equal(selected.choices[0].label,'Synthetic store');
  assert.ok(!JSON.stringify(selected).includes('B:synthetic-token')); assert.ok(!JSON.stringify(selected).includes('merchant_id'));
  assert.equal(typeof shopee.finishShopeeLogin,'function','configured-only finish must exist');
  const {crc16ccitt}=await load('lib/qris.js'), {decrypt}=await load('lib/crypto.js'), {getEncryptionKey}=await load('config.js');
  const q='00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304', qr=q+crc16ccitt(q);
  const finish=await shopee.finishShopeeLogin(user,{attempt_id:selected.attempt_id,choice:selected.choices[0].id,qris_static:qr});
  assert.equal(finish.ok,true); assert.equal(finish.expiry_source,'provider');
  const account=()=>db.prepare("SELECT * FROM payment_accounts WHERE provider='shopeepay' AND user_id=1").get();
  const credentials=()=>JSON.parse(decrypt(account().credential,getEncryptionKey()));
  assert.equal(account().status,'configured'); assert.equal(account().last_validated_at,null); assert.equal(account().credential_source,'dashboard');
  assert.deepEqual(credentials(),{token:'B:synthetic-token',account_id:'123',merchant_id:'456',store_id:'789',qris_static:qr,expires_at:finish.expires_at,expiry_source:'provider'});
  for(const secret of [password,'Synthetic-merchant-secret!','B:synthetic-token',qr]) assert.ok(!account().credential.includes(secret)&&!JSON.stringify(finish).includes(secret));
  assert.equal(typeof shopee.cancelShopeeLogin,'function');
  assert.deepEqual(shopee.cancelShopeeLogin(user,{attempt_id:result.attempt_id}),{ok:true});
  const unlock=()=>db.prepare("UPDATE merchant_login_limits SET next_at=0,attempts=0,window_at=0 WHERE provider='shopeepay'").run();
  unlock(); const direct=await shopee.startShopeeLogin(user,input(),{workerCommand:{...options.workerCommand,args:[...options.workerCommand.args,'direct']}});
  assert.equal(direct.step,'store'); shopee.cancelShopeeLogin(user,{attempt_id:direct.attempt_id});
  assert.equal(calls,0);
  console.log('PASS real OTP/authenticated paths, opaque stores, encrypted scoped finish, provider expiry, cancellation');
  const routerModule=await load('routes/shopee-login.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  assert.equal(typeof routerModule.default,'function','protected router must exist');
  const {default:express}=await import(pathToFileURL(path.join(root,'node_modules/express/index.js')));
  const security=await load('middleware/security.js');
  const terms=await load('routes/terms.js');
  const app=express(); app.use(express.json(),security.parseCookies,security.sessionMiddleware,security.csrf);
  let requestBody;
  app.use((req,res,next)=>{requestBody=req.body;next();});
  app.use('/api/accounts/shopee/login',routerModule.default);
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  try {
    const base=`http://127.0.0.1:${server.address().port}/api/accounts/shopee/login`;
    const csrf='0123456789abcdef0123456789abcdef';
    const {createHmac}=await import('node:crypto'), {config}=await load('config.js');
    const payload=`${terms.TERMS_VERSION}.${Date.now()+600000}`;
    const proof=createHmac('sha256',config.cookieSecret).update(`paygate:terms:${payload}`).digest('hex');
    const cookie=`paygate_sid=session1; paygate_csrf=${csrf}; ${terms.TERMS_COOKIE_NAME}=${payload}.${proof}`;
    const post=(step,body,headers={})=>nativeFetch(base+'/'+step,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,...headers},body:JSON.stringify(body)});
    for(const step of ['start','verify','finish']) {
      const response=await post(step,input(),{Cookie:`paygate_sid=session1; paygate_csrf=${csrf}`});
      assert.equal(response.status,403); assert.equal((await response.json()).code,'TERMS_REQUIRED');
      assert.equal(requestBody.password,undefined); assert.equal(requestBody.merchant_password,undefined);
    }
    let response=await post('cancel',{attempt_id:'0'.repeat(48)},{Cookie:`paygate_sid=session1; paygate_csrf=${csrf}`});
    assert.equal(response.status,200,'cancel requires no terms');
    response=await post('start',input(),{Cookie:`paygate_csrf=${csrf}`}); assert.equal(response.status,403);
    response=await post('start',input(),{'X-CSRF-Token':''}); assert.equal(response.status,403);
    unlock(); response=await post('start',{...input(),password:'Wrong-PayGate-password'});
    assert.equal(response.status,401); assert.equal((await response.json()).code,'REAUTH');
    assert.equal(requestBody.password,undefined); assert.equal(requestBody.merchant_password,undefined);
    response=await post('start',input()); assert.equal(response.status,429); assert.ok(Number(response.headers.get('Retry-After'))>0);
    response=await post('cancel',{attempt_id:'0'.repeat(48),workerCommand:{file:'/bin/true',args:[]}}); assert.equal(response.status,422);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  assert.equal(calls,0);
  console.log('PASS real HTTP protected routes, terms except cancel, CSRF, secret scrubbing, safe errors, no worker override');
  const worker=mode=>({workerCommand:{...options.workerCommand,args:[...options.workerCommand.args,mode]}});
  const variant=change=>worker('json:'+Buffer.from(JSON.stringify(change)).toString('base64url'));
  const denied=async(promise,code)=>assert.rejects(promise,e=>e instanceof shopee.ShopeeLoginError&&e.code===code&&!e.message.includes('secret provider'));
  for(const {args} of children) {
    assert.equal(args[2].shell,false); assert.equal(args[2].detached,true);
    assert.deepEqual(args[2].stdio,['pipe','pipe','ignore']);
    assert.equal(args[2].env.PLAYWRIGHT_BROWSERS_PATH,'/opt/paygate-browser/browsers');
    for(const key of ['ENCRYPTION_KEY','COOKIE_SECRET','SHOPEEPAY_TOKEN','DB_PATH']) assert.equal(args[2].env[key],undefined);
    for(const secret of [password,'Synthetic-merchant-secret!']) assert.ok(!JSON.stringify(args).includes(secret));
  }
  assert.equal(typeof shopee.shopeeBrowserAvailable(),'boolean');
  for(const who of [null,{...user,role:'viewer'},{...user,id:2},{...user,sid:'missing'},{...user,viaApiKey:true}]) {
    unlock(); const before=children.length; await denied(shopee.startShopeeLogin(who,input(),options),'FORBIDDEN'); assert.equal(children.length,before);
  }
  for(const change of [{consent:false},{identifier:'name\n'},{merchant_password:''},{password:123},{extra:'no'}]) {
    unlock(); const body={...input(),...change}; await denied(shopee.startShopeeLogin(user,body,options),'INVALID');
    assert.equal(body.password,undefined);assert.equal(body.merchant_password,undefined);
  }
  unlock(); let before=children.length;
  await denied(shopee.startShopeeLogin(user,{...input(),password:'wrong-password'},options),'REAUTH'); assert.equal(children.length,before);
  const fresh=await import(pathToFileURL(path.join(temp,'src/services/shopee-login.js'))+'?restart=1');
  await assert.rejects(fresh.startShopeeLogin(user,input(),options),e=>e instanceof fresh.ShopeeLoginError&&e.code==='COOLDOWN');
  for(const [change,restore] of [
    [()=>db.prepare("UPDATE users SET updated_at=updated_at+1 WHERE id=1").run(),()=>db.prepare('UPDATE users SET updated_at=? WHERE id=1').run(now)],
    [()=>db.prepare("UPDATE users SET password_hash='changed' WHERE id=1").run(),()=>db.prepare('UPDATE users SET password_hash=? WHERE id=1').run(hash)]
  ]) {
    unlock(); before=children.length; const pending=shopee.startShopeeLogin(user,input(),options); change(); await denied(pending,'EXPIRED'); restore(); assert.equal(children.length,before);
  }
  unlock(); const busy=shopee.startShopeeLogin(user,input(),options);
  await denied(shopee.startShopeeLogin(user,input(),options),'BUSY');
  const busyResult=await busy; shopee.cancelShopeeLogin(user,{attempt_id:busyResult.attempt_id});
  for(const mode of ['malformed','oversize','duplicate','exit']) {
    unlock(); await denied(shopee.startShopeeLogin(user,input(),worker(mode)),mode==='exit'?'NETWORK':'BAD_RESPONSE');
    const child=children.at(-1).child; await waitFor(()=>child.exitCode!==null||child.signalCode!==null);
  }
  const invalid=[{credential:{token:'SPC_secret'}},{credential:{merchant_id:'01'}},{credential:{account_id:123}},{credential:{expires_at:0}},
    {credential:{password:'forbidden'}},{stores:null},{stores:[]},{stores:[{store_id:'789',label:'One'},{store_id:'789',label:'Two'}]},
    {stores:[{store_id:'789',label:'Bad\nlabel'}]},{stores:[{store_id:'789',label:'Bad QR',qris_static:'not QR'}]},{cookie:'forbidden'},
    {ok:false,code:'unknown secret provider'}];
  for(const change of invalid) {unlock();await denied(shopee.startShopeeLogin(user,input(),variant(change)),Array.isArray(change.stores)&&change.stores.length===0?'NO_MERCHANT':'BAD_RESPONSE');}
  unlock(); const hung=shopee.startShopeeLogin(user,input(),{...worker('hang'),timeoutMs:100});
  await denied(hung,'NETWORK'); await waitFor(()=>children.at(-1).child.signalCode!==null||children.at(-1).child.exitCode!==null);
  console.log('PASS isolated launch env, strict inputs, live revisions, durable restart cooldown, busy guard, worker protocol failures, timeout cleanup');
  // Actual worker vocabulary; never forward provider messages or unrecognized codes.
  for(const [code,expected] of [['CHALLENGE_REQUIRED','CHALLENGE'],['PROFILE_NOT_OBSERVED','NO_MERCHANT'],['STORES_NOT_OBSERVED','NO_MERCHANT'],['STORES_INCOMPLETE','NO_MERCHANT'],['METADATA_INVALID','BAD_RESPONSE'],['SCOPE_INVALID','BAD_RESPONSE'],['PROFILE_REJECTED','AUTH_REJECTED'],['STORES_REJECTED','AUTH_REJECTED'],['FORM_UNAVAILABLE','UNSUPPORTED']]) {
    unlock(); await denied(shopee.startShopeeLogin(user,input(),variant({ok:false,code})),expected);
  }
  // Revalidate while worker waits, not only when next HTTP action arrives.
  unlock(); let active=await shopee.startShopeeLogin(user,input(),options), child=children.at(-1).child;
  db.prepare('DELETE FROM sessions WHERE id=?').run(user.sid);
  await waitFor(()=>child.exitCode!==null||child.signalCode!==null);
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,1,?,?)').run(user.sid,now,Date.now()+7200000);
  await denied(shopee.verifyShopeeLogin(user,{attempt_id:active.attempt_id,otp:'123456'}),'EXPIRED');
  unlock(); active=await shopee.startShopeeLogin(user,input(),options);
  await denied(shopee.verifyShopeeLogin(user,{attempt_id:active.attempt_id,otp:'1234'}),'INVALID');
  unlock(); active=await shopee.startShopeeLogin(user,input(),options);
  const verifying=shopee.verifyShopeeLogin(user,{attempt_id:active.attempt_id,otp:'123456'});
  await denied(shopee.verifyShopeeLogin(user,{attempt_id:active.attempt_id,otp:'123456'}),'BUSY');
  shopee.cancelShopeeLogin(user,{attempt_id:active.attempt_id}); await denied(verifying,'EXPIRED');
  unlock(); before=children.length;
  const frozenUser={...user}, frozenInput=input(), frozen=shopee.startShopeeLogin(frozenUser,frozenInput,options);
  frozenUser.id=2; frozenInput.identifier='tampered'; const frozenResult=await frozen;
  shopee.cancelShopeeLogin(user,{attempt_id:frozenResult.attempt_id});
  assert.equal(children.length,before+1);
  const startStore=async(opts=worker('direct'))=>{unlock();return shopee.startShopeeLogin(user,input(),opts);};
  const finishStore=(r,qris_static=qr,choice=r.choices[0].id)=>shopee.finishShopeeLogin(user,{attempt_id:r.attempt_id,choice,qris_static});
  active=await startStore(); let old=account();
  await denied(finishStore(active,qr,'789'),'INVALID'); assert.deepEqual(account(),old);
  active=await startStore(); await denied(finishStore(active,'broken QR'),'INVALID'); assert.deepEqual(account(),old);
  active=await startStore(); db.prepare("UPDATE payment_accounts SET next_poll_at=? WHERE id=?").run(Date.now()+600000,account().id); old=account();
  await denied(finishStore(active),'PROVIDER_COOLDOWN'); assert.deepEqual(account(),old);
  db.prepare("UPDATE payment_accounts SET next_poll_at=123,status='paused',updated_at=updated_at+10000 WHERE id=?").run(account().id);
  old=account(); active=await startStore(worker('lease')); const lease=await finishStore(active);
  assert.equal(lease.expiry_source,'local_lease'); assert.ok(lease.expires_at<=Date.now()+43200000&&lease.expires_at>Date.now()+43100000);
  assert.equal(account().status,'paused'); assert.equal(account().next_poll_at,123); assert.ok(account().updated_at>old.updated_at);
  const changedQ=q.replace('PAYGATE LAB','PAYGATE NEW'), changedQr=changedQ+crc16ccitt(changedQ);
  for(const table of ['orders','seen_transactions']) {
    if(table==='orders') db.prepare('INSERT INTO orders(id,user_id,provider,account_id,amount,expires_at,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?)').run('history','shopeepay',account().id,1,now,now,now);
    else db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at) VALUES(?,?,?,?,?,?)').run('shopeepay','history',account().id,1,now,now);
    for(const [change,qrValue] of [[{credential:{merchant_id:'999'}},qr],[{stores:[{store_id:'999',label:'Different'}]},qr],[{},changedQr]]) {
      active=await startStore(variant(change));old=account();await denied(finishStore(active,qrValue),'SCOPE_CHANGED');assert.deepEqual(account(),old);
    }
    active=await startStore(); await finishStore(active); assert.equal(account().status,'paused');
    db.prepare('DELETE FROM '+table).run();
  }
  db.exec("CREATE TEMP TRIGGER reject_login_save BEFORE UPDATE OF credential ON payment_accounts BEGIN SELECT RAISE(ABORT,'secret provider DB'); END");
  active=await startStore();old=account();await denied(finishStore(active),'SAVE_FAILED');assert.deepEqual(account(),old);db.exec('DROP TRIGGER reject_login_save');
  active=await startStore(variant({stores:[{store_id:'789',label:'Captured QR',qris_static:qr}]}));
  await denied(finishStore(active,changedQr),'INVALID');
  active=await startStore(variant({stores:[{store_id:'789',label:'Captured QR',qris_static:qr}]}));
  await finishStore(active,'');assert.equal(credentials().qris_static,qr);
  const nativeNow=Date.now, clockStart=nativeNow();
  try {
    unlock();
    for(let i=0;i<5;i++) {
      Date.now=()=>clockStart+i*720000;
      await denied(shopee.startShopeeLogin(user,{...input(),password:'wrong-password'},options),'REAUTH');
    }
    Date.now=()=>clockStart+59*60000;
    await denied(shopee.startShopeeLogin(user,input(),options),'COOLDOWN');
    assert.equal(db.prepare("SELECT attempts FROM merchant_login_limits WHERE provider='shopeepay'").get().attempts,5);
  } finally {Date.now=nativeNow;}
  console.log('PASS logout watchdog, no OTP retry, concurrency/cancel races, immutable identity, QR scope, cooldown/paused retention, DB rollback, 12h cap, five real attempts/hour');
  const pythonFixture=`import asyncio, importlib.util, json, sys
spec=importlib.util.spec_from_file_location('browser_fixtures', ${JSON.stringify(path.join(root,'tests/shopee_browser.py'))})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
async def main():
    case=module.BrowserTests(); await case.asyncSetUp()
    case.html=module.HTML.replace("window.otp=verify.querySelector('input').value;", "window.otp=verify.querySelector('input').value; location.href='https://partner.shopee.co.id/';")
    try: await case.m.serve(case.worker)
    finally: await case.asyncTearDown()
asyncio.run(main())`;
  unlock(); const browserOtp=await shopee.startShopeeLogin(user,input(),{workerCommand:{file:'/opt/paygate-browser/bin/python',args:['-I','-u','-c',pythonFixture]}});
  assert.equal(browserOtp.step,'otp');
  const browserStores=await shopee.verifyShopeeLogin(user,{attempt_id:browserOtp.attempt_id,otp:'123456'});
  assert.equal(browserStores.step,'store'); assert.equal(browserStores.choices[0].label,'Synthetic shop');
  const browserFinish=await shopee.finishShopeeLogin(user,{attempt_id:browserStores.attempt_id,choice:browserStores.choices[0].id,qris_static:qr});
  assert.equal(browserFinish.ok,true); assert.equal(credentials().merchant_id,'12'); assert.equal(credentials().store_id,'56');
  assert.equal(credentials().account_id,'34'); assert.equal(credentials().token,'B:synthetic_only');
  assert.equal(calls,0);
  console.log('PASS actual Python browser worker captures synthetic scoped stores, Node validates/encrypts result, zero provider calls');

} finally {
  shopee?.stopShopeeLogins?.(); globalThis.fetch=nativeFetch; db?.close();
  childProcess.spawn=nativeSpawn; syncBuiltinESMExports();
  for(const key of Object.keys(process.env)) if(!(key in environment)) delete process.env[key];
  Object.assign(process.env,environment); rmSync(temp,{recursive:true,force:true});
}
