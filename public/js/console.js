/* Console Log: read-only, same-origin requests; no polling or browser persistence. */
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  if (!byId('consolePage')) return;
  const levels = { info: 'Info', warn: 'Peringatan', error: 'Error' };
  const modules = { auth: 'Autentikasi', gopay: 'GoPay', shopeepay: 'ShopeePay', accounts: 'Akun', orders: 'Order', apikeys: 'API Keys', settings: 'Pengaturan', system: 'Sistem' };
  const periods = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  // Latest-activity view: no filters; always the newest events, refreshed automatically.
  let since = Date.now() - periods['30d'];
  let busy = false, generation = 0;
  let denied = false, failed = false, retryPage = null;

  function controls() {
    byId('consoleRefresh').disabled = denied;
  }
  function latest() {
    since = Date.now() - periods['30d'];
    load(0, [null]);
  }

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const date = value => new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
  function render(entries) {
    byId('consoleList').replaceChildren();
    byId('consoleTerminalBody').replaceChildren();
    for (const entry of entries) {
      // Screen-reader/keyboard anchor: hidden list keeps a per-entry Detail button.
      const row = node('li', 'console-entry');
      const meta = node('div', 'console-entry-meta');
      const time = node('time', 'console-time', date(entry.created_at));
      time.setAttribute('datetime', new Date(entry.created_at).toISOString());
      meta.append(time, node('span', 'console-level console-level-' + entry.level, levels[entry.level]), node('span', 'console-module', modules[entry.module]));
      const content = node('div', 'console-entry-content');
      content.append(node('p', 'console-summary', entry.summary), node('span', 'console-event', '#' + entry.id + ' · ' + entry.event));
      const button = node('button', 'console-button console-detail-button', 'Detail');
      button.type = 'button'; button.dataset.id = String(entry.id);
      button.setAttribute('aria-label', 'Lihat detail aktivitas #' + entry.id);
      button.addEventListener('click', () => detail(entry.id));
      row.append(meta, content, button);
      byId('consoleList').appendChild(row);
      renderTerminalLine(entry);
    }
  }
  // Terminal view: one syslog-style line per event. Same sanitized DTO only.
  const pad2 = n => String(n).padStart(2, '0');
  function termStamp(ms) {
    const d = new Date(ms);
    return pad2(d.getDate()) + ' ' + d.toLocaleString('id-ID', { month: 'short' }) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function termLine(entry) {
    return '[' + termStamp(entry.created_at) + '] ' +
      entry.level.toUpperCase().padEnd(5) + ' ' +
      (entry.module || '-').padEnd(10) + ' ' +
      (entry.code || 'OK').padEnd(12) + ' ' +
      entry.event + (entry.stage ? ' · ' + entry.stage : '') +
      (entry.http_status ? ' · HTTP ' + entry.http_status : '') +
      (entry.duration_ms != null ? ' · ' + entry.duration_ms + 'ms' : '') +
      ' — ' + entry.summary + '  #' + entry.id + '\n';
  }
  function renderTerminalLine(entry) {
    const code = byId('consoleTerminalBody');
    const line = document.createElement('span');
    line.className = 'console-tline console-tline-' + entry.level;
    line.textContent = termLine(entry);
    line.dataset.id = String(entry.id);
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.setAttribute('aria-label', 'Detail aktivitas #' + entry.id);
    line.addEventListener('click', () => detail(entry.id));
    line.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); detail(entry.id); } });
    code.appendChild(line);
  }
  const fields = {
    id: 'ID aktivitas', created_at: 'Waktu', level: 'Tingkat', module: 'Modul', event: 'Peristiwa', summary: 'Ringkasan',
    code: 'Kode', request_id: 'ID permintaan', stage: 'Tahap', http_status: 'Status HTTP', provider_status: 'Status provider',
    duration_ms: 'Durasi (ms)', upstream_code: 'Kode upstream', upstream_request_id: 'ID permintaan upstream'
  };
  // Mirror the server's closed vocabulary; unknown metadata is never copied.
  const eventNames = new Set('AUTH_LOGIN AUTH_LOGOUT AUTH_PASSWORD AUTH_LOGOUT_ALL GOPAY_LOGIN_START GOPAY_LOGIN_VERIFY GOPAY_LOGIN_FINISH GOPAY_LOGIN_CANCEL SHOPEE_LOGIN_START SHOPEE_LOGIN_VERIFY SHOPEE_LOGIN_FINISH SHOPEE_LOGIN_CANCEL ACCOUNT_TEST ACCOUNT_RESUME ACCOUNT_PAUSE ACCOUNT_DELETE ORDER_CREATE ORDER_CHECK APIKEY_CREATE APIKEY_REVOKE APIKEY_REGENERATE SETTINGS_UPDATE PROVIDER_POLL PAYMENT_MATCH PAYMENT_UNMATCHED SERVER_START SERVER_STOP REQUEST_FAILED'.split(' '));
  const codes = new Set('OK SUCCESS MATCHED UNMATCHED NETWORK BAD_RESPONSE PROVIDER_ERROR SAVE_FAILED RUNTIME_UNAVAILABLE INTERNAL_ERROR TIMEOUT FORBIDDEN UNAUTHORIZED INVALID UNSUPPORTED REAUTH COOLDOWN EXPIRED BUSY CHALLENGE AUTH_REJECTED PHONE_REJECTED REQUEST_REJECTED RATE_LIMITED BUSINESS_REJECTED NO_MERCHANT MULTI_OUTLET SCOPE_CHANGED PROVIDER_COOLDOWN PAGE_LIMIT UNCONFIGURED PAUSED CANCELLED TERMS_REQUIRED RETIRED NOT_FOUND CONFLICT VALIDATION_ERROR'.split(' '));
  const stages = new Set('otp_request otp_verify merchant_discovery provider_poll account_test browser_login store_discovery local_validation reauth cooldown attempt_validation otp_validation merchant_selection merchant_save login_start login_verify login_finish login_cancel session_validation transaction_match server_start server_stop'.split(' '));
  const upstreamCodes = new Set(['goid:error:unauthorized', '200020', '200026', '200013', '2010000']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const allow = (set, value) => typeof value === 'string' && set.has(value) ? value : null;
  const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  const positiveId = value => Number.isSafeInteger(value) && value > 0;
  function safeEvent(raw) {
    if (!raw || !positiveId(raw.id) || !Number.isSafeInteger(raw.created_at) || raw.created_at < 0 || raw.created_at > 8640000000000000 ||
        !Object.hasOwn(levels, raw.level) || !Object.hasOwn(modules, raw.module) || !eventNames.has(raw.event) || typeof raw.summary !== 'string' || raw.summary.length > 1000) throw new Error('Invalid event');
    return {
      id: raw.id, created_at: raw.created_at, level: raw.level, module: raw.module, event: raw.event, summary: raw.summary,
      code: allow(codes, raw.code),
      request_id: typeof raw.request_id === 'string' && (/^[0-9a-f]{12}$/.test(raw.request_id) || uuid.test(raw.request_id)) ? raw.request_id : null,
      stage: allow(stages, raw.stage), http_status: status(raw.http_status), provider_status: status(raw.provider_status),
      duration_ms: Number.isSafeInteger(raw.duration_ms) && raw.duration_ms >= 0 && raw.duration_ms <= 86400000 ? raw.duration_ms : null,
      upstream_code: allow(upstreamCodes, raw.upstream_code),
      upstream_request_id: typeof raw.upstream_request_id === 'string' && uuid.test(raw.upstream_request_id) ? raw.upstream_request_id : null
    };
  }
  let diagnostic = null, detailGeneration = 0, detailId = null;
  function clearDetail() {
    diagnostic = null;
    byId('consoleCopy').disabled = true;
    byId('consoleDetailRetry').hidden = true;
    byId('consoleDetailStatus').textContent = '';
    byId('consoleDetailDialog').setAttribute('aria-busy', 'false');
    byId('consoleDetailFields').replaceChildren();
    byId('consoleDetailSummary').textContent = '';
    byId('consoleDetailJson').textContent = '';
    byId('consoleJsonDisclosure').hidden = true;
    byId('consoleJsonDisclosure').open = false;
  }
  async function detail(id) {
    if (denied || !positiveId(id)) return;
    const request = ++detailGeneration;
    detailId = id;
    clearDetail();
    if (!byId('consoleDetailDialog').open) window.PayGate.openModal('consoleDetailDialog');
    byId('consoleDetailDialog').setAttribute('aria-busy', 'true');
    byId('consoleDetailStatus').setAttribute('role', 'status');
    byId('consoleDetailTitle').textContent = 'Detail aktivitas #' + id;
    byId('consoleDetailStatus').textContent = 'Memuat detail…';
    let entry;
    try {
      const data = await get('/api/console/logs/' + id);
      entry = safeEvent(data?.entry);
      if (entry.id !== id) throw new Error('Mismatched detail');
    } catch (error) {
      if (request !== detailGeneration || !byId('consoleDetailDialog').open) return;
      byId('consoleDetailDialog').setAttribute('aria-busy', 'false');
      if (error.status === 401 || error.status === 403) { deny(error.status); return; }
      byId('consoleDetailStatus').setAttribute('role', 'alert');
      byId('consoleDetailStatus').textContent = error.status === 404 ? 'Aktivitas tidak tersedia. Catatan mungkin sudah melewati masa retensi atau tidak dapat diakses.' : 'Detail gagal dimuat. Coba lagi atau tutup untuk kembali ke daftar.';
      byId('consoleDetailRetry').hidden = error.status === 404;
      return;
    }
    if (request !== detailGeneration || !byId('consoleDetailDialog').open) return;
    diagnostic = entry;
    byId('consoleDetailDialog').setAttribute('aria-busy', 'false');
    byId('consoleDetailSummary').textContent = diagnostic.summary;
    for (const [key, label] of Object.entries(fields)) {
      if (key === 'summary') continue;
      const value = diagnostic[key];
      const text = value === null ? '—' : key === 'created_at' ? date(value) : key === 'level' ? levels[value] : key === 'module' ? modules[value] : String(value);
      const field = node('div', 'console-detail-field');
      field.append(node('dt', 'console-detail-label', label), node('dd', 'console-detail-value', text));
      byId('consoleDetailFields').appendChild(field);
    }
    byId('consoleDetailJson').textContent = JSON.stringify(diagnostic, null, 2);
    byId('consoleJsonDisclosure').hidden = false;
    byId('consoleDetailStatus').textContent = 'Detail siap. JSON hanya berisi metadata diagnostik.';
    byId('consoleCopy').disabled = false;
  }
  byId('consoleDetailClose').addEventListener('click', () => byId('consoleDetailDialog').close());
  byId('consoleDetailRetry').addEventListener('click', () => detail(detailId));
  byId('consoleDetailDialog').addEventListener('close', () => {
    ++detailGeneration; detailId = null;
    clearDetail();
    const opener = byId('consoleDetailDialog')._opener;
    if (!denied && opener?.isConnected) opener.focus();
  });
  byId('consoleCopy').addEventListener('click', () => {
    if (diagnostic) window.PayGate.copyText(JSON.stringify(diagnostic, null, 2), 'JSON diagnostik tersalin.');
  });
  // PayGate.api does not preserve HTTP status. This GET-only wrapper needs it
  // to distinguish expired sessions from access denial without parsing prose.
  async function get(url) {
    const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error('Console request failed'), { status: response.status });
    return response.json();
  }
  function deny(status) {
    denied = true; busy = false; ++generation; ++detailGeneration;
    clearDetail();
    if (byId('consoleDetailDialog').open) byId('consoleDetailDialog').close();
    byId('consoleResults').setAttribute('aria-busy', 'false');
    controls();
    byId('consoleList').replaceChildren();
    byId('consoleTerminalBody').replaceChildren();
    byId('consoleStatus').textContent = status === 401 ? 'Sesi berakhir atau tidak dapat diverifikasi. Masuk kembali untuk melihat aktivitas.' : 'Console Log memerlukan akses admin. Masuk dengan akun admin yang berwenang.';
    byId('consoleStatus').setAttribute('role', 'alert');
    byId('consoleSessionLink').hidden = false;
    byId('consoleSessionLink').focus();
    byId('consoleRetry').hidden = true;
  }
  async function load() {
    if (denied) return;
    const request = ++generation;
    retryPage = true;
    busy = true; failed = false; controls();
    byId('consoleRetry').hidden = true;
    byId('consoleStatus').setAttribute('role', 'status');
    byId('consoleList').replaceChildren();
    byId('consoleTerminalBody').replaceChildren();
    byId('consoleResults').setAttribute('aria-busy', 'true');
    byId('consoleStatus').textContent = 'Memuat aktivitas…';
    const params = new URLSearchParams({ since: String(since), limit: '30' });
    let data;
    try {
      data = await get('/api/console/logs?' + params);
      if (!Array.isArray(data?.entries)) throw new Error('Invalid response');
      data = { entries: data.entries.map(safeEvent) };
    } catch (error) {
      if (request !== generation) return;
      busy = false; failed = true;
      byId('consoleResults').setAttribute('aria-busy', 'false');
      byId('consoleStatus').setAttribute('role', 'alert');
      if (error.status === 401 || error.status === 403) deny(error.status);
      else {
        byId('consoleStatus').textContent = error.status === 422 ? 'Filter tidak valid. Periksa filter lalu terapkan kembali.' : 'Aktivitas gagal dimuat. Coba lagi atau muat ulang secara manual.';
        byId('consoleRetry').hidden = false;
      }
      controls();
      return;
    }
    if (request !== generation) return;
    render(data.entries);
    busy = false; controls();
    byId('consoleUpdated').textContent = 'Dimuat ' + date(Date.now()) + ' · Pembaruan manual';
    byId('consoleResults').setAttribute('aria-busy', 'false');
    byId('consoleStatus').textContent = data.entries.length ? data.entries.length + ' aktivitas ditampilkan. Terbaru lebih dulu.' : 'Belum ada aktivitas untuk filter ini. Coba periode atau filter lain.';
  }
  byId('consoleRefresh').addEventListener('click', latest);
  // Fast console: auto-refresh every 5 seconds while the tab is visible.
  const REFRESH_MS = 5000;
  setInterval(() => {
    if (!denied && !busy && !failed && !document.hidden) latest();
  }, REFRESH_MS);
  byId('consoleRetry').addEventListener('click', () => { if (!busy && retryPage) load(); });
  load();
})();
