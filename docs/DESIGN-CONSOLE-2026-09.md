# PayGate / Studio redesign + Console Log

## Brief and chosen direction
Client-facing self-hosted payment workspace. Redesign the whole visual system,
not another glow overlay: calm fintech workspace, disciplined navigation,
precise data hierarchy and readable, accessible forms. Stripe informs hierarchy,
Linear informs workspace navigation/alignment, Sentry informs log scanability.
No cloned brand assets. User delegates design selection and execution.

Alternatives: marketing/bento dashboard rejected (wastes working space); neon
terminal throughout rejected (wrong for merchant clients). Chosen: neutral
paper/slate workspace, restrained chosen accent, compact technical Console only.
Maintain working dark/light toggle and selected accent, all existing consent,
authentication, provider, QRIS, cooldown and status gates. System fonts only.
Mobile 320/390, tablet, desktop; real keyboard controls; no fake chart data.

## Console product contract
A separate `/console` navigation page for authenticated admins, not a shell.
Records start when installed; no retroactive inference or invented history.
Persist in SQLite, survive restart; retain 30 days or latest 10,000 events
(global bound). Show that retention clearly. Immutable from dashboard, no delete
or arbitrary command/run-log/file APIs. Log failure must not interrupt payments.

Capture relevant application activity: completed auth actions, provider login
steps, account controls, order actions, API keys/settings mutations, error
responses on known routes, background provider polling attempts, transaction
matching, server start/stop. Do not record successful background skips/status
refreshes or Console's own reads (noise/recursion). No request/reply content.

## API contract shared across implementation tasks
GET `/api/console/logs`: strict admin session; user sees own user_id events plus
safe system events (null owner). Filters: `level` info|warn|error, `module`
auth|gopay|shopeepay|accounts|orders|apikeys|settings|system, `since` Unix ms,
`q` ASCII ID/code fragment 0..80 chars, `before` positive integer, `limit` 1..100
(default 30). Invalid/unknown/duplicate/nonstring queries -> 422.
Response `{entries:[Event],next_cursor:number|null,retention_days:30,max_entries:10000}`.
No total needed; use limit+1 query and descending stable integer IDs.
GET `/api/console/logs/:id`: same authorization+scope; 404 outside scope.
Response `{entry:Event}`. API errors `{error:'client guidance',code:'...'}`.
Never cache. No browser-posted arbitrary event ingestion in this release.

Event DTO (exact flat fields, null when absent):
`id:number, created_at:number, level:string, module:string, event:string,
 summary:string, code:string|null, request_id:string|null, stage:string|null,
 http_status:number|null, provider_status:number|null, duration_ms:number|null,
 upstream_code:string|null, upstream_request_id:string|null`.
Summary generated from server event catalogue, never supplied arbitrary text.
DB additionally user_id numeric/null for access scope, never public identity.

Backend service `/src/services/console-log.js` exports:
- `recordEvent(input)` safe no-throw -> stored ID or null. Allowed fields are DTO
  metadata plus user_id; ignores all unknown fields. Catalogue event names below.
- `listEvents(userId,filters)` and `getEvent(userId,id)` scoped DTOs.
- `requireConsoleAdmin(req,res,next)` denies API keys/nonadmin/missing/expired/
  revoked sessions and checks current DB role; safe 401/403 responses.
Event enum: AUTH_LOGIN, AUTH_LOGOUT, AUTH_PASSWORD, AUTH_LOGOUT_ALL,
GOPAY_LOGIN_START, GOPAY_LOGIN_VERIFY, GOPAY_LOGIN_FINISH, GOPAY_LOGIN_CANCEL,
SHOPEE_LOGIN_START, SHOPEE_LOGIN_VERIFY, SHOPEE_LOGIN_FINISH, SHOPEE_LOGIN_CANCEL,
ACCOUNT_TEST, ACCOUNT_RESUME, ACCOUNT_PAUSE, ACCOUNT_DELETE,
ORDER_CREATE, ORDER_CHECK, APIKEY_CREATE, APIKEY_REVOKE, APIKEY_REGENERATE,
SETTINGS_UPDATE, PROVIDER_POLL, PAYMENT_MATCH, PAYMENT_UNMATCHED,
SERVER_START, SERVER_STOP, REQUEST_FAILED.
Level derived/validated from known outcome/status: info success, warn 4xx/provider
rejection/cooldown, error 5xx/network/unexpected failure. Do not imply a successful
OTP request proves SMS receipt/payment settlement.

Security: literal allowlists for event, level, module, code, stage, upstream_code;
no raw provider body/title/message, phone/email/username, password/OTP, token,
cookie, headers, request URL/query/body, stack traces, env or argv. Request IDs
only own 12 hex IDs or UUID shape; upstream IDs UUID only. No arbitrary strings.
Browser log page uses textContent or escape helper; no raw HTML interpolation.

## Console UI
Header Console Log with discreet subtitle, refresh button, retention note.
Filters: period (24h, 7d, 30d), level, module, ID/code search; apply/reset.
Accessible chronological list with time, severity, module, human summary; open
entry detail native dialog, copy safe diagnostic JSON. Older page button, back
or reset after filters; no automatic polling by default. Empty/loading/error and
session-expiry states; stale responses discarded by request generation.
Server-only page loaded with `/static/js/console.js?v=studio1` (parent integration).
CSS classes prefix `console-`; new main theme release version `studio1`.

## Ownership / verification
Parent integrates server middleware/event capture, page route/navigation, cache
bump, tests and deployment. All tests use isolated DB/synthetic provider replies;
no live OTP or payment tests for design work. Regression scope: auth/session,
IDOR, retention, unknown/secret fields, SQL filters, XSS, persistence, no duplicate
capture, console read exclusion, redaction, stage correctness and mobile layout.
Deployment via existing backup/health/rollback; preserve credentials and complete
merchant_login_limits rows. Public served asset hashes must match source.
