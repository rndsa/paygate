// Local source/VM checks; opt-in native Chromium fixture via PLAYWRIGHT_PYTHON.
// No server, provider, real credentials, or browser storage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import ejs from 'ejs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('Shopee password wizard replaces importer with labelled native dialog and separate secrets', () => {
  const view = ejs.render(read('views/pages/accounts.ejs'), { config: { labUnofficialEnabled: true, labUserId: 7 }, user: { id: 7 } });
  for (const id of ['spLoginDialog', 'spStartForm', 'spOtpForm', 'spStoreForm', 'spIdentifier', 'spMerchantPassword', 'spPaygatePassword', 'spConsent', 'spOtp', 'spChoice', 'spQris', 'spAutoCheck', 'spStartSubmit', 'spVerifySubmit', 'spFinishSubmit', 'spLoginError']) assert.ok(view.includes(`id="${id}"`), id);
  assert.match(view, /<dialog[^>]*id="spLoginDialog"[^>]*aria-labelledby="spLoginTitle"/);
  assert.match(view, /Password Shopee[^<]*bukan PayGate/);
  assert.match(view, /Password PayGate[^<]*bukan Shopee/);
  for (const id of ['spMerchantPassword', 'spPaygatePassword']) assert.match(view, new RegExp(`<input[^>]*id="${id}"[^>]*type="password"[^>]*autocomplete="off"`));
  for (const id of ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword', 'spConsent', 'spOtp', 'spChoice', 'spQris', 'spAutoCheck']) assert.ok(view.includes(`for="${id}"`), `label ${id}`);
  assert.doesNotMatch(read('public/js/pages.js'), /localStorage|sessionStorage/);
  assert.match(view, /telepon, email, atau username/i);
});

test('Shopee session import is owner-scoped and absent from the client view', () => {
  const owner = ejs.render(read('views/pages/accounts.ejs'), { config: { labUnofficialEnabled: true, labUserId: 7 }, user: { id: 7 } });
  for (const id of ['spGuideDialog', 'spConnectDialog', 'spToken', 'spMerchant', 'spStore', 'spCQris', 'spPassword', 'spConnectSubmit']) assert.ok(owner.includes(`id="${id}"`), id);
  assert.match(owner, /token B:/);
  const client = ejs.render(read('views/pages/accounts.ejs'), { config: { labUnofficialEnabled: true, labUserId: 7 }, user: { id: 8 } });
  assert.doesNotMatch(client, /spGuideDialog|spConnectDialog|spToken|data\.metadata\.token/);
  const pages = read('public/js/pages.js');
  assert.match(pages, /shopee-guide/); assert.match(pages, /shopee-connect-cancel/);
  assert.match(pages, /shopeeImportReady/);
});

function apiHarness(data, ok = false, status = 503) {
  const requests = [], logs = [];
  const document = { cookie: 'paygate_csrf=synthetic-csrf', querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const window = { matchMedia: () => ({}) };
  vm.runInNewContext(read('public/js/app.js'), { document, window, console: {warn: (...args) => logs.push(args)}, fetch: async (url, opts) => { requests.push({ url, ...opts }); return { ok, status, json: async () => data }; } });
  return { api: window.PayGate.api, requests, logs };
}

test('API errors show client guidance and send safe diagnostic details only to console', async () => {
  const id = '918bd087-7f5c-489e-b36e-3545cb799f7c';
  const h = apiHarness({ error: 'Login ditolak', code: 'AUTH_REJECTED', diagnostic: { id, stage: 'otp_request', provider_status: 400, cookie: 'NEVER_EXPOSE', password: 'NEVER_EXPOSE', body: { raw: 'NEVER_EXPOSE' } }, raw: 'NEVER_EXPOSE' });
  await assert.rejects(h.api('/api/accounts/login/start', { method: 'POST', body: '{}' }), error => {
    assert.ok(error.diagnostic, 'safe diagnostic metadata retained');
    assert.deepEqual(JSON.parse(JSON.stringify(error.diagnostic)), { id, stage: 'otp_request', provider_status: 400 });
    assert.equal(error.code, 'AUTH_REJECTED');
    assert.equal(error.message, 'Login ditolak');
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0][0], '[PayGate] Request failed');
    const logged = JSON.parse(JSON.stringify(h.logs[0][1]));
    assert.deepEqual(logged, {event:'api_request_failed', http_status:503, code:'AUTH_REJECTED', id, stage:'otp_request', provider_status:400});
    assert.doesNotMatch(JSON.stringify(h.logs), /NEVER_EXPOSE|synthetic-csrf/);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /NEVER_EXPOSE|\[object Object\]/);
    assert.equal(Object.isFrozen(error.diagnostic), true);
    return true;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.equal(h.requests[0].credentials, 'same-origin');
});

test('API retains safe local stage and retry deadline without suggesting OTP was sent', async () => {
  const retry_at=Date.now()+720000;
  const h=apiHarness({error:'Password PayGate salah',code:'REAUTH',retry_at,diagnostic:{stage:'reauth',provider_status:null}});
  await assert.rejects(h.api('/api/accounts/login/start'), error=>{
    assert.equal(error.diagnostic.stage,'reauth');assert.equal(error.retry_at,retry_at);
    assert.match(error.message,/Tunggu sampai/);assert.doesNotMatch(error.message,/otp_request/);return true;
  });
});

test('API ignores malformed messages and diagnostics rather than stringifying raw objects', async () => {
  const h = apiHarness({ detail: { secret: 'NEVER_EXPOSE' }, error: 'Safe error', code: { raw: 'NEVER_EXPOSE' }, diagnostic: { id: '<script>NEVER_EXPOSE</script>', stage: { raw: 'NEVER_EXPOSE' }, provider_status: '400 NEVER_EXPOSE' } });
  await assert.rejects(h.api('/api/accounts/login/start'), error => {
    assert.equal(error.message, 'Safe error');
    assert.equal(error.code, undefined);
    assert.equal(error.diagnostic, undefined);
    assert.doesNotMatch(error.message, /NEVER_EXPOSE|\[object Object\]/);
    return true;
  });
});

test('API fallback is actionable without a code-only message or secret logging', async () => {
  const h=apiHarness({error:{raw:'NEVER_EXPOSE'}},false,502);
  await assert.rejects(h.api('/api/accounts/login/start?secret=NEVER_EXPOSE',{method:'POST',body:'NEVER_EXPOSE'}),e=>{
    assert.match(e.message,/Coba kembali nanti atau hubungi administrator/);
    assert.doesNotMatch(e.message,/502|NEVER_EXPOSE/);return true;
  });
});

const nativeFocusFixture = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
fixture = json.load(sys.stdin)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors, network = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
    page.set_content('<body data-page="accounts" data-lab-owner="true"><style>.hidden{display:none}</style>' + fixture['view'] + '</body>')
    page.add_script_tag(content=fixture['app'])
    page.evaluate('''() => {
      window.calls = []; window.pending = []; window.closeCount = 0;
      spLoginDialog.addEventListener('close', () => window.closeCount++);
      PayGate.api = (url, opts = {}) => {
        const call = {url, ...opts}; calls.push(call);
        return new Promise((resolve, reject) => pending.push({...call, resolve, reject}));
      };
    }''')
    page.add_script_tag(content=fixture['pages'])
    state = {
      'accounts': [{'provider': provider, 'status': 'configured'} for provider in ['gopay', 'shopeepay']],
      'lab': {'enabled': True, 'owner': True, 'providers': [{'provider': provider, 'configured': True} for provider in ['gopay', 'shopeepay']]},
      'login': {'gopay': {'available': True}, 'shopeepay': {'available': True}}
    }
    def reply(url, data):
        page.wait_for_function('(url) => pending.some(r => r.url === url)', arg=url)
        page.evaluate('([url, data]) => pending.splice(pending.findIndex(r => r.url === url), 1)[0].resolve(data)', [url, data])
    def expires():
        return page.evaluate('Date.now() + 60000')
    reply('/api/accounts', state)
    opener = '#spBody [data-action="shopee-guide"]'
    page.locator(opener).click()
    page.locator('#spGuideDialog [data-action="shopee-browser"]').click()
    page.locator('#spIdentifier').fill('synthetic-owner')
    page.locator('#spMerchantPassword').fill('synthetic-shopee-password')
    page.locator('#spPaygatePassword').fill('synthetic-paygate-password')
    page.locator('#spConsent').check()
    page.locator('#spStartSubmit').click()
    outcome, focus = fixture['outcome'], fixture['focus']
    login = {'ok': True, 'step': 'store', 'attempt_id': 'synthetic-attempt', 'expires_at': expires(), 'choices': [{'id': 'choice-1', 'label': 'Toko sendiri'}]}
    if outcome != 'cancel-start':
        reply('/api/accounts/shopee/login/start', login)
        reply('/api/accounts', state)
        page.locator('#spQris').fill('synthetic-qris')
        page.locator('#spFinishSubmit').click()
    if outcome == 'success':
        reply('/api/accounts/shopee/login/finish', {'ok': True, 'expiry_source': 'local_lease', 'expires_at': expires()})
    else:
        page.locator('#spLoginDialog [data-action="shopee-cancel"]').last.click()
    page.wait_for_function('closeCount === 1 && !spLoginDialog.open')
    assert page.locator(opener).is_disabled(), 'closed request holds opener disabled'
    assert page.evaluate('document.activeElement === document.body'), 'native close reproduces BODY while busy'
    if focus == 'refresh':
        page.locator('[data-action="refresh-accounts"]').focus()
    elif focus == 'gopay':
        page.locator('#gpBody [data-action="gopay-login"]').click()
        assert page.evaluate('document.activeElement.id') == 'gpPhone'
    if outcome == 'success':
        reply('/api/accounts', state)
        reply('/api/accounts/test', {'ok': True})
        state['accounts'][1]['status'] = 'active'
    elif outcome == 'cancel-start':
        reply('/api/accounts/shopee/login/start', login)
        reply('/api/accounts/shopee/login/cancel', {'ok': True})
    else:
        reply('/api/accounts/shopee/login/cancel', {'ok': True})
        reply('/api/accounts/shopee/login/finish', {'ok': True, 'expiry_source': 'local_lease', 'expires_at': expires()})
    reply('/api/accounts', state)
    page.wait_for_function('!document.querySelector(\'#spBody [data-action="shopee-guide"]\').disabled')
    active = page.evaluate('({tag: document.activeElement.tagName, id: document.activeElement.id, ...document.activeElement.dataset})')
    if focus == 'refresh':
        assert active.get('action') == 'refresh-accounts', active
    elif focus == 'gopay':
        assert active.get('id') == 'gpPhone', active
    else:
        assert active.get('action') == 'shopee-guide' and active.get('provider') == 'shopeepay', active
    assert not page.locator('#spLoginDialog').evaluate('(el) => el.open')
    assert page.locator('#spStartForm').is_visible() is False, 'closed dialog remains closed after late response'
    for id in ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword', 'spOtp', 'spQris']:
        assert page.locator('#' + id).input_value() == '', id
    posts = page.evaluate('calls.filter(c => c.method === "POST").map(c => c.url)')
    expected = ['/api/accounts/shopee/login/start']
    if outcome != 'cancel-start': expected.append('/api/accounts/shopee/login/finish')
    expected.append('/api/accounts/test' if outcome == 'success' else '/api/accounts/shopee/login/cancel')
    assert posts == expected, posts
    assert not errors, errors
    assert not network, network
    print(json.dumps({'active': active, 'pageerrors': errors, 'network': network}))
    browser.close()
`;

for (const outcome of ['success', 'cancel-start', 'cancel-finish']) for (const focus of ['body', 'refresh', 'gopay'])
test(`Shopee native ${outcome} restores usable opener without stealing ${focus} focus`, { skip: !process.env.PLAYWRIGHT_PYTHON }, () => {
  const result = spawnSync(process.env.PLAYWRIGHT_PYTHON, ['-B', '-c', nativeFocusFixture], {
    input: JSON.stringify({ outcome, focus, view: ejs.render(read('views/pages/accounts.ejs'), { config: { labUnofficialEnabled: true, labUserId: 7 }, user: { id: 7 } }), app: read('public/js/app.js'), pages: read('public/js/pages.js') }),
    encoding: 'utf8', timeout: 60000
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).network, []);
});

test('Shopee secret input limits match backend reauthentication boundary', () => {
  const view = read('views/pages/accounts.ejs');
  assert.match(view, /id="spMerchantPassword"[^>]*maxlength="128"/);
  assert.match(view, /id="spPaygatePassword"[^>]*minlength="8"[^>]*maxlength="128"/);
  assert.match(view, /id="spOtp"[^>]*pattern="\[0-9\]\{6\}"[^>]*minlength="6"[^>]*maxlength="6"/);
});
