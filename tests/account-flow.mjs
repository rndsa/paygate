// Local VM + minimal DOM only. No HTTP, provider calls, credentials, or storage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/js/pages.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
export const accountState = (status = 'configured') => ({
  accounts: ['gopay', 'shopeepay'].map(provider => ({ provider, status, last_validated_at: status === 'active' ? 1 : 0 })),
  lab: { enabled: true, owner: true, providers: ['gopay', 'shopeepay'].map(provider => ({ provider, configured: true })) },
  login: { gopay: { available: true }, shopeepay: { available: true } }
});

export function harness() {
  const ids = new Map(), actions = {}, calls = [], pending = [], timers = [];
  const document = { hidden: false };
  // ponytail: model only selectors/events used by account flow; real browser QA owns layout/native dialogs.
  class Element {
    constructor(id = '', parent = null, tagName = 'div') {
      Object.assign(this, { id, parent, tagName, dataset: {}, children: [], attrs: new Map(), listeners: {}, value: '', checked: false, hidden: false, _disabled: false, _html: '' });
      const classes = new Set();
      this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) };
      parent?.children.push(this);
      if (id) ids.set(id, this);
    }
    get disabled() { return this._disabled; }
    set disabled(value) { this._disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      if (this.contains(document.activeElement) && document.activeElement !== this) document.activeElement = document.body;
      this.children = []; this._html = value;
      for (const [, attrs, text] of value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const button = new Element('', this, 'button');
        for (const [, key, val] of attrs.matchAll(/data-(action|provider)="([^"]+)"/g)) button.dataset[key] = val;
        button.disabled = /\bdisabled\b/.test(attrs); button.textContent = text;
      }
    }
    set textContent(value) { this.innerHTML = String(value); }
    get textContent() { return this._html.replace(/<[^>]*>/g, ''); }
    contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; }
    matches(selector) {
      if (selector === '#providerCards [data-action]') return !!this.dataset.action && ids.get('providerCards').contains(this);
      if (selector === '[data-action]') return !!this.dataset.action;
      if (selector === '.card-pad') return ['gpBody', 'spBody'].includes(this.id);
      if (selector === '[id^=gpStep]') return this.id.startsWith('gpStep');
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
      const action = selector.match(/^\[data-action="([^"]+)"\]$/);
      return action ? this.dataset.action === action[1] : selector === this.tagName;
    }
    closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').some(s => child.matches(s.trim())) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    removeAttribute(name) { this.attrs.delete(name); }
    focus() { if (!this.disabled && document.body.contains(this)) document.activeElement = this; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    async emit(name) { for (const listener of this.listeners[name] || []) await listener({ preventDefault() {} }); }
    reportValidity() { return true; }
    reset() { for (const input of this.querySelectorAll('input,textarea')) { input.value = ''; input.checked = input.id === 'spAutoCheck'; } }
  }
  document.body = new Element('body');
  document.body.dataset = { page: 'accounts', labOwner: 'true' };
  document.activeElement = document.body;
  document.getElementById = id => ids.get(id) || null;
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  const add = (id, parent = document.body, tag = 'div') => new Element(id, parent, tag);
  const button = (action, parent) => { const el = add('', parent, 'button'); el.dataset.action = action; return el; };
  const cards = add('providerCards');
  for (const prefix of ['gp', 'sp']) { add(prefix + 'Body', cards); add(prefix + 'Badge', cards); }
  button('refresh-accounts', document.body);
  for (const id of ['spLoginDialog', 'gpLoginDialog']) add(id, document.body, 'dialog');
  for (const [step, submit, inputs] of [
    ['Start', 'Start', ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword', 'spConsent']],
    ['Otp', 'Verify', ['spOtp']], ['Store', 'Finish', ['spChoice', 'spQris', 'spAutoCheck']]
  ]) {
    const form = add('sp' + step + 'Form', ids.get('spLoginDialog'), 'form');
    for (const id of inputs) add(id, form, id === 'spChoice' ? 'select' : id === 'spQris' ? 'textarea' : 'input');
    add('sp' + submit + 'Submit', form, 'button');
  }
  add('spLoginError', ids.get('spLoginDialog')).classList.add('hidden');
  add('spLoginExpiry', ids.get('spLoginDialog'));
  button('shopee-cancel', ids.get('spLoginDialog'));
  for (const id of ['spGuideDialog', 'spConnectDialog']) add(id, document.body, 'dialog');
  const spConnectForm = add('spConnectForm', ids.get('spConnectDialog'), 'form');
  for (const id of ['spToken', 'spMerchant', 'spStore', 'spPassword', 'spConnectConsent', 'spConnectAutoCheck']) add(id, spConnectForm, 'input');
  add('spCQris', spConnectForm, 'textarea');
  add('spConnectError', ids.get('spConnectDialog')).classList.add('hidden');
  add('spConnectSubmit', spConnectForm, 'button');
  button('shopee-connect-cancel', ids.get('spConnectDialog'));
  add('gpLoginError', ids.get('gpLoginDialog')).classList.add('hidden');
  for (const [step, action, inputs] of [
    ['Start', 'start', ['gpPhone', 'gpPaygatePassword', 'gpOtpChannel', 'gpRiskConsent']],
    ['Otp', 'verify', ['gpOtp']], ['Merchant', 'finish', ['gpMerchant', 'gpAutoCheck']]
  ]) {
    const section = add('gpStep' + step, ids.get('gpLoginDialog'));
    for (const id of inputs) add(id, section, id === 'gpMerchant' || id === 'gpOtpChannel' ? 'select' : 'input');
    button('gopay-' + action, section);
  }
  for (const id of ['gpAutoCheck', 'spAutoCheck']) ids.get(id).checked = true;
  const PayGate = {
    api(url, opts = {}) { const call = { url, ...opts }; calls.push(call); return new Promise((resolve, reject) => pending.push({ ...call, resolve, reject })); },
    bindActions(map) { Object.assign(actions, map); },
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    fmtDate: value => String(value),
    openModal(id) { ids.get(id).open = true; },
    closeModal(id) { const el = ids.get(id); el.open = false; void el.emit('close'); }
  };
  vm.runInNewContext(source, { document, PayGate, setInterval: fn => timers.push(fn) }, { filename: 'pages.js' });
  return {
    document, calls, pending, actions, timers, get: id => ids.get(id),
    action: (name, provider = 'gopay') => document.querySelectorAll('[data-action]').find(el => el.dataset.action === name && (!el.dataset.provider || el.dataset.provider === provider)),
    async reply(url, data, error = false) {
      const index = pending.findIndex(call => call.url === url);
      assert.notEqual(index, -1, `pending request ${url}`);
      const [request] = pending.splice(index, 1);
      request[error ? 'reject' : 'resolve'](data); await flush();
    }
  };
}

export async function boot(status) { const h = harness(); await h.reply('/api/accounts', accountState(status)); return h; }

export async function shopeeStore(h, step = 'store') {
  h.actions['shopee-login']();
  h.get('spIdentifier').value = 'synthetic-owner';
  h.get('spMerchantPassword').value = 'synthetic-shopee-password';
  h.get('spPaygatePassword').value = 'synthetic-paygate-password';
  h.get('spConsent').checked = true;
  const start = h.get('spStartForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/start', { ok: true, step, attempt_id: 'synthetic-attempt', expires_at: Date.now() + 60000, choices: [{ id: 'choice-1', label: 'Toko sendiri' }] });
  await h.reply('/api/accounts', accountState());
  await start;
  h.get('spChoice').value = 'choice-1';
  h.get('spQris').value = 'synthetic-qris';
}

for (const [before, action, after, replacement] of [
  ['configured', 'test', 'active', 'pause'], ['paused', 'resume', 'active', 'pause'], ['active', 'pause', 'paused', 'resume']
]) test(`${action} restores focus to enabled ${replacement} control after disable blurs old button`, async () => {
  const h = await boot(before), el = h.action('lab-' + action, 'shopeepay');
  el.focus();
  const mutation = h.actions['lab-' + action](el);
  assert.equal(h.document.activeElement, h.document.body, 'native disable can clear focus');
  await h.reply('/api/accounts/' + action, { ok: true });
  await h.reply('/api/accounts', accountState(after));
  await mutation;
  assert.ok(h.document.activeElement === h.action('lab-' + replacement, 'shopeepay'), 'focus stays on matching provider control');
  assert.equal(h.document.activeElement.disabled, false);
});

test('Shopee cancel/reopen resets activation checkbox and button label together', async () => {
  const h = await boot();
  h.actions['shopee-login']();
  h.get('spAutoCheck').checked = false;
  await h.get('spAutoCheck').emit('change');
  assert.equal(h.get('spFinishSubmit').textContent, 'Simpan saja');
  h.get('spMerchantPassword').value = 'synthetic-secret';
  h.actions['shopee-cancel']();
  assert.equal(h.get('spMerchantPassword').value, '');
  assert.equal(h.get('spAutoCheck').checked, true);
  assert.equal(h.get('spFinishSubmit').textContent, 'Simpan & aktifkan');
  h.actions['shopee-login']();
  assert.equal(h.get('spAutoCheck').checked, true);
  assert.equal(h.get('spFinishSubmit').textContent, 'Simpan & aktifkan');
  assert.equal(h.calls.filter(x => x.method === 'POST').length, 0);
});

for (const action of ['gopay-start', 'gopay-verify', 'gopay-finish']) test(`${action} fails closed with null snapshot; cancel remains usable`, async () => {
  const h = await boot();
  h.actions['gopay-login']();
  const refresh = h.actions['refresh-accounts']();
  await h.reply('/api/accounts', new Error('status unavailable'), true);
  await refresh;
  h.get('gpPaygatePassword').value = 'synthetic-password';
  h.get('gpOtp').value = '123456';
  const before = h.calls.length;
  await assert.doesNotReject(h.actions[action](h.action(action)), 'missing status must not throw pageerror');
  assert.equal(h.calls.length, before, 'no GET or provider POST on unknown status submission');
  assert.equal(h.get('gpLoginError').classList.contains('hidden'), false);
  assert.match(h.get('gpLoginError').textContent, /Status akun/);
  assert.equal(h.get('gpLoginDialog').getAttribute('aria-busy'), null);
  assert.equal(h.action(action).disabled, false);
  assert.equal(h.get('gpPaygatePassword').value, '');
  assert.equal(h.get('gpOtp').value, '');
  await h.actions['gopay-cancel']();
  assert.equal(h.get('gpLoginDialog').open, false);
  assert.equal(h.calls.length, before);
});

test('passive refresh restores changed action without any mutation', async () => {
  const h = await boot('active');
  h.action('lab-pause').focus();
  const refresh = h.actions['refresh-accounts']();
  await h.reply('/api/accounts', accountState('paused'));
  await refresh;
  assert.equal(h.document.activeElement.dataset.action, 'lab-resume');
  assert.equal(h.document.activeElement.dataset.provider, 'gopay');
  assert.equal(h.calls.filter(x => x.method === 'POST').length, 0);
});

test('mutation completion does not steal focus moved to another control', async () => {
  const h = await boot();
  const el = h.action('lab-test'); el.focus();
  const mutation = h.actions['lab-test'](el);
  h.action('refresh-accounts').focus();
  await h.reply('/api/accounts/test', { ok: true });
  await h.reply('/api/accounts', accountState('active'));
  await mutation;
  assert.equal(h.document.activeElement.dataset.action, 'refresh-accounts');
});

for (const [name, check, failure] of [['save only', false, false], ['activate once', true, false], ['failed activation never retries', true, true]]) test(`Shopee ${name} preserves explicit opt-in and clears secrets`, async () => {
  const h = await boot();
  await shopeeStore(h);
  for (const id of ['spMerchantPassword', 'spPaygatePassword', 'spQris']) h.get(id).value = 'synthetic-secret';
  h.get('spAutoCheck').checked = check;
  await h.get('spAutoCheck').emit('change');
  const save = h.get('spStoreForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/finish', { ok: true, expiry_source: 'local_lease', expires_at: Date.now() + 60000 });
  await h.reply('/api/accounts', accountState());
  if (check) await h.reply('/api/accounts/test', failure ? new Error('NETWORK') : { ok: true }, failure);
  await h.reply('/api/accounts', accountState(check && !failure ? 'active' : 'configured'));
  await save;
  assert.deepEqual(h.calls.filter(x => x.method === 'POST').map(x => x.url), ['/api/accounts/shopee/login/start', '/api/accounts/shopee/login/finish', ...(check ? ['/api/accounts/test'] : [])]);
  if (check) assert.deepEqual(JSON.parse(h.calls.find(x => x.url === '/api/accounts/test').body), { provider: 'shopeepay' });
  for (const id of ['spMerchantPassword', 'spPaygatePassword', 'spQris']) assert.equal(h.get(id).value, '');
  assert.equal(h.get('spAutoCheck').checked, true);
  assert.equal(h.get('spFinishSubmit').textContent, 'Simpan & aktifkan');
  assert.equal(h.get('spFinishSubmit').disabled, false);
  assert.equal(h.get('spLoginDialog').getAttribute('aria-busy'), null);
  assert.equal(h.pending.length, 0);
  if (failure) assert.match(h.get('spBody').textContent, /Sesi tersimpan, tetapi belum aktif: NETWORK/);
});

test('several forced refresh callers serialize GETs and all await fresh results', async () => {
  const h = await boot();
  const loads = [h.actions['refresh-accounts'](), h.actions['refresh-accounts'](), h.actions['refresh-accounts']()];
  for (const status of ['configured', 'paused', 'active']) {
    assert.equal(h.pending.length, 1, 'only one GET in flight');
    await h.reply('/api/accounts', accountState(status));
  }
  await Promise.all(loads);
  assert.equal(h.pending.length, 0);
  assert.equal(h.action('lab-pause').disabled, false);
});

test('Shopee save waits behind stale GET, tests once, then reloads active status', async () => {
  const h = await boot();
  await shopeeStore(h);
  const manual = h.actions['refresh-accounts']();
  const save = h.get('spStoreForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/finish', { ok: true, expiry_source: 'local_lease', expires_at: Date.now() + 60000 });
  assert.equal(h.calls.filter(x => x.url === '/api/accounts/test').length, 0, 'afterSave awaits refresh');
  await h.reply('/api/accounts', accountState());
  await h.reply('/api/accounts', accountState());
  await h.reply('/api/accounts/test', { ok: true });
  await h.reply('/api/accounts', accountState('active'));
  await Promise.all([manual, save]);
  assert.equal(h.action('lab-pause', 'shopeepay').disabled, false);
  assert.equal(h.calls.filter(x => x.url === '/api/accounts/test').length, 1);
  assert.equal(h.pending.length, 0);
});

test('failed in-flight GET does not discard final forced reload', async () => {
  const h = await boot();
  const first = h.actions['refresh-accounts'](), final = h.actions['refresh-accounts']();
  await h.reply('/api/accounts', new Error('NETWORK'), true);
  assert.equal(h.pending.length, 1);
  await h.reply('/api/accounts', accountState('active'));
  await Promise.all([first, final]);
  assert.equal(h.action('lab-pause').disabled, false);
});

test('mutation completion queues fresh forced GET behind pending manual refresh', async () => {
  const h = await boot();
  const manual = h.actions['refresh-accounts']();
  let completed = false;
  const mutation = h.actions['lab-test'](h.action('lab-test')).then(() => { completed = true; });
  await h.reply('/api/accounts/test', { ok: true });
  assert.equal(completed, false, 'mutation waits for its final reload, not dropped busy GET');
  assert.equal(h.calls.filter(x => x.url === '/api/accounts').length, 2, 'GETs stay serialized');
  await h.reply('/api/accounts', accountState());
  assert.equal(h.pending.length, 1, 'stale GET followed by final GET');
  assert.equal(h.pending[0].url, '/api/accounts');
  await h.reply('/api/accounts', accountState('active'));
  await Promise.all([manual, mutation]);
  assert.equal(h.action('lab-pause').disabled, false);
  assert.equal(h.action('lab-test'), undefined);
  assert.equal(h.calls.filter(x => x.method === 'POST').length, 1, 'provider mutation never retried');
});

for (const [browser, importer] of [[true, false], [false, true], [false, false]]) test(`Shopee connect availability browser=${browser} importer=${importer} comes from owner metadata`, async () => {
  const h = harness(), state = accountState('unconfigured');
  state.lab.providers.forEach(p => { p.configured = false; });
  state.login.shopeepay = { available: browser, reason: 'CHROMIUM_NOT_READY <unsafe>' };
  state.connection = { shopeepay: { available: importer } };
  await h.reply('/api/accounts', state);
  const allowed = browser || importer;
  assert.equal(!!h.action('shopee-guide', 'shopeepay'), allowed);
  if (allowed) assert.equal(h.action('shopee-guide', 'shopeepay').textContent, 'Hubungkan ShopeePay');
  else { assert.match(h.get('spBody').innerHTML, /CHROMIUM_NOT_READY &lt;unsafe>/); h.actions['shopee-guide'](); assert.ok(!h.get('spGuideDialog').open); }
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
});

for (const gate of ['dom', 'owner', 'enabled']) test(`Shopee ${gate} owner gate blocks dialog and form submissions`, async () => {
  const h = await boot(); h.actions['shopee-login']();
  const state = accountState();
  if (gate === 'dom') h.document.body.dataset.labOwner = 'false'; else state.lab[gate] = false;
  const refresh = h.actions['refresh-accounts'](); await h.reply('/api/accounts', state); await refresh;
  h.get('spMerchantPassword').value = 'must-clear';
  h.get('spPaygatePassword').value = 'must-clear';
  await h.get('spStartForm').emit('submit');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  for (const id of ['spMerchantPassword', 'spPaygatePassword']) assert.equal(h.get(id).value, '');
  await h.actions['shopee-cancel'](); h.actions['shopee-login'](); assert.equal(h.get('spLoginDialog').open, false);
});

for (const form of ['Start', 'Otp', 'Store']) test(`Shopee ${form} form fails closed after status GET fails`, async () => {
  const h = await boot(); h.actions['shopee-login']();
  const refresh = h.actions['refresh-accounts'](); await h.reply('/api/accounts', new Error('status unavailable'), true); await refresh;
  for (const id of ['spMerchantPassword', 'spPaygatePassword', 'spOtp']) h.get(id).value = 'must-clear';
  const before = h.calls.length;
  await h.get('sp' + form + 'Form').emit('submit');
  assert.equal(h.calls.length, before);
  assert.match(h.get('spLoginError').textContent, /Status akun/);
  for (const id of ['spMerchantPassword', 'spPaygatePassword', 'spOtp']) assert.equal(h.get(id).value, '');
  await h.actions['shopee-cancel']();
  assert.equal(h.get('spLoginDialog').open, false);
});

test('Shopee password and OTP requests have exact separate fields; double submit sends once and focus reaches next step', async () => {
  const h = await boot(); h.actions['shopee-login']();
  for (const [id, value] of [['spIdentifier', '  owner@example.test  '], ['spMerchantPassword', 'synthetic-shopee'], ['spPaygatePassword', 'synthetic-paygate']]) h.get(id).value = value;
  h.get('spConsent').checked = true;
  const start = h.get('spStartForm').emit('submit'); await h.get('spStartForm').emit('submit');
  assert.deepEqual(JSON.parse(h.pending.find(c => c.method === 'POST').body), { identifier: 'owner@example.test', merchant_password: 'synthetic-shopee', password: 'synthetic-paygate', consent: true });
  for (const id of ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword']) assert.equal(h.get(id).value, '');
  await h.reply('/api/accounts/shopee/login/start', { ok: true, step: 'otp', attempt_id: 'attempt-otp', expires_at: Date.now() + 60000 });
  await h.reply('/api/accounts', accountState()); await start;
  assert.equal(h.document.activeElement, h.get('spOtp'));
  assert.equal(h.get('spOtpForm').hidden, false);
  h.get('spOtp').value = '123456';
  const verify = h.get('spOtpForm').emit('submit'); await h.get('spOtpForm').emit('submit');
  assert.equal(h.get('spOtp').value, '');
  assert.deepEqual(JSON.parse(h.pending.find(c => c.method === 'POST').body), { attempt_id: 'attempt-otp', otp: '123456' });
  await h.reply('/api/accounts/shopee/login/verify', { ok: true, step: 'store', attempt_id: 'attempt-otp', expires_at: Date.now() + 60000, choices: [{ id: 'id"<x>', label: '<img src=x>' }] });
  await h.reply('/api/accounts', accountState()); await verify;
  assert.equal(h.document.activeElement, h.get('spChoice'));
  assert.equal(h.get('spStoreForm').hidden, false);
  assert.match(h.get('spChoice').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.get('spChoice').innerHTML, /<img|value="id"/);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 2);
});

test('Shopee failed OTP stops attempt and visibly disables resubmission; no timer retries', async () => {
  const h = await boot(); await shopeeStore(h, 'otp'); h.get('spOtp').value = '123456';
  const verify = h.get('spOtpForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/verify', new Error('CHALLENGE'), true);
  await h.reply('/api/accounts', accountState()); await verify;
  assert.equal(h.get('spOtp').value, '');
  assert.equal(h.get('spVerifySubmit').disabled, true);
  h.get('spOtp').value = '654321'; await h.get('spOtpForm').emit('submit');
  for (const timer of h.timers) await timer();
  assert.equal(h.calls.filter(c => c.url === '/api/accounts/shopee/login/verify').length, 1);
  assert.match(h.get('spLoginError').textContent, /CHALLENGE/);
});

test('Shopee failure cancel/reopen restores enabled start inputs and fresh consent', async () => {
  const h = await boot(); await shopeeStore(h, 'otp'); h.get('spOtp').value = '123456';
  const verify = h.get('spOtpForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/verify', new Error('AUTH_REJECTED'), true);
  await h.reply('/api/accounts', accountState()); await verify;
  const cancel = h.actions['shopee-cancel']();
  assert.equal(h.get('spLoginDialog').open, false);
  await h.reply('/api/accounts/shopee/login/cancel', { ok: true }); await cancel;
  h.actions['shopee-login']();
  assert.equal(h.get('spStartSubmit').disabled, false);
  assert.equal(h.get('spIdentifier').disabled, false);
  assert.equal(h.document.activeElement, h.get('spIdentifier'));
  assert.equal(h.get('spConsent').checked, false);
  assert.equal(h.get('spStartForm').hidden, false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/cancel')).length, 1);
});

test('Shopee cancel during start clears secrets, closes immediately and discards late login result', async () => {
  const h = await boot(); h.actions['shopee-login']();
  for (const id of ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword']) h.get(id).value = 'synthetic-secret';
  h.get('spConsent').checked = true;
  const start = h.get('spStartForm').emit('submit');
  await h.get('spLoginDialog').emit('cancel');
  assert.equal(h.get('spLoginDialog').open, false);
  for (const id of ['spIdentifier', 'spMerchantPassword', 'spPaygatePassword', 'spOtp']) assert.equal(h.get(id).value, '');
  await h.reply('/api/accounts/shopee/login/start', { ok: true, step: 'otp', attempt_id: 'late-attempt', expires_at: Date.now() + 60000 });
  assert.deepEqual(JSON.parse(h.pending.find(c => c.url.endsWith('/cancel')).body), { attempt_id: 'late-attempt' });
  await h.reply('/api/accounts/shopee/login/cancel', { ok: true });
  await h.reply('/api/accounts', accountState()); await start;
  assert.equal(h.get('spLoginDialog').open, false);
  assert.equal(h.get('spStartForm').hidden, false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/verify') || c.url === '/api/accounts/test').length, 0);
  h.actions['shopee-login'](); assert.equal(h.get('spStartSubmit').disabled, false);
});

test('Shopee cancel pending finish prevents activation after late configured response', async () => {
  const h = await boot(); await shopeeStore(h);
  const finish = h.get('spStoreForm').emit('submit'); await h.get('spStoreForm').emit('submit');
  const cancel = h.actions['shopee-cancel']();
  assert.equal(h.get('spLoginDialog').open, false);
  await h.reply('/api/accounts/shopee/login/cancel', { ok: true }); await cancel;
  await h.reply('/api/accounts/shopee/login/finish', { ok: true, expiry_source: 'local_lease', expires_at: Date.now() + 60000 });
  await h.reply('/api/accounts', accountState()); await finish;
  assert.equal(h.calls.filter(c => c.url.endsWith('/finish')).length, 1);
  assert.equal(h.calls.filter(c => c.url === '/api/accounts/test').length, 0);
  assert.equal(h.get('spQris').value, '');
  assert.equal(h.pending.length, 0);
});

for (const context of ['submit', 'opener']) test(`Shopee cancel restores focus retained on original disabled ${context}, only after reenable`, async () => {
  const h = await boot(); await shopeeStore(h);
  const finish = h.get('spStoreForm').emit('submit');
  const cancel = h.actions['shopee-cancel']();
  const oldFocus = context === 'submit' ? h.get('spFinishSubmit') : h.action('shopee-guide', 'shopeepay');
  assert.equal(oldFocus.disabled, true);
  // Boundary: browsers may retain focus on a disabled/now-hidden control rather than BODY.
  h.document.activeElement = oldFocus;
  await h.reply('/api/accounts/shopee/login/cancel', { ok: true }); await cancel;
  await h.reply('/api/accounts/shopee/login/finish', { ok: true, expiry_source: 'local_lease', expires_at: Date.now() + 60000 });
  assert.equal(h.document.activeElement, oldFocus, 'no restore until final GET re-enables cards');
  await h.reply('/api/accounts', accountState()); await finish;
  assert.equal(h.document.activeElement, h.action('shopee-guide', 'shopeepay'));
  assert.equal(h.document.activeElement.disabled, false);
  assert.equal(h.calls.filter(c => c.url === '/api/accounts/test').length, 0);
});

test('Shopee save response must prove bounded session before any activation request', async () => {
  const h = await boot(); await shopeeStore(h);
  const finish = h.get('spStoreForm').emit('submit');
  await h.reply('/api/accounts/shopee/login/finish', { ok: true });
  assert.equal(h.get('spLoginDialog').open, true);
  assert.match(h.get('spLoginError').textContent, /Respons simpan tidak lengkap/);
  await h.reply('/api/accounts', accountState()); await finish;
  assert.equal(h.calls.filter(c => c.url === '/api/accounts/test').length, 0);
  assert.equal(h.get('spFinishSubmit').disabled, true);
});
