// Real Python Worker + routed Chromium fixture + Node service + isolated SQLite/AES.
// Run: node --disable-warning=ExperimentalWarning tests/shopee-cross.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-shopee-cross-'));
const environment = { ...process.env }, nativeFetch = globalThis.fetch, nativeSpawn = childProcess.spawn;
const children = [];
let db, service, providerCalls = 0;
childProcess.spawn = (...args) => {
  const child = nativeSpawn(...args);
  const trace = { child, stdout: '', closed: new Promise(resolve => child.once('close', resolve)) };
  child.stdout.on('data', chunk => { trace.stdout += chunk.toString(); });
  children.push(trace);
  return child;
};
syncBuiltinESMExports();
try {
  cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  for (const name of ['shopee_browser.py', 'shopee_cross_worker.py']) {
    cpSync(path.join(root, 'tests', name), path.join(temp, 'tests', name));
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  // No project .env, live database, inherited provider config, or real upstream.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'test', HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin',
    DB_PATH: path.join(temp, 'test.db'), PAYGATE_DATA_DIR: temp,
    ENCRYPTION_KEY: 'ab'.repeat(32), LAB_UNOFFICIAL: '1', LAB_USER_ID: '1',
  });
  globalThis.fetch = () => { providerCalls++; throw new Error('Provider calls forbidden'); };
  const load = file => import(pathToFileURL(path.join(temp, 'src', file)));
  ({ db } = await load('db/index.js'));
  const { hashPassword, decrypt } = await load('lib/crypto.js');
  const { getEncryptionKey, config } = await load('config.js');
  const { crc16ccitt } = await load('lib/qris.js');
  assert.equal(config.dbPath, path.join(temp, 'test.db'));
  service = await load('services/shopee-login.js');
  const password = 'Cross-PayGate-password!', merchantPassword = 'Cross-merchant-password!';
  const now = Date.now(), hash = await hashPassword(password);
  db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run('cross-owner', hash, now, now);
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,1,?,?)')
    .run('cross-session', now, now + 600000);
  const user = { id: 1, sid: 'cross-session', role: 'admin' };
  const body = { identifier: 'cross@example.invalid', merchant_password: merchantPassword, password, consent: true };
  const start = await service.startShopeeLogin(user, body, {
    workerCommand: { file: '/root/camofox-venv/bin/python', args: ['-B', '-u', path.join(temp, 'tests/shopee_cross_worker.py')] },
  });
  assert.deepEqual(Object.keys(start).sort(), ['attempt_id', 'expires_at', 'ok', 'step']);
  assert.equal(start.ok, true);
  assert.equal(start.step, 'otp');
  assert.match(start.attempt_id, /^[a-f0-9]{48}$/);
  assert.equal(body.password, undefined);
  assert.equal(body.merchant_password, undefined);
  assert.equal(children.length, 1);

  const otp = { attempt_id: start.attempt_id, otp: '123456' };
  let verifyError;
  const selected = await service.verifyShopeeLogin(user, otp).catch(error => { verifyError = error; });
  // Observe untouched child stdout, never substitute a hand-built worker result.
  const messages = children[0].stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages[0], { ok: true, step: 'otp' });
  assert.equal(messages.length, 2);
  const auth = messages[1];
  assert.equal(auth.ok, true);
  assert.equal(auth.step, 'authenticated');
  assert.deepEqual(auth.stores, [
    { store_id: '56', label: 'Synthetic shop' },
    { store_id: '78', label: 'Synthetic second shop' },
  ], 'Python must emit store_id, not the public opaque-choice id');
  if (verifyError) throw verifyError;
  assert.equal(await children[0].closed, 0, 'Real JSONL server and routed fixture must exit cleanly');
  assert.equal(otp.otp, undefined);
  assert.deepEqual(Object.keys(auth.credential).sort(), ['account_id', 'expires_at', 'merchant_id', 'token']);
  assert.equal(auth.credential.token, 'B:synthetic_only');
  assert.equal(auth.credential.account_id, '34');
  assert.equal(auth.credential.merchant_id, '12');
  assert.ok(auth.credential.expires_at > now + 3500000 && auth.credential.expires_at < Date.now() + 3600000);
  assert.deepEqual(Object.keys(selected).sort(), ['attempt_id', 'choices', 'expires_at', 'ok', 'step']);
  assert.equal(selected.ok, true);
  assert.equal(selected.step, 'store');
  assert.equal(selected.attempt_id, start.attempt_id);
  assert.equal(selected.choices.length, 2);
  assert.equal(new Set(selected.choices.map(choice => choice.id)).size, 2);
  for (const choice of selected.choices) {
    assert.deepEqual(Object.keys(choice).sort(), ['id', 'label']);
    assert.match(choice.id, /^[a-f0-9]{48}$/);
    assert.ok(!auth.stores.some(store => store.store_id === choice.id));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_accounts').get().n, 0);

  const qrBase = '00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304';
  const qr = qrBase + crc16ccitt(qrBase);
  const choice = selected.choices.find(item => item.label === 'Synthetic second shop');
  assert.ok(choice, 'Select second store through public opaque choice, not first-store fallback');
  const finishBody = { attempt_id: selected.attempt_id, choice: choice.id, qris_static: qr };
  const finish = await service.finishShopeeLogin(user, finishBody);
  assert.deepEqual(Object.keys(finish).sort(), ['detail', 'expires_at', 'expiry_source', 'ok']);
  assert.equal(finish.ok, true);
  assert.equal(finish.expires_at, auth.credential.expires_at);
  assert.equal(finish.expiry_source, 'provider');
  assert.equal(finishBody.qris_static, undefined);
  const rows = db.prepare('SELECT * FROM payment_accounts').all();
  assert.equal(rows.length, 1);
  const account = rows[0];
  assert.equal(account.user_id, user.id);
  assert.equal(account.provider, 'shopeepay');
  assert.equal(account.label, 'Synthetic second shop');
  assert.equal(account.status, 'configured');
  assert.equal(account.last_validated_at, null);
  assert.equal(account.credential_source, 'dashboard');
  assert.deepEqual(JSON.parse(decrypt(account.credential, getEncryptionKey())), {
    ...auth.credential, store_id: '78', qris_static: qr, expiry_source: 'provider',
  });
  const publicDto = JSON.stringify([start, selected, finish]);
  for (const secret of [password, merchantPassword, body.identifier, '123456', auth.credential.token, qr]) {
    assert.ok(!publicDto.includes(secret), 'Public DTO leaked synthetic secret');
    assert.ok(!account.credential.includes(secret), 'Stored credential contains plaintext secret');
  }
  for (const key of ['credential', 'token', 'account_id', 'merchant_id', 'store_id', 'qris_static', 'cookie']) {
    assert.ok(!publicDto.includes(`"${key}"`), `Public DTO exposed ${key}`);
  }
  const { pollLabAccount } = await load('services/lab.js');
  assert.deepEqual(await pollLabAccount('shopeepay', user.id), { ok: false, code: 'PAUSED' });
  assert.equal(providerCalls, 0);
  assert.deepEqual(service.cancelShopeeLogin(user, { attempt_id: start.attempt_id }), { ok: true });
  console.log('PASS real Python Worker -> JSONL store_id -> Node OTP/store/finish; second opaque store; encrypted scoped SQLite credential; safe DTO; configured-only; zero provider calls');
} finally {
  service?.stopShopeeLogins?.();
  await Promise.all(children.map(trace => trace.closed));
  db?.close();
  globalThis.fetch = nativeFetch;
  childProcess.spawn = nativeSpawn;
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  rmSync(temp, { recursive: true, force: true });
}
