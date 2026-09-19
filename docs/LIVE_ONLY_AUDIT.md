# Live-only scope audit

Date: 2026-09-08. Source audited: `/root/paygate`. Audit only; no production code, tests, environment, deployment, or database modified. Only this report written.

## Updated requirement / parent handoff

**Latest user correction supersedes original preservation request: `riwayat mock hapus`. Delete known Mock history, not preserve it.** Parent reports handling backup, deletion of `provider='mock'` orders/transactions from live DB, and disabling `ENABLE_MOCK_PAY`. This audit did not perform or verify those operations. Real-provider records must remain untouched. All recommendations below use corrected requirement.

Deletion of Mock history does **not** prove every remaining GoPay/ShopeePay record real: older source could generate dummy QRIS under real-provider names. Preserve uncertain real-provider records honestly, suppress payment QR, exclude from live totals. Do not relabel or delete them automatically.

## Boundary and key findings

- Frontend: EJS pages + same-origin vanilla JS/CSS. Backend: Express ESM monolith. Database: built-in `node:sqlite`, WAL. No cache service. Dependencies: Express, EJS, bcryptjs, qrcode; no new dependency needed.
- Authentication: SQLite-backed dashboard sessions, CSRF; API keys resolve tenant only for `/api/orders`. Merchant feed: fixed private GoPay/ShopeePay endpoints with encrypted server-side credentials.
- Runtime source/deployment split: audit `/root/paygate`; context says deployed `/opt/paygate`, environment `/etc/paygate/paygate.env`, database `/var/lib/paygate/paygate.db`. Runtime paths not opened by audit. LAB OFF is supplied context, not fresh runtime verification.
- Active Mock remains despite production flag default: `src/routes/orders.js:26` defaults omitted provider to `mock`; `src/services/provider.js:267-270` returns `MockAdapter` for every unknown name; `src/services/poller.js:6-45` owns random settlement, direct Mock settlement, and always-started Mock timer.
- `src/routes/dashboard.js:39` invokes Mock cycle from authenticated manual polling. Disabling flag alone leaves all active simulation code and API/UI/config promises in place.
- `src/routes/orders.js:119-132` labels every non-Mock record `lab_unofficial:true` and returns stored QR/payload. `public/js/pages.js:116-145` trusts those labels; not enough provenance to distinguish old fake QR.
- `tests/changes.diff:514-531,644-659` documents older fallback `generateMockQris` for missing/broken real-provider QR and dummy QRIS with valid CRC. Historical patch is evidence of possible generation path, **not proof of affected DB rows**. No database inventory performed.
- `src/routes/dashboard.js:12-22` totals all providers, omits provider from recent orders; UI calls paid records `Lunas`. This can mix simulations/unknown legacy with actual feed matches.
- Current real-account checks already enforce explicit owner, LAB flag, complete env, active status, previous validation, amount limit, post-QR-render account recheck, strict matching, cooldown, durable pause. Keep these; `active` alone on an old stored account is not proof of a connection.

## Smallest implementation change set

No module renames, provider framework, new dependency, or replacement auth stack. Keep internal LAB names and opt-in flag: “live-only” means no simulation, **not** provider-approved or production-safe.

### Backend: 11 existing files

| Exact file | Required change |
|---|---|
| `src/config.js` | Delete `probability`, `mockAutopay`, `mockEnabled`, and unused default-provider machinery. Require provider per order instead of introducing another fallback. Remove Mock `pollIntervalMs`; real interval remains `labPollIntervalMs`. Remove unused configurable `paymentTolerance` rather than suggesting real matching tolerates Rp100. Retain LAB OFF default, explicit `LAB_USER_ID`, all token settings. |
| `src/lib/validate.js` | `isProvider` accepts exactly `gopay` and `shopeepay` for new writes. Reject mock, empty, unknown, non-string input. Historical reads must not depend on this write validator. |
| `src/services/provider.js` | Delete `MockAdapter` and now-unneeded DB import; `getProviderFor` throws safe unsupported-provider error for all other names. Preserve fixed origins, timeout, redirect/challenge handling, body cap, strict response/scope parsing and pagination. No speculative login endpoints. |
| `src/services/poller.js` | Delete random generator, Mock cycle, Mock transaction handler, Mock timer/log/imports and obsolete `_test` members. Keep `runLabPollCycle`, owner check, `syncLabAccounts`, real timer, guarded errors, stop cleanup. No timer or upstream activity when LAB OFF. |
| `src/services/lab.js` | Restrict reconciliation/candidate discovery to proven live-origin orders; otherwise old fake real-provider QR can be matched by amount. Preserve ambiguity detection across terminal live orders, account/user/provider scope, time bounds, dedup, atomic claims, durable `next_poll_at`, restart pause and in-flight cancellation. Keep conservative lifetime amount non-reuse against all retained real-provider history. |
| `src/routes/orders.js` | Explicit provider required; delete mock branch and demo payload generation. Keep active/validated connected-account check, Rp100k cap and atomic account recheck. Replace simulation implementation with authenticated, CSRF-protected **410 Gone** tombstone, no order lookup or DB write. Set provenance on new live order. Reads expose truthful origin and displayability; unknown legacy returns no payment QR/payload, never `lab_unofficial:true` merely because provider differs from mock. Preserve original stored statuses/txids, clearly distinguish recorded claim from verified provenance. Avoid status-read expiry writes for quarantined legacy records. |
| `src/routes/dashboard.js` | Remove `_test.runPollCycle()` from `POST /poll-now`; invoke only real cycle. Separate live-origin metrics from remaining legacy-unverified metrics; no generic combined revenue. Include origin/provider in recent-order rows. Pending metrics use effective expiry, not stale `pending` alone. Only explicit live-origin feed matches qualify for live matched amount. |
| `src/routes/settings.js` | Remove `mock_enabled`, `mock_autopay` and fake default provider. Report real interval and exact-match semantics (`payment_tolerance:0` if retaining compatibility field). Keep runtime settings read-only. |
| `src/setup.js` | Remove emitted `DEFAULT_PROVIDER=mock` and mock setup message. Initial state has no connected account and cannot create orders. Do not auto-enable LAB or choose owner. |
| `src/server.js` | `/api/transactions` needs origin/provenance when joined to legacy orders; real provider name alone cannot distinguish old fake records. Preserve owner-scoped join, unmatched-feed ownership, no raw credential fields. No new public docs allowlist entry needed for this audit. |
| `src/db/index.js` | Small additive provenance migration, no historical row deletion here. Example: `orders.payment_origin TEXT NOT NULL DEFAULT 'legacy_unverified'`; explicit `live` on new orders. Derive known simulation from `provider='mock'` only for compatibility/quarantine if any rows survive parent cleanup. Never bulk-update existing real rows to live. Centralize shared classification/predicate here rather than adding a new abstraction file. |

Provenance caveat: additive default quarantines pre-existing genuine LAB orders too. This is deliberate fail-closed behavior, not a finding that they were simulated. Read-only inventory and individually supported reclassification can be a separate approved task. Without durable provenance, payload/CRC/provider-only checks cannot establish trustworthy historical live origin. Do not use guessed timestamps as migration cutoff.

For retained unknown legacy transactions, suppress real-payment claims and keep manual-review labels. If old unmatched real-provider feed rows cannot be distinguished, mark them unverified rather than counted as proven live. No need to change historical provider/status/amount/txid values.

### UI: 9 existing files

| Exact file | Required change |
|---|---|
| `public/js/pages.js` | Delete `canSimulate`, simulation action, Mock defaults/options/fallbacks, demo create/detail logic. Load `/api/accounts` fail-closed; only selectable known providers with enabled+owner+configured+active+validated metadata. Disable create launch/submit while loading, failed, or no eligible account; clear stale selection on refresh. `finally` must recompute eligibility, not blindly re-enable submit. Refresh eligibility on opening dialog; backend remains authoritative. Historical unknown rows show “legacy / not verified,” no QR, payload-copy or active polling. Live detail uses explicit provenance and PNG allowlist, pending/unexpired gate. Dashboard and transactions show real matched amount separately from retained unknown history; never call old simulated/unknown claims `Lunas`. Settings use real interval/exact match. |
| `public/js/app.js` | Replace global `info` toast's LAB-owner/demo ternary with truthful unofficial-risk/status wording. |
| `views/layout.ejs` | Remove DEMO/Mock-active global banner. Keep unofficial/ToS warning; disconnected state says account not connected, orders disabled. Bump changed static asset query version because production caches assets seven days. |
| `views/login.ejs` | Remove payment-demo hero, simulated-payment feature and global “no real money” claim. Neutral dashboard login plus unofficial-risk notice; LAB flag alone does not prove connected merchant. Bump asset version consistently. |
| `views/pages/orders.ejs` | Remove Mock option, demo titles, `btnSimulate`. Initially disabled create actions and empty/disabled provider selection; account-connection guidance. Keep named dialogs, explicit labels, risk consent, amount limit, no payment guarantee. |
| `views/pages/accounts.ejs` | Remove “use Mock,” “default stays Mock” guidance. Explain disconnected state without claiming direct merchant login exists. Preserve setup guidance and risk warning until research gate passed. |
| `views/pages/settings.ejs` | Remove Mock/default selector or replace with read-only “explicit connected provider required.” Real poll interval and exact-match explanation; retain appearance/password sections. |
| `views/pages/transactions.ejs` | Replace mixed Mock/feed introduction with real feed and retained legacy-unverified explanation. Preserve precision/manual-review warning. |
| `views/pages/docs.ejs` | Replace all Mock examples/defaults and active simulation instructions. Document provider-required create, unavailable-account 503, simulation 410, live vs legacy metadata and QR suppression; retain risk/expiry/amount-matching caveats. |

`views/pages/dashboard.ejs` need not change: existing stat/recent-order containers can render segregated data from `pages.js`; its `/orders` link only navigates. If changing navigation CTA to explicit disabled creation rather than opening Orders page, this file becomes optional tenth UI edit. CSS `.demo-banner` class can remain as internal styling hook; visible content is what must stop claiming demo. Renaming CSS adds unnecessary diff. Sidebar/footer/theme/API-key views need no change.

### Configuration/deploy templates: 3 existing files, future edits only

- `.env.example`: remove `DEFAULT_PROVIDER`, `ENABLE_MOCK_PAY`, `MOCK_AUTOPAY_PROBABILITY`, Mock `POLL_INTERVAL_MS`, unused `PAYMENT_TOLERANCE`; retain LAB owner/flag/real interval. Explain no connected account means no order creation.
- `deploy/paygate.service`: remove explicit Mock environment lines and “mock payment dashboard” description. Preserve hardening and filesystem paths.
- `deploy/install_local.py`: remove forced Mock enable/autopay settings and demo description. If installer normalizes obsolete keys, remove them rather than copying them forward. Installer remains one-time supervised installer, not updater.

Existing `.env`, `/etc/paygate/paygate.env`, deployed unit and `/opt/paygate` are operator-controlled later work, not audit edits. Obsolete env settings must never reactivate deleted functionality even if left behind. Parent cleanup/disabling does not require this audit to touch them.

### Docs: 3 required current docs; 2 historical notes optional

- `README.md`: remove Mock default/demo deployment claims, quick-start simulation, enabled Mock env, simulation security claim; explain disconnected initial state and live-only unofficial limits.
- `docs/API.md`: real-only create/status/list, required provider, connected-account errors, 410 retirement, truthful origin, legacy QR withholding and segregated summary.
- `docs/LAB.md`: remove default Mock/setup/mock polling guidance; real-only controls and warnings; explain unknown legacy quarantine and tests use non-payable fixtures.
- `docs/PROGRESS.md`: append dated implementation/verification result **after actual work**; don't rewrite old test results or assert deploy happened.
- `docs/PENTEST.md`: optional dated superseded-contract note for old Mock guard recommendation. Preserve historical findings/results; not current proof of live-only safety.
- `tests/changes.diff` and historical screenshots: leave archived, not active functionality. Historical fixture use of `mock` or demo is not reason for indiscriminate deletion.

Required minimum: **26 existing runtime/UI/template/current-doc files + affected tests below**, plus this audit. Optional dashboard CTA and historical-doc annotations separate. No package/lockfile dependency changes needed.

## Exact route contract delta

| Route | Target behavior |
|---|---|
| `POST /api/orders/create` | `provider` required, real allowlist only. 422 missing/unknown/mock; 503 disabled/unconfigured/not validated/paused/error/blocked account. No fallback, no QR or insert on rejected request. Existing amount and collision errors retained. |
| `POST /api/orders/:id/simulate-payment` | Authenticated tombstone 410, zero settlement/write. Global auth/CSRF can reject before route; do not promise unauthenticated 410. Full removal with 404 is acceptable but tombstone gives clearer retirement and fewer client ambiguities. |
| `GET /api/orders/:id/status`, `GET /api/orders` | Owner-scoped historical reads; explicit origin, no legacy fake QR and no implication stored paid equals settlement proof. Keep records unchanged. |
| `GET /api/dashboard/summary` | Separate live metrics and retained legacy-unverified metrics. Known Mock history should be zero/absent after parent cleanup, never folded into live totals if residual rows remain. |
| `POST /api/dashboard/poll-now` | Real providers only, respects owner/flag/cooldown; disabled returns clear skipped/unavailable metadata rather than suggesting successful provider contact. |
| `GET /api/transactions` | Scope retained, unmatched transactions visible for manual review, legacy not presented as verified real transfer. |
| `GET /api/settings` | No simulation controls/defaults; real polling interval, exact match, read-only state. |
| `GET /api/accounts`, existing `/test`, `/pause`, `/resume` | Existing lifecycle retained for removal slice. No upstream calls on GET. Login expansion separate, research-gated. |

## Direct merchant login: assessment only, blocked pending proof

Current PayGate login (`src/routes/auth.js`) authenticates **PayGate user**, not GoPay/ShopeePay merchant. `POST /api/accounts` explicitly returns 503 and rejects browser credential collection. `src/services/provider.js:47-49` explicitly audits feed only, not auth/discovery. `getLabAccount` requires complete env; `syncLabAccounts` can overwrite credentials from env. Adding a form cannot bypass these constraints safely.

No upstream merchant-login contract independently researched or proven in this scope. Existing pin in `docs/LAB.md` is third-party feed reference, not authentication approval. **Do not invent password/OTP endpoints, field names, signatures, device headers, challenge bypasses, or “connected” success responses.** Separate research must establish exact official/supported or explicitly understood private login sequence, merchant/store discovery, issued session lifecycle, logout/revocation, refresh, QR ownership and platform permission. Stop on CAPTCHA/device attestation/unsupported challenge; send user to official provider flow.

Minimal conditional server-side design after proof:

1. Keep PayGate session and provider session separate. Login routes under `/api/accounts`, dashboard cookie+CSRF only; explicitly require `req.user.sid`, reject API-key identity, enforce `LAB_USER_ID` and opt-in. Re-authenticate PayGate user before sensitive account replacement. Do not weaken current global middleware.
2. Single bounded in-memory `Map` for unfinished login attempts on current single-process server. Random 32-byte attempt ID bound to user ID, PayGate session ID and provider; short absolute expiry, one active attempt per owner/provider, bounded steps/attempts, cancel on logout/session invalidation. On each step verify session still exists and expiry; restart drops attempts, never resumes half-login. No new queue/store needed for temporary state.
3. State vocabulary generic until provider research: started, challenge-required, awaiting-user-input, exchanging, completed/cancelled/expired/blocked. Transition only from expected current state; consume each challenge once; reject concurrent/replayed verify/resend. GET state reads local metadata only, never upstream.
4. Plaintext password/OTP exists only for bounded current request, never logs/DB/cache/browser storage or response echoes; release references immediately after request. JavaScript cannot guarantee memory zeroization. If provider requires cookies/challenge handles between steps, server-only temporary state, strict body size and expiry. Browser gets opaque attempt ID and safe status/masked hints, never upstream token/cookie. No credentials in URLs or redirects.
5. Store successful provider tokens/session using existing AES-256-GCM `payment_accounts.credential`, scoped to owner/provider/merchant/store. Do not store password/OTP. `configured` after auth/required QR setup; `active` only after successful real feed validation and required ownership/scope checks. Preserve merchant/store/QR immutability when history exists; token rotation must not reset pause/cooldown silently.
6. Credential authority must be explicit: stop startup env sync from overwriting dashboard-issued tokens or disabling accounts because env missing. Small additive `credential_source` metadata (env vs dashboard) if both import paths retained; alternatively choose DB-only after one approved migration. Existing `getLabAccount`/`syncLabAccounts` must change together. This is separate from deleting Mock.
7. Durable provider backoff remains in `payment_accounts.next_poll_at`; temporary Map alone is insufficient against reconnect/restart spam. Durable login-attempt counters/cooldown required once provider auth contract/rate limits known; reuse current DB, not new dependency. User+IP+provider budgets, bounded timeouts, no automatic password/OTP retry or silent resume.
8. Allowlisted auth origins/paths determined by research, HTTPS, redirects rejected unless specifically validated flow, capped bodies, safe error codes. Existing `src/server.js:132` logs full errors: auth adapter must catch/sanitize errors before generic handler or handler must log allowlisted fields only. Never log request bodies, token headers, cookies, upstream error objects or secrets.

Conditional additional footprint: extend `src/routes/accounts.js`, `src/services/lab.js`, `src/services/provider.js`, `src/db/index.js`, `public/js/pages.js`, `views/pages/accounts.ejs`, tests and docs. Logout cleanup may touch `src/routes/auth.js` and `/api/logout-all` in `src/server.js`; per-step DB-session validation remains mandatory. No auth implementation warranted yet.

## Test impact / acceptance gates

| Test file | Impact |
|---|---|
| `tests/backend.mjs` | Largest rewrite: remove production mock opt-in/autopay/create/settle assumptions; retain env precedence, auth, CSRF, IDOR, invalid API key, validation, expiry and settings checks. Seed isolated historical rows directly for read-only/quarantine assertions, not via retired simulation endpoint. Test explicit missing/mock/unknown rejection and unchanged DB counts; forced obsolete env never revives simulation. |
| `tests/provider.mjs` | Add unsupported names/missing/mock factory rejection and no network activity. Existing HTTP/parser/timeout/rate-limit tests retained. `node:test` fake timers named `mock` are legitimate isolated test doubles, not runtime simulation. |
| `tests/lab.mjs` | Change current simulation denial 403 expectation to authenticated 410; adapt removed response/config fields. Add provenance on intentionally real-path fixture orders, unknown-legacy non-reconciliation, no eligible account, invalid QR, stale credential/pause race. Keep cooldown, restart pause, owner scope, duplicate amounts, strict matching, pagination/challenge stop. |
| `tests/ui.test.js` | Replace explicit DEMO/Mock/default/simulation presence assertions with absence of active controls and preserved risk notices. Assert disconnected/failed metadata disabled, truthful historical labels, no legacy payment QR, separated stats, docs 410 and version bump. Preserve CSP, dialogs, focus, theme, motion and read-only settings tests. |
| `tests/ui_smoke.py` | Replace real local Mock create/settle path with unavailable-account gate and historical quarantined detail. Keep non-payable labeled fixture branch for enabled live UI; browser fixtures prove wiring, not upstream login/payment. Assert no simulation button/request, no mock fallback, loading/error/paused/blocked state, no stale submit re-enable, owner+CSRF, QR hidden for legacy. Retain mobile/dialog/keys/password checks. |
| `tests/live_readonly.py` | Replace public demo/banner/assets-version expectations after deployment approval. It writes screenshots under source `tests/ui-artifacts`; not executed in this read-only audit. Public-only read smoke cannot establish connected merchant or payments. |
| `tests/qris.mjs` | No required change: fixture use remains appropriate; CRC/format is explicitly not evidence of merchant ownership or genuine historical payment. Retain all tests. |

Additional regression fixture: valid-CRC old dummy QR with `provider='gopay'`, plus `PAYGATE-DEMO:` payload, unknown provider, null account, real old stored status/txid, and a new live-origin order. Legacy records survive unchanged but never display payment QR, qualify for live totals, or reconcile. Parent's delete-known-Mock task needs separate backup/referential-integrity/count verification; no broad provider inequality deletion.

### Runnable checks

Run from `/root/paygate`, after test changes for new behavior:

```sh
npm test
/root/camofox-venv/bin/python tests/ui_smoke.py
```

Backend/provider/LAB suites copy app into temporary directories and use isolated test DB/credentials; confirm that isolation remains before running. Never `npm start`, import DB module directly with live defaults, run installer, or point tests at `/var/lib/paygate/paygate.db` during this audit.

After separately authorized deployment, public-only smoke (writes screenshots, does not log in or mutate payments):

```sh
/root/camofox-venv/bin/python tests/live_readonly.py
```

Read-only baseline actually executed during audit:

```sh
node --version
node --test tests/qris.mjs tests/ui.test.js
```

Observed: Node `v24.20.0`; **26 tests passed, 0 failed**, exit 0. These are baseline tests of current implementation, including assertions demanding Demo UI; **not proof live-only removal is complete**. Full backend/provider/LAB/browser suites not run. No real merchant login, upstream feed request, payment, deployment, environment change or database read/write performed.
