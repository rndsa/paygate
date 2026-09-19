// Isolated DOM/VM fixture exercising the shipped EJS + JavaScript. No DB or provider calls.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ejs from 'ejs';
const file = name => new URL('../' + name, import.meta.url);
const read = name => readFileSync(file(name), 'utf8');
const NOW = 1788912000000;

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') { this.id = String(value); this.ownerDocument.ids[this.id] = this; }
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    if (['hidden', 'disabled', 'open'].includes(name)) this[name] = true;
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (['hidden', 'disabled', 'open'].includes(name)) this[name] = false; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML injection sink used'); }
  get innerHTML() { throw new Error('HTML sink used'); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name) { const event = { target: this, preventDefault() { this.defaultPrevented = true; } }; for (const fn of this.listeners[name] || []) fn(event); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  get isConnected() { return true; }
}

function dom(html) {
  const document = { ids: {}, getElementById(id) { return this.ids[id] || null; }, createElement(tag) { return new Element(tag, this); } };
  document.body = new Element('body', document);
  const stack = [document.body];
  for (const part of html.matchAll(/<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)([^>]*?)>|([^<]+)/g)) {
    if (part[0].startsWith('<!--')) continue;
    if (part[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (part[2]) {
      const element = document.createElement(part[2]);
      for (const attr of part[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).appendChild(element);
      if (part[2] === 'option' && (!stack.at(-1)._selected || element.getAttribute('selected') !== null)) {
        stack.at(-1).value = element.value; stack.at(-1)._selected = true;
      }
      if (!['input', 'br', 'hr', 'meta', 'link'].includes(part[2])) stack.push(element);
    } else if (part[4]) stack.at(-1)._text += part[4];
  }
  return document;
}
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (id, extra = {}) => ({ id, created_at: NOW - id * 1000, level: 'info', module: 'system', event: 'SERVER_START', summary: 'Server mulai berjalan.', code: null, request_id: null, stage: null, http_status: null, provider_status: null, duration_ms: null, upstream_code: null, upstream_request_id: null, ...extra });
const page = (entries = [], next_cursor = null) => ({ entries, next_cursor, retention_days: 30, max_entries: 10000 });

function harness() {
  for (const name of ['views/pages/console.ejs', 'public/js/console.js']) assert.ok(existsSync(file(name)), `${name} must exist`);
  const html = ejs.render(read('views/pages/console.ejs'));
  const document = dom(html), calls = [], copies = [], timers = [];
  let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const window = { PayGate: {
    openModal(id) { const dialog = document.getElementById(id); dialog._opener = document.activeElement; dialog.showModal(); },
    copyText: async text => copies.push(text)
  } };
  const fetch = (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject }));
  vm.runInNewContext(read('public/js/console.js'), { window, document, fetch, URLSearchParams, Date: Clock, Intl, console,
    localStorage: { getItem() { throw Error('storage forbidden'); }, setItem() { throw Error('storage forbidden'); } },
    sessionStorage: { getItem() { throw Error('storage forbidden'); }, setItem() { throw Error('storage forbidden'); } },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, setTimeout() { throw Error('automatic retry forbidden'); }
  }, { filename: 'console.js' });
  return { html, document, calls, copies, el: id => document.getElementById(id), advance(ms) { now += ms; },
    async reply(index, data, status = 200) { calls[index].resolve({ ok: status >= 200 && status < 300, status, json: async () => data }); await flush(); },
    async reject(index) { calls[index].reject(new Error('SYNTHETIC_NETWORK_SECRET')); await flush(); },
    rows() { return document.getElementById('consoleList').children; },
    rowButton(index = 0) { return descendants(this.rows()[index]).find(node => node.tagName === 'BUTTON'); },
    timers, tick() { for (const t of timers) t.fn(); }
  };
}
const query = call => new URL(call.url, 'https://fixture.invalid').searchParams;

// Optional native integration verifies real focus, text wrapping, helpers and CSS.
// PLAYWRIGHT_PYTHON=/root/camofox-venv/bin/python node --test tests/console-ui.mjs
const nativeFixture = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
fixture = json.load(sys.stdin)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    results = []
    for width in [320, 390, 1280]:
        page = browser.new_page(viewport={'width':width,'height':860}, reduced_motion='reduce')
        errors, network = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
        page.set_content('<!doctype html><html lang="id" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="content">' + fixture['view'] + '</main></body></html>')
        page.add_style_tag(content=fixture['css'])
        page.add_script_tag(content=fixture['app'])
        page.evaluate('''() => {
          window.calls = []; window.pending = []; window.copied = [];
          window.fetch = (url, options) => new Promise((resolve, reject) => { calls.push({url, options}); pending.push({resolve, reject}); });
          PayGate.copyText = async text => copied.push(text);
        }''')
        page.add_script_tag(content=fixture['script'])
        def reply(index, data, status=200):
            page.wait_for_function('(n) => pending.length > n', arg=index)
            page.evaluate('([n,data,status]) => pending[n].resolve({ok:status<400,status,json:async()=>data})', [index,data,status])
        reply(0, fixture['list'])
        page.wait_for_function('consoleList.children.length === 1 && consoleResults.getAttribute("aria-busy") === "false"')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('page overflow',width)
        assert page.locator('#consolePage img').count() == 0
        assert page.locator('#consolePage select, #consolePage input').count() == 0
        page.locator('#consoleList button').focus()
        page.keyboard.press('Enter')
        reply(1, {'entry':fixture['entry']})
        page.wait_for_function('consoleDetailDialog.open && !consoleCopy.disabled')
        assert page.evaluate('document.activeElement.id') == 'consoleDetailClose'
        page.locator('#consoleJsonDisclosure summary').click()
        bounds = page.locator('#consoleDetailDialog').evaluate('(el) => ({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,client:el.clientWidth,scroll:el.scrollWidth})')
        assert bounds['left'] >= 0 and bounds['right'] <= width and bounds['scroll'] <= bounds['client'], (width,bounds)
        assert page.locator('#consoleDetailJson').evaluate('(el) => el.scrollWidth <= el.clientWidth')
        for key in ['Tab'] * 12 + ['Shift+Tab'] * 12:
            page.keyboard.press(key)
            assert page.evaluate('consoleDetailDialog.contains(document.activeElement)'), (width,key,'focus escaped')
        page.locator('#consoleCopy').click()
        page.wait_for_function('copied.length === 1')
        assert json.loads(page.evaluate('copied[0]')) == fixture['entry']
        page.keyboard.press('Escape')
        page.wait_for_function('!consoleDetailDialog.open && consoleDetailJson.textContent === ""')
        assert page.evaluate('document.activeElement.dataset.id') == '42'
        page.locator('#consoleList button').click()
        reply(2, {}, 403)
        page.wait_for_function('!consoleDetailDialog.open && !consoleSessionLink.hidden')
        assert page.evaluate('document.activeElement.id') == 'consoleSessionLink'
        assert page.locator('#consoleList > li').count() == 0
        assert not errors, errors
        assert not network, network
        results.append({'width':width,'pageerrors':errors,'network':network,'overflow':False})
        page.close()
    browser.close()
    print(json.dumps(results))
`;
test('native Chromium: mobile 320/390 + desktop wrapping, keyboard dialog and denial focus', {skip: !process.env.PLAYWRIGHT_PYTHON}, () => {
  const entry = event(42, {summary:'<img src=x onerror=alert(1)>' + 'x'.repeat(300), request_id:'abcdef123456', upstream_request_id:'12345678-1234-1234-1234-123456789abc'});
  const result = spawnSync(process.env.PLAYWRIGHT_PYTHON, ['-c', nativeFixture], {input:JSON.stringify({view:ejs.render(read('views/pages/console.ejs')), script:read('public/js/console.js'), app:read('public/js/app.js'), css:read('public/css/app.css'), entry, list:page([entry])}), encoding:'utf8', timeout:60000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).length, 3);
});

test('native detail GET renders inert text and copies only the sanitized flat diagnostic DTO', async () => {
  const h = harness();
  assert.match(h.html, /<dialog[^>]*id="consoleDetailDialog"[^>]*aria-labelledby="consoleDetailTitle"/);
  const entry = event(42, { summary: '<img src=x onerror=alert(1)>', code: 'NETWORK', request_id: 'abcdef123456', stage: 'provider_poll', http_status: 502, provider_status: 503, duration_ms: 25, upstream_code: 'goid:error:unauthorized', upstream_request_id: '12345678-1234-1234-1234-123456789abc' });
  await h.reply(0, page([entry]));
  assert.match(h.el('consoleList').textContent, /<img src=x onerror=alert\(1\)>/);
  h.rowButton().focus(); h.rowButton().click();
  assert.equal(h.el('consoleDetailDialog').open, true);
  assert.equal(h.calls[1].url, '/api/console/logs/42');
  assert.equal(h.calls[1].options.method, 'GET'); assert.equal(h.calls[1].options.cache, 'no-store');
  assert.equal(h.el('consoleCopy').disabled, true);
  assert.match(h.el('consoleDetailStatus').textContent, /Memuat/);
  await h.reply(1, {entry: {...entry, user_id:7, password:'NEVER_COPY', token:'NEVER_COPY', headers:{cookie:'NEVER_COPY'}, raw:{body:'NEVER_COPY'}}});
  assert.equal(h.el('consoleCopy').disabled, false);
  assert.match(h.el('consoleDetailFields').textContent, /502/);
  assert.match(h.el('consoleDetailFields').textContent, /provider_poll/);
  assert.match(h.el('consoleDetailSummary').textContent, /<img/);
  h.el('consoleCopy').click(); await flush();
  assert.equal(h.copies.length, 1);
  assert.deepEqual(JSON.parse(h.copies[0]), entry);
  assert.doesNotMatch(h.copies[0], /NEVER_COPY|user_id|headers|password|token/);
  assert.deepEqual(JSON.parse(h.el('consoleDetailJson').textContent), entry);
  assert.equal(descendants(h.document.body).filter(node => ['IMG','SCRIPT','TABLE'].includes(node.tagName)).length, 0);
  h.el('consoleDetailClose').click();
  assert.equal(h.el('consoleDetailDialog').open, false);
  assert.equal(h.el('consoleCopy').disabled, true);
  assert.equal(h.el('consoleDetailJson').textContent, '');
  assert.equal(h.document.activeElement, h.rowButton());
});

test('DTO sanitization rejects malformed records and never serializes secret objects or unsupported metadata', async () => {
  const h = harness();
  await h.reply(0, page([event(7)])); h.rowButton().click();
  const input = event(7, { code:'SECRET_TOKEN', stage:{secret:'NEVER_COPY'}, request_id:'session-cookie', upstream_code:'RAW_SECRET', upstream_request_id:'abcdef123456', duration_ms:-1, http_status:'500', provider_status:999, summary:'Safe summary' });
  await h.reply(1, { entry: input });
  h.el('consoleCopy').click(); await flush();
  const copied = JSON.parse(h.copies[0]);
  for (const field of ['code','stage','request_id','upstream_code','upstream_request_id','duration_ms','http_status','provider_status']) assert.equal(copied[field], null, field);
  assert.doesNotMatch(h.document.body.textContent + h.copies[0], /NEVER_COPY|SECRET_TOKEN|RAW_SECRET|session-cookie/);
  h.el('consoleDetailClose').click();
  for (const invalid of [null, event(0), event(4, {created_at:'not a date'}), event(4, {level:'<img>'}), event(4, {event:'RAW_TOKEN'}), event(4, {summary:{body:'NEVER_COPY'}})]) {
    h.el('consoleRefresh').click(); await h.reply(h.calls.length - 1, page([invalid]));
    assert.equal(h.rows().length, 0);
    assert.equal(h.el('consoleResults').getAttribute('aria-busy'), 'false');
    assert.equal(h.el('consoleRetry').hidden, false);
  }
});

test('closed or replaced detail requests are ignored; detail errors stay local except session denial', async () => {
  const h = harness(); await h.reply(0, page([event(20), event(19)]));
  h.rowButton().click(); h.el('consoleDetailClose').click();
  await h.reply(1, {entry:event(20, {summary:'STALE_DETAIL'})});
  assert.equal(h.el('consoleDetailDialog').open, false);
  assert.equal(h.el('consoleDetailJson').textContent, '');
  h.rowButton().click(); h.rowButton(1).click();
  await h.reply(3, {entry:event(19, {summary:'Current detail'})});
  await h.reply(2, {entry:event(20, {summary:'STALE_DETAIL'})});
  assert.equal(h.el('consoleDetailSummary').textContent, 'Current detail');
  h.el('consoleDetailClose').click();
  for (const failure of [404, 500, 'network', 'mismatch']) {
    h.rowButton().click(); const index = h.calls.length - 1;
    if (failure === 'network') await h.reject(index);
    else await h.reply(index, failure === 'mismatch' ? {entry:event(19)} : {error:'SECRET_ERROR'}, typeof failure === 'number' ? failure : 200);
    assert.equal(h.el('consoleCopy').disabled, true);
    assert.equal(h.el('consoleDetailJson').textContent, '');
    assert.equal(h.el('consoleDetailStatus').getAttribute('role'), 'alert');
    assert.match(h.el('consoleDetailStatus').textContent, failure === 404 ? /tidak tersedia|tidak ditemukan/ : /gagal/);
    assert.equal(h.rows().length, 2);
    assert.equal(h.el('consoleDetailRetry').hidden, failure === 404);
    h.el('consoleDetailClose').click();
  }
  h.rowButton().click(); await h.reply(h.calls.length - 1, {error:'SECRET_ERROR'}, 503);
  h.el('consoleDetailRetry').click();
  assert.equal(h.calls.at(-1).url, '/api/console/logs/20');
  await h.reply(h.calls.length - 1, {entry:event(20)});
  assert.equal(h.el('consoleCopy').disabled, false);
  h.el('consoleDetailClose').click(); h.rowButton().click();
  await h.reply(h.calls.length - 1, {}, 401);
  assert.equal(h.rows().length, 0);
  assert.equal(h.el('consoleDetailDialog').open, false);
  assert.equal(h.el('consoleSessionLink').hidden, false);
  assert.equal(h.el('consoleDetailJson').textContent, '');
  assert.doesNotMatch(h.document.body.textContent, /SECRET_ERROR|STALE_DETAIL/);
});

test('list and detail remain empty after concurrent session denial; closed stale failures never reopen dialogs', async () => {
  const h = harness(); await h.reply(0, page([event(10)]));
  h.rowButton().click(); h.el('consoleRefresh').click();
  await h.reply(2, {}, 403);
  await h.reply(1, {entry:event(10)});
  assert.equal(h.rows().length, 0);
  assert.equal(h.el('consoleDetailJson').textContent, '');
  assert.equal(h.el('consoleDetailDialog').open, false);
  assert.equal(h.el('consoleCopy').disabled, true);
  assert.equal(h.document.activeElement.id, 'consoleSessionLink');
  const closed = harness(); await closed.reply(0, page([event(11)]));
  closed.rowButton().click(); closed.el('consoleDetailClose').click();
  await closed.reject(1);
  assert.equal(closed.el('consoleDetailDialog').open, false);
  assert.equal(closed.el('consoleDetailStatus').textContent, '');
  assert.equal(closed.el('consoleSessionLink').hidden, true);
  const source = read('public/js/console.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|sendBeacon|XMLHttpRequest|setTimeout/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
});

test('network, malformed payload and HTTP errors offer a manual retry without leaking response text', async () => {
  for (const failure of ['network', 'malformed', 422, 500]) {
    const h = harness();
    await h.reply(0, page([event(10)]));
    h.el('consoleRefresh').click();
    if (failure === 'network') await h.reject(1);
    else await h.reply(1, { error: '<script>SYNTHETIC_SECRET</script>', entries: 'malformed' }, typeof failure === 'number' ? failure : 200);
    assert.equal(h.el('consoleResults').getAttribute('aria-busy'), 'false');
    assert.equal(h.rows().length, 0, 'old results must not masquerade as the failed page');
    assert.equal(h.el('consoleStatus').getAttribute('role'), 'alert');
    assert.match(h.el('consoleStatus').textContent, /gagal|tidak valid/i);
    assert.doesNotMatch(h.document.body.textContent, /SYNTHETIC_SECRET|SYNTHETIC_NETWORK_SECRET|script/);
    assert.equal(h.el('consoleRetry').hidden, false);
    h.el('consoleRetry').click();
    assert.equal(h.calls[2].url, h.calls[1].url, 'retry keeps filters');
    await h.reply(2, page([event(9)]));
    assert.equal(h.rows().length, 1);
    assert.equal(h.el('consoleRetry').hidden, true);
  }
});

test('401 and 403 clear displayed logs and present explicit session/admin guidance', async () => {
  for (const status of [401, 403]) {
    const h = harness(); await h.reply(0, page([event(10)], 10));
    h.el('consoleRefresh').click();
    await h.reply(1, {error:'SYNTHETIC_SECRET', code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN'}, status);
    assert.equal(h.rows().length, 0);
    assert.equal(h.el('consoleResults').getAttribute('aria-busy'), 'false');
    assert.equal(h.el('consoleSessionLink').hidden, false);
    assert.match(h.el('consoleStatus').textContent, status === 401 ? /Sesi.*Masuk kembali/ : /akses admin/);
    assert.equal(h.el('consoleSessionLink').getAttribute('href'), '/login');
        assert.equal(h.el('consoleRefresh').disabled, true);
    assert.doesNotMatch(h.document.body.textContent, /SYNTHETIC_SECRET/);
  }
});

test('initial list is an accessible read-only GET with loading, retention, chronological cards and empty state', async () => {
  const h = harness();
  assert.match(h.html, /<h1[^>]*>Console Log<\/h1>/);
  assert.match(h.html, /30 hari/); assert.match(h.html, /10\.000/);
  assert.match(h.html, /<ol[^>]*id="consoleList"/);
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url, 'https://fixture.invalid').pathname, '/api/console/logs');
  assert.deepEqual(Object.fromEntries(query(h.calls[0])), { since: String(NOW - 30 * 86400000), limit: '30' });
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.el('consoleResults').getAttribute('aria-busy'), 'true');
  assert.match(h.el('consoleStatus').textContent, /Memuat/);
  await h.reply(0, page([event(12), event(11, {level:'warn', summary:'Pemeriksaan perlu ditinjau.'})]));
  assert.equal(h.el('consoleResults').getAttribute('aria-busy'), 'false');
  assert.equal(h.rows().length, 2);
  assert.match(h.rows()[0].textContent, /Server mulai berjalan/);
  assert.match(h.rows()[1].textContent, /Peringatan/);
  assert.equal(h.rowButton().dataset.id, '12');
  assert.ok(descendants(h.rows()[0]).some(node => node.tagName === 'TIME' && node.getAttribute('datetime')));
  h.el('consoleRefresh').click();
  await h.reply(1, page());
  assert.equal(h.rows().length, 0);
  assert.match(h.el('consoleStatus').textContent, /Belum ada aktivitas/);
});

test('auto-refresh polls latest while visible and stops after denial', async () => {
  const h = harness();
  assert.equal(h.timers.length, 1, 'one auto-refresh timer registered');
  assert.equal(h.timers[0].ms, 5000);
  await h.reply(0, page([event(90)]));
  h.tick();
  assert.equal(h.calls.length, 2, 'tick triggers refresh');
  assert.deepEqual(Object.fromEntries(query(h.calls[1])), { since: String(NOW - 30 * 86400000), limit: '30' });
  await h.reply(1, page([event(91)]));
  h.tick();
  assert.equal(h.calls.length, 3, 'ticks keep refreshing');
  await h.reply(2, page([event(92)]));
});
