// Wire-level contract capture: record EXACTLY what PayGate sends upstream,
// using its own provider adapter with a mock fetch. Synthetic credentials only.
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-wire-'));
const captures = [];
try {
  cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), PAYGATE_DATA_DIR: path.join(temp, 'data'),
    ENCRYPTION_KEY: '11'.repeat(32), COOKIE_SECRET: '22'.repeat(32), LAB_UNOFFICIAL: '0',
  });
  globalThis.fetch = async (url, init) => { throw new Error('should be replaced'); };
  const load = f => import(pathToFileURL(path.join(temp, 'src', f)).href);
  const { encrypt } = await load('lib/crypto.js');
  const provider = await load('services/provider.js');
  const key = Buffer.from('11'.repeat(32), 'hex');

  const record = (label) => async (url, init = {}) => {
    const u = new URL(url);
    captures.push({
      side: 'PAYGATE', label,
      method: init.method ?? 'GET',
      origin: u.origin, pathname: u.pathname,
      params: Object.fromEntries([...u.searchParams].map(([k, v]) => [k, k === 'merchant_ids' ? '<merchant>' : v])),
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, /authorization/i.test(k) ? '<redacted>' : v])),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    // minimal valid response so the adapter completes one page
    if (u.pathname.includes('merchant-analytics')) {
      return new Response(JSON.stringify({ from: 0, size: 100, total: 0, transactions: [] }),
        { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 0, data: { list: [], next_position: '' } }),
      { headers: { 'content-type': 'application/json' } });
  };

  const now = Math.floor(Date.now() / 1000) * 1000;
  const goCred = { access_token: 'SYNTHETIC-TOKEN', merchant_id: 'SYNTHETIC-MERCHANT', qris_static: 'unused' };
  const spCred = { token: 'B:synthetic', merchant_id: '12', store_id: '34', qris_static: 'unused' };
  const row = v => ({ credential: encrypt(JSON.stringify(v), key) });

  await provider.getProviderFor('gopay', { fetch: record('gopay-feed') })
    .getTransactions(row(goCred), key, now - 60000);
  await provider.getProviderFor('shopeepay', { fetch: record('shopee-feed') })
    .getTransactions(row(spCred), key, now - 60000);

  console.log(JSON.stringify(captures, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
