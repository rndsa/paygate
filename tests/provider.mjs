// Synthetic fixtures only. No live credentials, upstream calls, or application data.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-provider-'));
const savedEnv = { ...process.env };
const nativeFetch = globalThis.fetch;
let db, checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('PASS', name); }
try {
  cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  cpSync(path.join(root, 'package.json'), path.join(temp, 'package.json'));
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), PAYGATE_DATA_DIR: path.join(temp, 'data'),
    ENCRYPTION_KEY: '11'.repeat(32), COOKIE_SECRET: '22'.repeat(32), LAB_UNOFFICIAL: '0',
    GOPAY_ACCESS_TOKEN: '', SHOPEEPAY_TOKEN: '', MOCK_AUTOPAY_PROBABILITY: '0',
  });
  globalThis.fetch = async () => { throw new Error('Live fetch forbidden in synthetic provider tests'); };
  const moduleAt = file => import(pathToFileURL(path.join(temp, 'src', file)).href);
  ({ db } = await moduleAt('db/index.js'));
  const { encrypt } = await moduleAt('lib/crypto.js');
  const provider = await moduleAt('services/provider.js');
  const key = Buffer.from('11'.repeat(32), 'hex');
  const goCredential = { access_token: 'synthetic-gopay-token-NOT-LIVE', merchant_id: 'SYNTHETIC-MERCHANT', qris_static: 'synthetic-unused-qris' };
  const shopeeCredential = { token: 'B:synthetic-shopee-token-NOT-LIVE', merchant_id: '12', store_id: '34', qris_static: 'synthetic-unused-qris' };
  const row = value => ({ credential: encrypt(JSON.stringify(value), key) });
  const now = Math.floor(Date.now() / 1000) * 1000;
  const since = now - 60_000;
  const json = (value, init = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const goTx = (fields = {}) => ({ id: 'synthetic-gp-1', order_id: 'synthetic-order', merchant_id: goCredential.merchant_id, transaction_status: 'SETTLEMENT', payment_type: 'QRIS', gross_amount: 2500100, currency: 'IDR', transaction_time: new Date(now - 1000).toISOString(), ...fields });
  const goPage = (transactions, fields = {}) => ({ from: 0, size: 100, total: transactions.length, transactions, ...fields });
  const spTx = (fields = {}) => ({ transactionId: 'synthetic-sp-1', merchantId: 12, storeId: 34, status: 3, service: 1, amount: '25.001', createTime: (now - 1000) / 1000, ...fields });
  const spPage = (list, next_position = '') => ({ code: 0, data: { list, next_position } });
  const adapter = (name, fetch) => provider.getProviderFor(name, { fetch });
  const safeError = async (fn, code) => {
    await assert.rejects(fn, error => {
      assert.equal(error.constructor, provider.LabProviderError);
      assert.equal(error.code, code);
      const printable = `${error}\n${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(Object.getOwnPropertyNames(error).map(k => error[k]))}`;
      for (const secret of [goCredential.access_token, shopeeCredential.token, 'SYNTHETIC-RAW-SECRET']) assert.equal(printable.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  };

  await check('Unsupported provider factory rejects missing, mock, unknown and non-string names without network', async () => {
    let calls = 0;
    for (const name of [undefined, null, '', 'mock', 'unknown', 'GOPAY', {}, ['gopay']]) {
      assert.throws(() => provider.getProviderFor(name, { fetch: async () => { calls++; } }), /Unsupported provider/);
    }
    assert.equal(calls, 0);
  });

  await check('GoPay gross_amount is authoritative; transaction_time never replaced by settlement_time', async () => {
    const rows = await adapter('gopay', async () => json(goPage([
      goTx({ real_gross_amount: 1, settlement_time: new Date(now).toISOString() }),
      goTx({ id: 'old-payment', transaction_time: new Date(since - 1).toISOString(), settlement_time: new Date(now).toISOString() }),
    ]))).getTransactions(row(goCredential), key, since);
    assert.deepEqual(rows, [{ txid: 'synthetic-gp-1', amount: 25001, time: now - 1000 }]);
  });

  await check('GoPay rejects malformed rows, wrong scope/currency/status/type, fractional/unsafe money, invalid/outside time', async () => {
    const invalid = [
      null, [], 'bad', ...[
        { merchant_id: 12 }, { merchant_id: 'OTHER' }, { merchant_id: ['SYNTHETIC-MERCHANT'] },
        { currency: 'USD' }, { currency: null }, { currency: 'idr' },
        { transaction_status: 'settlement' }, { transaction_status: undefined, status: 'SETTLEMENT' },
        { transaction_status: 'PENDING' }, { payment_type: 'CARD' }, { payment_type: 'qris' },
        { gross_amount: '2500100' }, { gross_amount: true }, { gross_amount: 2500101 },
        { gross_amount: 100.01 }, { gross_amount: 0 }, { gross_amount: -100 }, { gross_amount: 1e20 },
        { id: null }, { id: '' }, { id: 'x'.repeat(201) }, { id: 'bad\nID' }, { id: ' padded ' },
        { transaction_time: now }, { transaction_time: '2026-02-30T00:00:00Z' },
        { transaction_time: '2026-09-08' }, { transaction_time: new Date(now + 3600_000).toISOString() },
        { transaction_time: new Date(since - 1).toISOString() },
      ].map((patch, index) => goTx({ id: `invalid-${index}`, ...patch })),
    ];
    const rows = await adapter('gopay', async () => json(goPage([
      ...invalid, goTx({ currency: undefined, transaction_time: new Date(since).toISOString() }),
      goTx({ id: 'capture', transaction_status: 'CAPTURE', payment_type: 'GOPAY' }),
    ]))).getTransactions(row(goCredential), key, since);
    assert.deepEqual(rows, [
      { txid: 'synthetic-gp-1', amount: 25001, time: since },
      { txid: 'capture', amount: 25001, time: now - 1000 },
    ]);
  });

  await check('Shopee requires exact numeric status 3/service 1 or 3, safe scope, grouped integer, seconds, exact time window', async () => {
    const invalid = [null, [], 'bad', ...[
      { status: '3' }, { status: 1 }, { service: '1' }, { service: 2 }, { service: undefined },
      { merchantId: 13 }, { storeId: 35 }, { merchantId: [12] }, { merchantId: true },
      { merchantId: 9007199254740992 }, { storeId: 34.1 }, { storeId: '034' },
      { amount: 25001 }, { amount: '25.00' }, { amount: '1,000' }, { amount: '1.000,00' },
      { amount: '1e3' }, { amount: '-1' }, { amount: '0' }, { amount: '9007199254740992' },
      { amount: ' 25.001 ' }, { amount: '1234.567' },
      { transactionId: 1 }, { transactionId: 'x'.repeat(201) }, { transactionId: 'bad\nID' },
      { createTime: String(now / 1000) }, { createTime: now }, { createTime: now / 1000 + 0.1 },
      { createTime: (since - 1000) / 1000 }, { createTime: (now + 3600_000) / 1000 },
    ].map((patch, index) => spTx({ transactionId: `invalid-${index}`, ...patch }))];
    const rows = [], fixtures = [...invalid, spTx(), spTx({ transactionId: 'service-3', service: 3, amount: '25001', createTime: since / 1000 })];
    for (let i = 0; i < fixtures.length; i += 10) {
      rows.push(...await adapter('shopeepay', async () => json(spPage(fixtures.slice(i, i + 10)))).getTransactions(row(shopeeCredential), key, since));
    }
    assert.deepEqual(rows, [
      { txid: 'synthetic-sp-1', amount: 25001, time: now - 1000 },
      { txid: 'service-3', amount: 25001, time: since },
    ]);
  });

  await check('Missing, malformed, oversized tokens and non-string scopes fail before fetch; errors never leak', async () => {
    let calls = 0;
    for (const [name, credential, tokenKey] of [['gopay', goCredential, 'access_token'], ['shopeepay', shopeeCredential, 'token']]) {
      const instance = adapter(name, async () => { calls++; return json(name === 'gopay' ? goPage([]) : spPage([])); });
      const badCredentials = [null, [], {}, 'bad', ...[
        { [tokenKey]: '' }, { [tokenKey]: 123 }, { [tokenKey]: ['token'] },
        { [tokenKey]: 'B:' + 'x'.repeat(4095) }, { [tokenKey]: ' bad ' }, { [tokenKey]: 'bad\r\nsecret' },
        { merchant_id: 12 }, { merchant_id: [] }, { merchant_id: 'a'.repeat(101) },
        { merchant_id: ' scope ' }, { merchant_id: 'a,b' },
        ...(name === 'shopeepay' ? [{ token: 'not-B-token' }, { token: 'B:' }, { store_id: 34 }, { store_id: null }, { store_id: ' 34' }, { merchant_id: '012' }] : []),
      ].map(patch => ({ ...credential, ...patch }))];
      for (const invalid of badCredentials) {
        await safeError(() => instance.getTransactions(row(invalid), key, since), 'AUTH_REJECTED');
        assert.equal((await instance.validateCredential(row(invalid).credential, key)).ok, false);
      }
      for (const account of [undefined, {}, { credential: 'SYNTHETIC-RAW-SECRET' }, { credential: encrypt('not json SYNTHETIC-RAW-SECRET', key) }]) {
        await safeError(() => instance.getTransactions(account, key, since), 'AUTH_REJECTED');
      }
      assert.equal((await instance.validateCredential(row(credential).credential, key)).ok, true);
      assert.equal((await instance.validateCredential(row({ ...credential, qris_static: 'SYNTHETIC QRIS MERCHANT NAME' }).credential, key)).ok, true);
      assert.equal((await instance.validateCredential(row({ ...credential, qris_static: 'x'.repeat(4097) }).credential, key)).ok, false);
      for (const invalid of [undefined, '123', NaN, Infinity, -1, 0, now + 3600_000, 1.1]) {
        await safeError(() => instance.getTransactions(row(credential), key, invalid), 'BAD_RESPONSE');
      }
      const result = await instance.testConnection({}, key);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'AUTH_REJECTED');
      assert.equal(result.detail, new provider.LabProviderError('AUTH_REJECTED').message);
    }
    assert.equal(calls, 0);
    assert.equal(new provider.LabProviderError('SYNTHETIC-RAW-SECRET').code, 'BAD_RESPONSE');
    assert.equal('syncLabAccounts' in provider, false);
  });

  await check('Fixed fetch-only requests reject redirects; no cookies, browser impersonation, or credential URL overrides', async () => {
    for (const [name, credential, expectedUrl] of [
      ['gopay', goCredential, 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions'],
      ['shopeepay', shopeeCredential, 'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list'],
    ]) {
      const instance = provider.getProviderFor(name, { url: 'https://evil.invalid/', baseUrl: 'https://evil.invalid/', fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin + url.pathname, expectedUrl);
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.ok(init.signal instanceof AbortSignal);
        const headers = new Headers(init.headers);
        for (const key of headers.keys()) assert.doesNotMatch(key, /cookie|origin|referer|user-agent|sec-|fingerprint|device/i);
        if (name === 'gopay') {
          assert.equal(headers.get('authorization'), `Bearer ${credential.access_token}`);
          assert.equal(url.searchParams.get('merchant_ids'), credential.merchant_id);
          assert.equal(url.searchParams.get('start_time'), new Date(since).toISOString());
          assert.equal(url.searchParams.get('statuses'), 'SETTLEMENT,CAPTURE');
          assert.equal(url.searchParams.get('payment_types'), 'QRIS,GOPAY');
          assert.equal(url.searchParams.get('size'), '100');
          assert.equal(url.searchParams.get('from'), '0');
        } else {
          assert.equal(init.method, 'POST');
          const data = JSON.parse(init.body).data;
          assert.equal(data.metadata.token, credential.token);
          assert.equal(data.filter.startTime, since / 1000);
          assert.deepEqual(data.filter.serviceList, [1, 3]);
          assert.equal(data.pageSize, 10);
          assert.deepEqual(data.sorter, { field: 'createTime', order: 'descend' });
          assert.equal(data.next_position, '');
        }
        return json(name === 'gopay' ? goPage([]) : spPage([]));
      }});
      assert.deepEqual(await instance.getTransactions(row({ ...credential, url: 'https://evil.invalid/' }), key, since), []);
      assert.equal((await adapter(name, async () => json(name === 'gopay' ? goPage([]) : spPage([]))).testConnection(row(credential), key)).ok, true);
    }
  });

  await check('HTTP/auth/rate/challenge/schema/network failures sanitized; each request attempted once', async () => {
    for (const [name, credential] of [['gopay', goCredential], ['shopeepay', shopeeCredential]]) {
      const cases = [
        ...[401, 403].map(status => [() => new Response('SYNTHETIC-RAW-SECRET', { status }), 'AUTH_REJECTED']),
        [() => new Response('SYNTHETIC-RAW-SECRET', { status: 429 }), 'RATE_LIMITED'],
        [() => new Response('', { status: 302, headers: { location: 'https://evil.invalid/SYNTHETIC-RAW-SECRET' } }), 'CHALLENGE'],
        [() => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect SYNTHETIC-RAW-SECRET') }); }, 'CHALLENGE'],
        [() => { throw new Error(credential.access_token || credential.token); }, 'NETWORK'],
        [() => new Response('SYNTHETIC-RAW-SECRET', { status: 500 }), 'BAD_RESPONSE'],
        [() => new Response('<html>captcha SYNTHETIC-RAW-SECRET</html>'), 'CHALLENGE'],
        [() => json({ code: 0, data: { captcha_required: true, token: credential.token } }), 'CHALLENGE'],
        [() => json({ msg: 'CAPTCHA_REQUIRED SYNTHETIC-RAW-SECRET' }), 'CHALLENGE'],
        [() => new Response('SYNTHETIC-RAW-SECRET', { headers: { 'content-type': 'application/json' } }), 'BAD_RESPONSE'],
        ...[null, [], {}, 'bad', { code: 'SYNTHETIC-RAW-SECRET' }].map(value => [() => json(value), 'BAD_RESPONSE']),
        ...[200020, 200026, 200013, 2010000, '200026'].map(code => [() => json({ code, msg: `SYNTHETIC-RAW-SECRET ${credential.token}` }), 'AUTH_REJECTED']),
        ...(name === 'gopay' ? [
          { transactions: [] }, { ...goPage([]), transactions: {} }, { ...goPage([]), total: '0' },
          { ...goPage([]), size: -1 }, { ...goPage([]), from: '0' }, { ...goPage([]), total: -1 },
        ] : [
          { code: '0', data: { list: [] } }, { code: 0, data: {} }, { code: 0, data: { list: null } },
          { code: 0, data: { list: [], next_position: 10 } }, { code: 1, data: { list: [] } },
        ]).map(value => [() => json(value), 'BAD_RESPONSE']),
      ];
      for (const [respond, code] of cases) {
        let calls = 0;
        await safeError(() => adapter(name, async () => { calls++; return respond(); }).getTransactions(row(credential), key, since), code);
        assert.equal(calls, 1);
      }
      for (const retryAfter of ['1', '1800', 'invalid', new Date(Date.now() + 3600_000).toUTCString()]) {
        const result = await adapter(name, async () => new Response('', { status: 429, headers: { 'retry-after': retryAfter } })).testConnection(row(credential), key);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'RATE_LIMITED');
        assert.ok(result.retryAfterMs >= 15 * 60_000);
        if (retryAfter === '1800') assert.equal(result.retryAfterMs, 1800_000);
        if (retryAfter.includes('GMT')) assert.ok(result.retryAfterMs > 3590_000);
      }
    }
  });

  await check('Body limit is 1 MiB including streamed bytes; malformed encoding and failed bodies sanitized', async () => {
    for (const [name, credential] of [['gopay', goCredential], ['shopeepay', shopeeCredential]]) {
      const call = respond => adapter(name, async () => respond()).getTransactions(row(credential), key, since);
      const empty = name === 'gopay' ? goPage([]) : spPage([]);
      assert.deepEqual(await call(() => new Response(JSON.stringify(empty).padEnd(1024 * 1024, ' '))), []);
      await safeError(() => call(() => new Response(JSON.stringify(empty).padEnd(1024 * 1024 + 1, ' '))), 'BAD_RESPONSE');
      await safeError(() => call(() => json(empty, { headers: { 'content-length': String(1024 * 1024 + 1) } })), 'BAD_RESPONSE');
      await safeError(() => call(() => new Response(new Uint8Array([0xff]))), 'BAD_RESPONSE');
      let cancelled = false;
      await safeError(() => call(() => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
        cancel() { cancelled = true; },
      }))), 'BAD_RESPONSE');
      assert.equal(cancelled, true);
      await safeError(() => call(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('SYNTHETIC-RAW-SECRET')); } }))), 'NETWORK');
      await safeError(() => call(() => {
        const response = json(empty);
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      }), 'CHALLENGE');
    }
  });

  await check('15-second deadline covers fetch and body even when injected fetch ignores abort', async () => {
    const { mock } = await import('node:test');
    for (const stage of ['fetch', 'body']) {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        let entered, signal;
        const ready = new Promise(resolve => { entered = resolve; });
        const instance = adapter('gopay', async (_url, init) => {
          signal = init.signal;
          if (stage === 'fetch') { entered(); return new Promise(() => {}); }
          return new Response(new ReadableStream({ pull() { entered(); return new Promise(() => {}); } }));
        });
        const pending = safeError(() => instance.getTransactions(row(goCredential), key, since), 'NETWORK');
        await ready;
        mock.timers.tick(15_000);
        await pending;
        assert.equal(signal.aborted, true);
      } finally { mock.timers.reset(); }
    }
  });

  await check('GoPay scans offsets with fixed window, deduplicates; incomplete, looping, inconsistent pages fail closed', async () => {
    let calls = 0, endTime;
    const rows = await adapter('gopay', async url => {
      const params = new URL(url).searchParams;
      const from = Number(params.get('from'));
      assert.equal(from, calls * 100);
      if (endTime) assert.equal(params.get('end_time'), endTime);
      endTime = params.get('end_time');
      calls++;
      const transactions = Array.from({ length: from === 200 ? 1 : 100 }, (_, i) => goTx({ id: `synthetic-offset-${from + i}` }));
      return json(goPage(transactions, { from, total: 201 }));
    }).getTransactions(row(goCredential), key, since);
    assert.equal(calls, 3);
    assert.equal(rows.length, 201);
    assert.equal(rows.at(-1).txid, 'synthetic-offset-200');
    for (const [respond, code, expectedCalls] of [
      [(i) => goPage(Array.from({ length: 100 }, (_, j) => goTx({ id: `limit-${i}-${j}` })), { from: i * 100, total: 301 }), 'PAGE_LIMIT', 3],
      [() => goPage([], { total: 1 }), 'PAGE_LIMIT', 1],
      [() => goPage([goTx()], { from: 0, total: 2 }), 'PAGE_LIMIT', 2],
      [() => goPage([goTx()], { total: 0 }), 'BAD_RESPONSE', 1],
      [(i) => goPage([goTx()], { from: i, total: i + 2 }), 'BAD_RESPONSE', 2],
      [() => goPage(Array.from({ length: 101 }, () => goTx())), 'BAD_RESPONSE', 1],
    ]) {
      let count = 0;
      await safeError(() => adapter('gopay', async () => json(respond(count++))).getTransactions(row(goCredential), key, since), code);
      assert.equal(count, expectedCalls);
    }
    let count = 0;
    assert.deepEqual(await adapter('gopay', async () => json(goPage([goTx()], { from: count++, total: 2 }))).getTransactions(row(goCredential), key, since), [{ txid: 'synthetic-gp-1', amount: 25001, time: now - 1000 }]);
  });

  await check('Shopee follows opaque cursors up to 3 pages, deduplicates; loops and incomplete scans never return partial rows', async () => {
    let calls = 0, endTime;
    const rows = await adapter('shopeepay', async (_url, init) => {
      const data = JSON.parse(init.body).data;
      assert.equal(data.next_position, ['', 'synthetic-cursor-1', 'synthetic-cursor-2'][calls]);
      if (endTime) assert.equal(data.filter.endTime, endTime);
      endTime = data.filter.endTime;
      return json(spPage([spTx(), spTx({ transactionId: `sp-page-${calls}` })], ++calls === 3 ? '' : `synthetic-cursor-${calls}`));
    }).getTransactions(row(shopeeCredential), key, since);
    assert.equal(calls, 3);
    assert.equal(rows.length, 4);
    for (const [cursors, expectedCalls] of [[['a', 'b', 'c'], 3], [['a', 'a'], 2], [['a', 'b', 'a'], 3]]) {
      let count = 0;
      await safeError(() => adapter('shopeepay', async () => json(spPage([spTx()], cursors[count++]))).getTransactions(row(shopeeCredential), key, since), 'PAGE_LIMIT');
      assert.equal(count, expectedCalls);
    }
    for (const invalid of ['x'.repeat(2049), 'bad\ncursor', {}, 1, null]) {
      await safeError(() => adapter('shopeepay', async () => json(spPage([], invalid))).getTransactions(row(shopeeCredential), key, since), 'BAD_RESPONSE');
    }
    await safeError(() => adapter('shopeepay', async () => json(spPage(Array.from({ length: 11 }, () => spTx())))).getTransactions(row(shopeeCredential), key, since), 'BAD_RESPONSE');
    for (const [name, credential] of [['gopay', goCredential], ['shopeepay', shopeeCredential]]) {
      let count = 0;
      await safeError(() => adapter(name, async () => {
        count++;
        if (count === 2) return new Response('SYNTHETIC-RAW-SECRET', { status: 401 });
        return json(name === 'gopay' ? goPage([goTx()], { total: 2 }) : spPage([spTx()], 'a'));
      }).getTransactions(row(credential), key, since), 'AUTH_REJECTED');
      assert.equal(count, 2);
      await safeError(() => adapter(name, async () => json(name === 'gopay'
        ? goPage([goTx(), goTx({ gross_amount: 100 })])
        : spPage([spTx(), spTx({ amount: '1' })]))).getTransactions(row(credential), key, since), 'BAD_RESPONSE');
    }
  });

  await check('Malformed numeric objects cannot trigger coercion errors or return accepted rows', async () => {
    const poison = { valueOf: false, toString: false };
    assert.deepEqual(await adapter('gopay', async () => json(goPage([goTx({ gross_amount: poison })]))).getTransactions(row(goCredential), key, since), []);
    assert.deepEqual(await adapter('shopeepay', async () => json(spPage([spTx({ createTime: poison })]))).getTransactions(row(shopeeCredential), key, since), []);
  });

  await check('Trailing newline never bypasses token, ID, scope, cursor, or amount validation', async () => {
    let calls = 0;
    for (const [name, credential, tokenKey] of [['gopay', goCredential, 'access_token'], ['shopeepay', shopeeCredential, 'token']]) {
      await safeError(() => adapter(name, async () => { calls++; return json(name === 'gopay' ? goPage([]) : spPage([])); })
        .getTransactions(row({ ...credential, [tokenKey]: credential[tokenKey] + '\n' }), key, since), 'AUTH_REJECTED');
    }
    assert.equal(calls, 0);
    assert.deepEqual(await adapter('gopay', async () => json(goPage([goTx({ id: 'synthetic\n' })]))).getTransactions(row(goCredential), key, since), []);
    assert.deepEqual(await adapter('shopeepay', async () => json(spPage([spTx({ amount: '1\n' }), spTx({ transactionId: 'synthetic\n' })]))).getTransactions(row(shopeeCredential), key, since), []);
    await safeError(() => adapter('shopeepay', async () => json(spPage([], 'cursor\n'))).getTransactions(row(shopeeCredential), key, since), 'BAD_RESPONSE');
    const unsafeCode = { toString: () => 'AUTH_REJECTED', secret: 'SYNTHETIC-RAW-SECRET' };
    assert.equal(new provider.LabProviderError(unsafeCode).code, 'BAD_RESPONSE');
  });

  await check('Manual Retry-After delay honors largest duplicate delay or HTTP-date and never falls below 15 minutes', async () => {
    for (const value of ['1200, 1800', `1200, ${new Date(Date.now() + 3600_000).toUTCString()}`, '999999999999999999999999999999999999999']) {
      const result = await adapter('shopeepay', async () => new Response('', { status: 429, headers: { 'retry-after': value } })).testConnection(row(shopeeCredential), key);
      assert.equal(result.code, 'RATE_LIMITED');
      assert.ok(Number.isSafeInteger(result.retryAfterMs));
      if (value === '1200, 1800') assert.equal(result.retryAfterMs, 1800_000);
      else if (value.includes('GMT')) assert.ok(result.retryAfterMs > 3590_000);
      else assert.equal(result.retryAfterMs, Number.MAX_SAFE_INTEGER);
    }
  });

  await check('Full cursor page without continuation metadata cannot claim complete scan', async () => {
    await safeError(() => adapter('shopeepay', async () => json({ code: 0, data: { list: Array.from({ length: 10 }, (_, i) => spTx({ transactionId: `missing-cursor-${i}` })) } }))
      .getTransactions(row(shopeeCredential), key, since), 'PAGE_LIMIT');
  });

  console.log(`PASS ${checks} provider checks (synthetic; zero upstream calls)`);
} finally {
  db?.close();
  globalThis.fetch = nativeFetch;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  rmSync(temp, { recursive: true, force: true });
}
