// Capture OUR exact GoPay OTP request (zero network, fetch stubbed).
// Mirrors tests/login.mjs harness: isolated DB, real password hash, stub fetch.
import { mkdtempSync, cpSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = import.meta.dirname, temp = mkdtempSync(path.join(tmpdir(), 'cap-ours-'));
cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'db'), PAYGATE_DATA_DIR: temp, ENCRYPTION_KEY: 'aa'.repeat(32), COOKIE_SECRET: '22'.repeat(32), LAB_UNOFFICIAL: '1', LAB_USER_ID: '1', GOPAY_ACCESS_TOKEN: '', GOPAY_MERCHANT_ID: '', GOPAY_QRIS_STATIC: '' });
const load = f => import(pathToFileURL(path.join(temp, 'src', f)));
const { db } = await load('db/index.js');
const { hashPassword } = await load('lib/crypto.js');
const password = 'Local-test-pass-123!', now = Date.now();
db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(1, 'u1', await hashPassword(password), now, now);
db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run('s1', 1, now, now + 600000);
const login = await load('services/login.js');
const captured = [];
const wire = { fetch: async (url, init) => {
  captured.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect, credentials: init.credentials });
  throw new Error('ABORT'); // stop before any network
}};
try { await login.startLogin({ id: 1, sid: 's1' }, { provider: 'gopay', phone: '081234567890', password, consent: true }, wire); } catch {}
writeFileSync('/tmp/ours_capture.json', JSON.stringify(captured[0], null, 2));
console.log(JSON.stringify(captured[0], null, 2));
