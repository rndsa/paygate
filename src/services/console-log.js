import { db } from '../db/index.js';

// Closed, server-owned vocabulary. Never copy a request/provider message into history.
const catalogue = Object.freeze({
  AUTH_LOGIN: ['auth', 'Login PayGate'],
  AUTH_LOGOUT: ['auth', 'Logout PayGate'],
  AUTH_PASSWORD: ['auth', 'Perubahan kata sandi'],
  AUTH_LOGOUT_ALL: ['auth', 'Logout dari semua perangkat'],
  GOPAY_LOGIN_START: ['gopay', 'Permintaan login GoPay'],
  GOPAY_LOGIN_VERIFY: ['gopay', 'Verifikasi login GoPay'],
  GOPAY_LOGIN_FINISH: ['gopay', 'Penyimpanan sesi merchant GoPay'],
  GOPAY_LOGIN_CANCEL: ['gopay', 'Pembatalan login GoPay'],
  SHOPEE_LOGIN_START: ['shopeepay', 'Permintaan login ShopeePay'],
  SHOPEE_LOGIN_VERIFY: ['shopeepay', 'Verifikasi login ShopeePay'],
  SHOPEE_LOGIN_FINISH: ['shopeepay', 'Penyimpanan sesi merchant ShopeePay'],
  SHOPEE_LOGIN_CANCEL: ['shopeepay', 'Pembatalan login ShopeePay'],
  ACCOUNT_TEST: ['accounts', 'Uji koneksi akun'],
  ACCOUNT_RESUME: ['accounts', 'Permintaan melanjutkan pemeriksaan akun'],
  ACCOUNT_PAUSE: ['accounts', 'Permintaan menjeda pemeriksaan akun'],
  ACCOUNT_DELETE: ['accounts', 'Penghapusan akun'],
  ORDER_CREATE: ['orders', 'Pembuatan pesanan'],
  ORDER_CHECK: ['orders', 'Pemeriksaan pesanan'],
  APIKEY_CREATE: ['apikeys', 'Pembuatan API key'],
  APIKEY_REVOKE: ['apikeys', 'Pencabutan API key'],
  APIKEY_REGENERATE: ['apikeys', 'Penggantian API key'],
  SETTINGS_UPDATE: ['settings', 'Perubahan pengaturan'],
  PROVIDER_POLL: ['system', 'Pemeriksaan transaksi provider'],
  PAYMENT_MATCH: ['orders', 'Pencocokan transaksi pembayaran'],
  PAYMENT_UNMATCHED: ['orders', 'Transaksi tanpa pesanan yang cocok'],
  QRIS_ANALYZE: ['system', 'Analisis payload QRIS'],
  QRIS_TEST_RENDER: ['system', 'Render uji QRIS'],
  SERVER_START: ['system', 'Proses mulai server'],
  SERVER_STOP: ['system', 'Proses penghentian server'],
  REQUEST_FAILED: ['system', 'Permintaan yang tidak berhasil'],
});
const modules = new Set(['auth','gopay','shopeepay','accounts','orders','apikeys','settings','system']);
const levels = new Set(['info','warn','error']);
const errorCodes = new Set(['NETWORK','BAD_RESPONSE','PROVIDER_ERROR','SAVE_FAILED','RUNTIME_UNAVAILABLE','INTERNAL_ERROR','TIMEOUT']);
const warningCodes = new Set([
  'FORBIDDEN','UNAUTHORIZED','INVALID','UNSUPPORTED','REAUTH','COOLDOWN','EXPIRED','BUSY',
  'CHALLENGE','AUTH_REJECTED','PHONE_REJECTED','REQUEST_REJECTED','RATE_LIMITED','BUSINESS_REJECTED',
  'NO_MERCHANT','MULTI_OUTLET','SCOPE_CHANGED','PROVIDER_COOLDOWN','PAGE_LIMIT','UNCONFIGURED',
  'PAUSED','CANCELLED','TERMS_REQUIRED','RETIRED','NOT_FOUND','CONFLICT','VALIDATION_ERROR',
]);
const codes = new Set(['OK','SUCCESS','MATCHED','UNMATCHED', ...errorCodes, ...warningCodes]);
const providerStages = new Set(['otp_request','otp_verify','merchant_discovery','provider_poll','account_test','browser_login','store_discovery']);
const stages = new Set([
  ...providerStages, 'local_validation','reauth','cooldown','attempt_validation','otp_validation',
  'merchant_selection','merchant_save','login_start','login_verify','login_finish','login_cancel',
  'session_validation','transaction_match','server_start','server_stop',
]);
const upstreamCodes = new Set(['goid:error:unauthorized','200020','200026','200013','2010000']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = 'id, created_at, level, module, event, summary, code, request_id, stage, http_status, provider_status, duration_ms, upstream_code, upstream_request_id';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const allow = (set, value) => typeof value === 'string' && set.has(value) ? value : null;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const shapedId = (value, upstream = false) => typeof value === 'string' && (uuid.test(value) || (!upstream && /^[0-9a-f]{12}$/.test(value))) ? value : null;

function severity(input, code, httpStatus, providerStatus) {
  // The public login endpoint returns 503 for provider rejections: preserve known
  // classification instead of misreporting a provider 4xx as an application crash.
  if (errorCodes.has(code)) return 'error';
  if (providerStatus >= 500) return 'error';
  if (warningCodes.has(code) || providerStatus >= 400) return 'warn';
  if (httpStatus >= 500) return 'error';
  if (httpStatus >= 400) return 'warn';
  return allow(levels, input.level) || 'info';
}

const retentionMs = 30 * 86400000;
function pruneEvents() {
  db.prepare('DELETE FROM console_events WHERE created_at<?').run(Date.now() - retentionMs);
  db.exec(`DELETE FROM console_events WHERE id <= (
    SELECT id FROM console_events ORDER BY id DESC LIMIT 1 OFFSET 10000
  )`);
}
// Restart-safe housekeeping; inability to log must never prevent application boot.
try { pruneEvents(); } catch { /* read/write paths retry with safe failure handling */ }

const inputKeys = ['event','user_id','level','module','code','stage','http_status','provider_status','duration_ms','request_id','upstream_code','upstream_request_id'];
export function recordEvent(input) {
  let savepoint = false;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    // Snapshot own data properties once, never invoke metadata getters/coercion.
    // Unknown properties (including accessors) are not inspected at all.
    const snapshot = Object.create(null);
    for (const key of inputKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    input = snapshot;
    if (typeof input.event !== 'string' || !Object.hasOwn(catalogue, input.event)) return null;
    if (input.user_id != null && !positiveId(input.user_id)) return null;
    const [defaultModule, label] = catalogue[input.event];
    const module = ['PROVIDER_POLL','REQUEST_FAILED','PAYMENT_MATCH','PAYMENT_UNMATCHED'].includes(input.event)
      ? allow(modules, input.module) || defaultModule : defaultModule;
    const code = allow(codes, input.code), stage = allow(stages, input.stage);
    const httpStatus = status(input.http_status);
    const providerStatus = providerStages.has(stage) ? status(input.provider_status) : null;
    const level = severity(input, code, httpStatus, providerStatus);
    const summary = `${label}: ${{info:'diproses',warn:'ditolak atau ditunda',error:'gagal'}[level]}.`;
    const duration = Number.isSafeInteger(input.duration_ms) && input.duration_ms >= 0 && input.duration_ms <= 86400000 ? input.duration_ms : null;
    const values = [input.user_id ?? null, Date.now(), level, module, input.event, summary, code,
      shapedId(input.request_id), stage, httpStatus, providerStatus, duration,
      allow(upstreamCodes, input.upstream_code), shapedId(input.upstream_request_id, true)];
    // Savepoints also work inside a caller's transaction, without committing it.
    db.exec('SAVEPOINT console_event_write');
    savepoint = true;
    const row = db.prepare(`INSERT INTO console_events(user_id,created_at,level,module,event,summary,code,request_id,stage,http_status,provider_status,duration_ms,upstream_code,upstream_request_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
    pruneEvents();
    db.exec('RELEASE console_event_write');
    return Number(row.lastInsertRowid);
  } catch {
    if (savepoint) {
      try { db.exec('ROLLBACK TO console_event_write; RELEASE console_event_write'); } catch { /* never mask the business outcome */ }
    }
    return null; // Logging is never allowed to break a payment/auth action.
  }
}

const filterKeys = new Set(['level','module','since','q','before','limit']);
function invalidQuery() {
  return Object.assign(new Error('Filter Console tidak valid.'), { code: 'INVALID_QUERY', status: 422 });
}
function integerFilter(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) throw invalidQuery();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw invalidQuery();
  return result;
}
function validateFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw invalidQuery();
  const result = {limit:30};
  for (const key of Reflect.ownKeys(filters)) {
    if (!filterKeys.has(key)) throw invalidQuery();
    const value = filters[key];
    if (key === 'level' || key === 'module') {
      result[key] = allow(key === 'level' ? levels : modules, value);
      if (!result[key]) throw invalidQuery();
    } else if (key === 'q') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{0,80}$/.test(value)) throw invalidQuery();
      result.q = value;
    } else result[key] = integerFilter(value, key === 'since' ? 0 : 1, key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER);
  }
  return result;
}

export function listEvents(userId, filters = {}) {
  const f = validateFilters(filters);
  const response = {entries:[], next_cursor:null, retention_days:30, max_entries:10000};
  if (!positiveId(userId)) return response;
  pruneEvents();
  const where = ['(user_id=? OR user_id IS NULL)'];
  const values = [userId];
  for (const key of ['level','module','since','before']) {
    if (f[key] === undefined) continue;
    where.push({level:'level=?',module:'module=?',since:'created_at>=?',before:'id<?'}[key]);
    values.push(f[key]);
  }
  if (f.q) {
    // instr uses a literal fragment (not LIKE wildcards) and only safe IDs/codes.
    where.push(`(${['CAST(id AS TEXT)','code','request_id','upstream_code','upstream_request_id'].map(column => `instr(lower(COALESCE(${column},'')),lower(?))>0`).join(' OR ')})`);
    values.push(f.q, f.q, f.q, f.q, f.q);
  }
  const rows = db.prepare(`SELECT ${columns} FROM console_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values, f.limit + 1);
  response.entries = rows.slice(0, f.limit).map(row => ({...row}));
  if (rows.length > f.limit) response.next_cursor = response.entries.at(-1).id;
  return response;
}

// Mount after sessionMiddleware. Always re-check live session + current role,
// including when this guard is reused by the server-rendered Console page.
export function requireConsoleAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const denied = (status, code, error) => res.status(status).json({error, code});
  if (req.apiKey || req.user?.viaApiKey || req.headers?.['x-api-key'] !== undefined || req.headers?.authorization !== undefined) {
    return denied(403, 'FORBIDDEN', 'Console hanya tersedia melalui sesi admin, bukan API key.');
  }
  const user = req.user;
  if (!positiveId(user?.id) || typeof user.sid !== 'string' || !user.sid) {
    return denied(401, 'UNAUTHORIZED', 'Masuk kembali dengan sesi admin PayGate.');
  }
  let live;
  try {
    live = db.prepare(`SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.user_id=? AND s.expires_at>?`).get(user.sid, user.id, Date.now());
  } catch {
    return denied(401, 'UNAUTHORIZED', 'Sesi tidak dapat diverifikasi. Masuk kembali.');
  }
  if (!live) return denied(401, 'UNAUTHORIZED', 'Sesi kedaluwarsa atau dicabut. Masuk kembali.');
  if (live.role !== 'admin') return denied(403, 'FORBIDDEN', 'Console memerlukan akses admin.');
  next();
}

export function getEvent(userId, id) {
  if (!positiveId(userId) || !positiveId(id)) return null;
  pruneEvents();
  const row = db.prepare(`SELECT ${columns} FROM console_events WHERE id=? AND (user_id=? OR user_id IS NULL)`).get(id, userId);
  return row ? { ...row } : null;
}
