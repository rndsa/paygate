// Real isolated SQLite + local HTTP only. Never loads runtime or calls providers.
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-console-'));
let db, server;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  assert.equal(new URL(url).hostname, '127.0.0.1', 'external traffic forbidden');
  return nativeFetch(url, ...args);
};
const dtoKeys = ['id','created_at','level','module','event','summary','code','request_id','stage','http_status','provider_status','duration_ms','upstream_code','upstream_request_id'].sort();
try {
  cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'console.db'), PAYGATE_DATA_DIR: temp, ENCRYPTION_KEY: 'ab'.repeat(32), COOKIE_SECRET: 'cd'.repeat(32), LAB_UNOFFICIAL: '0', LAB_USER_ID: '1', GOPAY_ACCESS_TOKEN: '', SHOPEEPAY_TOKEN: '' });
  const load = file => import(pathToFileURL(path.join(temp, 'src', file)));
  ({ db } = await load('db/index.js'));
  const now = Date.now();
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, `console-user-${id}`, 'not-a-real-password-hash', now, now);
    db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(`session-${id}`, id, now, now + 864000000);
  }
  const service = await load('services/console-log.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof service.recordEvent, 'function', 'persistent console recordEvent must exist');
  const { recordEvent, getEvent } = service;
  const firstId = recordEvent({ event: 'AUTH_LOGIN', user_id: 1 });
  assert.ok(Number.isSafeInteger(firstId) && firstId > 0);
  const first = getEvent(1, firstId);
  assert.deepEqual(Object.keys(first).sort(), dtoKeys);
  assert.equal(first.event, 'AUTH_LOGIN');
  assert.equal(first.level, 'info');
  assert.equal(first.module, 'auth');
  assert.equal(first.summary, 'Login PayGate: diproses.', 'client-facing catalogue uses natural Indonesian');
  assert.ok(first.created_at >= now && first.created_at <= Date.now());
  for (const field of ['code','request_id','stage','http_status','provider_status','duration_ms','upstream_code','upstream_request_id']) assert.equal(first[field], null);
  assert.equal(getEvent(2, firstId), null, 'private owner scope applies to details');
  const persisted = spawnSync(process.execPath, ['--input-type=module', '-e', `const {getEvent}=await import(${JSON.stringify(pathToFileURL(path.join(temp, 'src/services/console-log.js')).href)}); process.stdout.write(JSON.stringify(getEvent(1,${firstId})));`], { env: process.env, encoding: 'utf8' });
  assert.equal(persisted.status, 0, persisted.stderr);
  assert.deepEqual(JSON.parse(persisted.stdout), first, 'second process reads durable SQLite event');
  console.log('PASS flat safe event DTO, owner-scoped detail, real SQLite persistence across processes');

  const events = {
    auth: ['AUTH_LOGIN','AUTH_LOGOUT','AUTH_PASSWORD','AUTH_LOGOUT_ALL'],
    gopay: ['GOPAY_LOGIN_START','GOPAY_LOGIN_VERIFY','GOPAY_LOGIN_FINISH','GOPAY_LOGIN_CANCEL'],
    shopeepay: ['SHOPEE_LOGIN_START','SHOPEE_LOGIN_VERIFY','SHOPEE_LOGIN_FINISH','SHOPEE_LOGIN_CANCEL'],
    accounts: ['ACCOUNT_TEST','ACCOUNT_RESUME','ACCOUNT_PAUSE','ACCOUNT_DELETE'],
    orders: ['ORDER_CREATE','ORDER_CHECK','PAYMENT_MATCH','PAYMENT_UNMATCHED'],
    apikeys: ['APIKEY_CREATE','APIKEY_REVOKE','APIKEY_REGENERATE'],
    settings: ['SETTINGS_UPDATE'], system: ['PROVIDER_POLL','SERVER_START','SERVER_STOP','REQUEST_FAILED'],
  };
  for (const [module, names] of Object.entries(events)) for (const event of names) {
    const id = recordEvent({ event, user_id: 1 });
    assert.ok(id, `${event} is in the server catalogue`);
    assert.equal(getEvent(1, id).module, module);
  }
  const secret = '<script>private-phone-081234567890 password OTP 123456 Bearer secret</script>';
  const requestId = 'abcdef123456', upstreamId = '00112233-4455-4677-8899-aabbccddeeff';
  const safe = getEvent(1, recordEvent({
    event: 'GOPAY_LOGIN_START', user_id: 1, level: 'info', module: 'gopay',
    code: 'PHONE_REJECTED', stage: 'otp_request', http_status: 503, provider_status: 400,
    request_id: requestId, upstream_request_id: upstreamId, upstream_code: 'goid:error:unauthorized', duration_ms: 21,
    id: 999999999, created_at: 1, summary: secret, phone: secret, message: secret,
    body: { password: secret, otp: secret }, headers: { authorization: secret }, env: secret, stack: secret,
  }));
  assert.equal(safe.level, 'warn', 'known provider rejection is not application failure');
  assert.equal(safe.code, 'PHONE_REJECTED');
  assert.equal(safe.stage, 'otp_request');
  assert.equal(safe.provider_status, 400);
  assert.equal(safe.http_status, 503);
  assert.equal(safe.request_id, requestId);
  assert.equal(safe.upstream_request_id, upstreamId);
  assert.equal(safe.upstream_code, 'goid:error:unauthorized');
  assert.equal(safe.duration_ms, 21);
  assert.ok(safe.created_at > 1 && safe.id !== 999999999, 'IDs and time are server owned');
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.ok(!/completed|delivered|received|settled/i.test(safe.summary), 'rejection summary cannot imply OTP delivery or success');
  const cleaned = getEvent(1, recordEvent({ event: 'ORDER_CREATE', user_id: 1, level: secret, module: secret, code: secret, stage: secret, request_id: secret, upstream_code: secret, upstream_request_id: requestId, http_status: 999, provider_status: 400, duration_ms: -1, summary: secret }));
  for (const field of ['code','stage','request_id','upstream_code','upstream_request_id','http_status','provider_status','duration_ms']) assert.equal(cleaned[field], null, `invalid ${field} is discarded`);
  assert.equal(cleaned.module, 'orders');
  assert.equal(cleaned.level, 'info');
  for (const [input, expected] of [
    [{ http_status: 404, level: 'info' }, 'warn'], [{ http_status: 500, level: 'info' }, 'error'],
    [{ code: 'NETWORK', http_status: 200 }, 'error'], [{ code: 'BAD_RESPONSE', http_status: 200 }, 'error'],
    [{ code: 'COOLDOWN', http_status: 200 }, 'warn'], [{ level: 'error' }, 'error'],
  ]) assert.equal(getEvent(1, recordEvent({ event: 'REQUEST_FAILED', user_id: 1, ...input })).level, expected);
  for (const stage of ['local_validation','reauth','cooldown','attempt_validation','otp_validation','merchant_selection','merchant_save']) {
    assert.equal(getEvent(1, recordEvent({ event: 'GOPAY_LOGIN_FINISH', user_id: 1, stage, provider_status: 201 })).provider_status, null, 'local stages cannot claim provider HTTP status');
  }
  for (const input of [null, [], {event: secret}, {event: '__proto__'}, {event: 'AUTH_LOGIN', user_id: '1'}, {event: 'AUTH_LOGIN', user_id: -1}, new Proxy({}, {get(){throw new Error(secret);}})]) assert.equal(recordEvent(input), null);
  const globalId = recordEvent({ event: 'SERVER_START', user_id: null });
  assert.equal(getEvent(2, globalId).event, 'SERVER_START', 'safe system events are shared');
  for (const badUser of [null, 0, '1', -1, NaN]) assert.equal(getEvent(badUser, globalId), null, 'invalid owners fail closed');
  const storedJson = JSON.stringify(db.prepare('SELECT * FROM console_events').all());
  assert.ok(!storedJson.includes(secret), 'secrets never reach SQLite, not merely hidden from DTO');
  console.log('PASS full event catalogue, rejection/error severity, closed metadata vocabulary, local stage safety, persisted secret redaction');

  assert.equal(typeof service.listEvents, 'function', 'scoped console list must exist');
  const { listEvents } = service;
  const otherId = recordEvent({ event: 'ORDER_CREATE', user_id: 2 });
  const page = listEvents(1, { limit: 2 });
  assert.deepEqual(Object.keys(page).sort(), ['entries','next_cursor','retention_days','max_entries'].sort());
  assert.equal(page.retention_days, 30); assert.equal(page.max_entries, 10000);
  assert.equal(page.entries.length, 2);
  assert.equal(page.next_cursor, page.entries.at(-1).id);
  assert.ok(page.entries[0].id > page.entries[1].id);
  assert.ok(page.entries.some(e => e.id === globalId));
  assert.ok(!listEvents(1, {limit:100}).entries.some(e => e.id === otherId));
  const older = listEvents(1, {before:page.next_cursor, limit:100});
  assert.ok(older.entries.every(e => e.id < page.next_cursor));
  assert.equal(older.next_cursor, null);
  assert.ok(listEvents(1).entries.length <= 30);
  assert.deepEqual(listEvents(1, {level:'warn', module:'gopay', q:'PHONE_REJECT', since:now, limit:100}).entries.map(e => e.id), [safe.id]);
  assert.deepEqual(listEvents(1, {q:requestId}).entries.map(e => e.id), [safe.id]);
  assert.deepEqual(listEvents(1, {q:upstreamId}).entries.map(e => e.id), [safe.id]);
  assert.deepEqual(listEvents(1, {q:'phone_reject'}).entries.map(e => e.id), [safe.id]);
  assert.equal(listEvents(1, {since:Date.now()+10000}).entries.length, 0);
  assert.equal(listEvents(1, {q:'PHONE_REJECTED_',limit:100}).entries.length, 0, 'underscore is literal, not SQL LIKE wildcard');
  for (const filters of [{wat:'x'},{user_id:'2'},{level:'debug'},{module:'__proto__'},{limit:0},{limit:101},{limit:'1.5'},{limit:true},{before:'-1'},{before:'1e3'},{since:'NaN'},{since:'-1'},{q:'x'.repeat(81)},{q:'%_'},{q:'a b'},{q:"' OR 1=1 --"},{level:['info','warn']},{module:{x:'auth'}}]) {
    assert.throws(() => listEvents(1, filters), error => error.code === 'INVALID_QUERY' && error.status === 422, `strict filter ${JSON.stringify(filters)}`);
  }
  for (const owner of [null,0,-1,'1']) assert.equal(listEvents(owner, {}).entries.length, 0);
  console.log('PASS owner/system scoped list, stable cursor pages, metadata, literal ID/code search, strict filter validation');

  const routes = await load('routes/console.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof routes.default, 'function', 'Console router must exist');
  assert.equal(typeof service.requireConsoleAdmin, 'function');
  const express = (await import('express')).default;
  const {parseCookies, sessionMiddleware, optionalApiKeyAuth} = await load('middleware/security.js');
  const {hashToken} = await load('lib/crypto.js');
  db.prepare('INSERT INTO api_keys(user_id,name,key_hash,prefix,created_at) VALUES(?,?,?,?,?)').run(1, 'fixture', hashToken('console-api-secret'), 'fixture', now);
  const app = express();
  app.use(parseCookies, sessionMiddleware);
  // Exercise role/session revocation AFTER identity hydration: the route must
  // independently check current SQLite truth, not trust stale req.user.role.
  app.use((req,res,next) => {
    if (req.headers['x-test-revoke-role']) db.prepare("UPDATE users SET role='viewer' WHERE id=1").run();
    if (req.headers['x-test-revoke-session']) db.prepare('DELETE FROM sessions WHERE id=?').run('session-1');
    if (req.headers['x-test-expire-session']) db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now()-1, 'session-1');
    if (req.headers['x-test-mismatch']) req.user = {...req.user, id:2};
    if (req.headers['x-test-query-type']) req.query = {limit:2};
    next();
  });
  app.use('/api/console', routes.default);
  app.use('/key-console', optionalApiKeyAuth, routes.default);
  server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route='/logs', {session='session-1', headers={}, method='GET', prefix='/api/console'}={}) => {
    const response = await fetch(base+prefix+route, {method, headers:{...(session ? {cookie:`paygate_sid=${session}`} : {}), ...headers}});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return {status:response.status, body:await response.json()};
  };
  let response = await request('/logs?limit=2');
  assert.equal(response.status,200); assert.equal(response.body.entries.length,2);
  assert.deepEqual((await request(`/logs/${firstId}`)).body,{entry:first});
  assert.equal((await request(`/logs/${otherId}`)).status,404);
  assert.equal((await request(`/logs/${globalId}`,{session:'session-2'})).status,200);
  for (const session of [null,'nonexistent']) assert.equal((await request('/logs',{session})).status,401);
  assert.equal((await request('/logs',{headers:{'x-test-mismatch':'1'}})).status,401);
  assert.equal((await request('/logs',{headers:{'x-test-revoke-role':'1'}})).status,403);
  assert.equal((await request('/logs')).status,403);
  db.prepare("UPDATE users SET role='admin' WHERE id=1").run();
  for (const header of ['x-test-revoke-session','x-test-expire-session']) {
    assert.equal((await request('/logs',{headers:{[header]:'1'}})).status,401);
    db.prepare('INSERT OR REPLACE INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run('session-1',1,now,now+864000000);
  }
  for (const headers of [{'x-api-key':'console-api-secret'},{authorization:'Bearer console-api-secret'},{'x-api-key':''}]) {
    assert.equal((await request('/logs',{headers})).status,403, 'API header forbidden even with a live admin cookie');
  }
  assert.equal((await request('/logs',{session:null,headers:{'x-api-key':'console-api-secret'},prefix:'/key-console'})).status,403,'resolved valid API-key identity cannot read Console');
  for (const query of ['limit=0','limit=101','limit=1.2','before=0','since=-1','q=%25','q=%27%20OR%201%3D1','q=%E2%98%83','q='+('a'.repeat(81)),'level=debug','module=bad','wat=x','user_id=2','level=info&level=warn','limit=1&limit=1','level[]=info','q[x]=a','__proto__[x]=a','constructor[x]=a','q=%00','q=%ZZ']) {
    const invalid = await request('/logs?'+query);
    assert.equal(invalid.status,422, `invalid API query: ${query}`);
    assert.equal(invalid.body.code,'INVALID_QUERY');
    assert.deepEqual(Object.keys(invalid.body).sort(),['code','error']);
  }
  assert.equal((await request('/logs',{headers:{'x-test-query-type':'1'}})).status,422,'nonstring parsed query values rejected');
  assert.equal((await request('/logs?level=warn&module=gopay&since='+now+'&q=PHONE_REJECTED&limit=1')).body.entries[0].id,safe.id);
  assert.equal((await request('/logs?q=')).status,200);
  assert.equal((await request('/logs/'+firstId+'?q=hello')).status,422,'detail accepts no query fields');
  for (const id of ['0','-1','1.1','1e2','9007199254740992']) assert.equal((await request('/logs/'+id)).status,422);
  const countBeforeWrites = db.prepare('SELECT count(*) n FROM console_events').get().n;
  for (const method of ['POST','DELETE','PATCH']) assert.equal((await request('/logs',{method})).status,404);
  assert.equal(db.prepare('SELECT count(*) n FROM console_events').get().n,countBeforeWrites,'Console has no ingestion or deletion API');
  console.log('PASS live HTTP admin sessions, revoked DB role/session, expired/mismatched session, API-key denial, scoped 404, no-store, strict raw queries, read-only routes');

  const ancient = recordEvent({event:'ORDER_CHECK', user_id:2});
  db.prepare('UPDATE console_events SET created_at=? WHERE id=?').run(Date.now()-31*86400000, ancient);
  assert.equal(getEvent(2, ancient),null,'expired history hidden and pruned without a new write');
  assert.equal(db.prepare('SELECT count(*) n FROM console_events WHERE id=?').get(ancient).n,0,'30-day history physically removed');
  const restartOld = recordEvent({event:'ORDER_CHECK', user_id:2});
  db.prepare('UPDATE console_events SET created_at=? WHERE id=?').run(Date.now()-31*86400000, restartOld);
  const restarted = spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(temp,'src/services/console-log.js')).href)});`],{env:process.env,encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr);
  assert.equal(db.prepare('SELECT count(*) n FROM console_events WHERE id=?').get(restartOld).n,0,'restart also enforces retention');
  const bulk = db.prepare(`INSERT INTO console_events(user_id,created_at,level,module,event,summary) VALUES(?,?,'info','orders','ORDER_CHECK','Order check: processed.')`);
  db.exec('BEGIN');
  for (let i=0;i<10010;i++) bulk.run(i%2+1,Date.now());
  db.exec('COMMIT');
  const newest = recordEvent({event:'ORDER_CHECK',user_id:1});
  assert.ok(newest);
  assert.equal(db.prepare('SELECT count(*) n FROM console_events').get().n,10000,'global cap, not per owner');
  assert.equal(getEvent(1,firstId),null,'oldest IDs evicted');
  assert.equal(listEvents(1,{limit:1}).entries[0].id,newest);
  const allRecent = db.prepare('SELECT id FROM console_events ORDER BY id DESC').all().map(row=>row.id);
  assert.equal(allRecent[0],newest); assert.equal(allRecent.at(-1),newest-9999,'keep exactly latest 10000 integer IDs');
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,2,'retention never touches business tables');
  console.log('PASS 30-day physical retention on read/restart, global latest-10000 cap on write, business rows preserved');

  const oldWarn = console.warn, oldError = console.error, diagnostics = [];
  console.warn = (...args) => diagnostics.push(args);
  console.error = (...args) => diagnostics.push(args);
  try {
    const originalCount = db.prepare('SELECT count(*) n FROM console_events').get().n;
    db.exec("CREATE TRIGGER console_reject_write BEFORE INSERT ON console_events BEGIN SELECT RAISE(ABORT,'NO-ECHO provider-token'); END");
    assert.equal(recordEvent({event:'ORDER_CREATE',user_id:1}),null);
    assert.equal(db.prepare('SELECT count(*) n FROM console_events').get().n,originalCount);
    db.exec('DROP TRIGGER console_reject_write');
    db.exec("CREATE TRIGGER console_reject_prune BEFORE DELETE ON console_events BEGIN SELECT RAISE(ABORT,'NO-ECHO provider-token'); END");
    assert.equal(recordEvent({event:'ORDER_CREATE',user_id:1}),null,'retention failure rolls back the event too');
    assert.equal(db.prepare('SELECT count(*) n FROM console_events').get().n,originalCount,'no cap violation/partial insertion');
    db.exec('DROP TRIGGER console_reject_prune');
    db.exec('BEGIN');
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('console-test-business','preserved');
    db.exec("CREATE TEMP TRIGGER console_reject_nested BEFORE INSERT ON console_events BEGIN SELECT RAISE(ABORT,'NO-ECHO'); END");
    assert.equal(recordEvent({event:'ORDER_CREATE',user_id:1}),null,'safe failure inside business transaction');
    db.exec('DROP TRIGGER console_reject_nested; COMMIT');
    assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get('console-test-business').value,'preserved','log failure never rolls back caller business transaction');
    db.exec('PRAGMA query_only=ON');
    assert.equal(recordEvent({event:'ORDER_CREATE',user_id:1}),null,'read-only SQLite failure is no-throw');
    db.exec('PRAGMA query_only=OFF');
    db.exec('ALTER TABLE console_events RENAME TO console_events_unavailable');
    const unavailable = await request('/logs');
    assert.equal(unavailable.status,503); assert.equal(unavailable.body.code,'CONSOLE_UNAVAILABLE');
    assert.ok(!JSON.stringify(unavailable.body).includes('console_events'));
    assert.equal(recordEvent({event:'ORDER_CREATE',user_id:1}),null);
    db.exec('ALTER TABLE console_events_unavailable RENAME TO console_events');
    assert.deepEqual(diagnostics,[], 'failure path neither duplicates console.warn nor emits raw SQLite/provider text');
  } finally {console.warn=oldWarn; console.error=oldError;}
  console.log('PASS real SQLite insert/prune/read-only failures, savepoint rollback, caller transaction preservation, safe API 503, no raw or duplicate logging');

  let eventReads = 0;
  const changing = { user_id:1, get event(){ return eventReads++ < 4 ? 'ORDER_CREATE' : secret; } };
  assert.equal(recordEvent(changing),null,'accessor-backed metadata cannot inject arbitrary strings');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM console_events').all()).includes(secret));
  console.log('PASS accessor-backed metadata rejected without unsafe coercion or persisted strings');

  for (const malformedId of ['%ZZ','%E0%A4%A']) {
    const invalidId = await request('/logs/'+malformedId);
    assert.equal(invalidId.status,422,'malformed path encoding is a safe validation response');
    assert.deepEqual(Object.keys(invalidId.body).sort(),['code','error']);
  }
  console.log('PASS malformed detail path encoding returns safe no-store JSON validation response');

  // Unknown fields are not evaluated, not even to stringify them for diagnostics.
  let unknownRead = false;
  assert.ok(recordEvent({event:'ORDER_CHECK',user_id:1,get password(){unknownRead=true;throw new Error(secret);}}));
  assert.equal(unknownRead,false);
  for (const badId of [null,'1',0,-1,NaN,Number.MAX_SAFE_INTEGER+1]) assert.equal(getEvent(1,badId),null);
  assert.ok(!getEvent(1,newest).user_id);
  db.prepare('INSERT INTO merchant_login_limits(user_id,provider,next_at,window_at,attempts,device_id) VALUES(?,?,?,?,?,?)').run(1,'gopay',now+999999,now,4,'durable-device-fixture');
  const budget = {...db.prepare('SELECT * FROM merchant_login_limits WHERE user_id=1').get()};
  const migrationRestart = spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(temp,'src/db/index.js')).href)});`],{env:process.env,encoding:'utf8'});
  assert.equal(migrationRestart.status,0,migrationRestart.stderr);
  assert.deepEqual({...db.prepare('SELECT * FROM merchant_login_limits WHERE user_id=1').get()},budget,'additive restart preserves complete persistent provider cooldown budget');
  const orphanId = recordEvent({event:'ORDER_CHECK',user_id:2});
  db.prepare('DELETE FROM users WHERE id=2').run();
  assert.equal(getEvent(1,orphanId),null,'deleting owner cannot promote private event to shared null-owner event');
  assert.equal((await request('/logs',{session:'session-2'})).status,401);
  await new Promise(resolve=>server.close(resolve)); server=null;
  db.close(); db=null;
  assert.equal(recordEvent({event:'SERVER_STOP',user_id:null}),null,'closed SQLite never throws from recordEvent');
  console.log('PASS unknown getters untouched, additive migration preserves cooldown budget, owner deletion stays private, closed-DB no-throw');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close();
  rmSync(temp, { recursive: true, force: true });
  globalThis.fetch = nativeFetch;
}
