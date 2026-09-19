# PayGate checkpoint — 2026-09-12, OTP channel selector live

## OTP channel selector (WhatsApp / SMS)

- GoPay login request body now carries `login_type`, an audited closed vocabulary: `otp_whatsapp` (default) or `sms`. Missing/empty/`null` `otp_channel` defaults to WhatsApp; any other value is rejected locally.
- Backend `src/services/login.js`: channel parsed after consent/phone/password validation, before device reservation, so an invalid channel makes zero provider calls. Rejection uses `MerchantLoginError('INVALID', undefined, 'local_validation')` — no raw value echoed, no new stage added to the frozen diagnostic vocabulary.
- Frontend `views/pages/accounts.ejs`: `<select id="gpOtpChannel">` (WhatsApp preselected then SMS) inside `gpStepStart`; help text states no automatic resend. `public/js/pages.js` sends `otp_channel` in the start wizard body and resets the select to `whatsapp` on open.
- Tests: `tests/login.mjs` pins `login_type` in the source-contract body, adds an invalid-channel local rejection, and asserts an explicit `sms` channel reaches the provider body; `tests/ui.test.js` asserts both options and the default-selected attribute; `tests/ui_smoke.py` drives `select_option('sms')` and asserts the posted body; `tests/account-flow.mjs` fake DOM registers `gpOtpChannel` as a select.
- Verification: `node tests/login.mjs` 18/18 PASS; `node --test tests/account-flow.mjs` 32/32; `node --test tests/ui.test.js` 16/16; full `npm test` exit 0.
- Deployed by copying `src/services/login.js`, `views/pages/accounts.ejs`, `public/js/pages.js` to `/opt/paygate`; `systemctl restart paygate` active, `:3000` → 302, served `/static/js/pages.js` contains `otp_channel`.
- Not verified: live GoBiz acceptance of `login_type=sms` (no real OTP sent). Channel choice is source-contract only until a real merchant attempt is made.

# PayGate checkpoint — 2026-09-08, faq1 live

- Corrected brief: browser-managed Shopee password login, no DevTools/token importer UI; GoPay OTP root cause requires actual provider response; legal visual MIT + FAQ + small entry consent popup.
- New Shopee isolated standard Chromium worker, Node JSONL integration and owner/CSRF/terms gate. One active attempt, max 5 starts/hour, no resend, encrypted configured-only scoped credentials. Source-contract fixtures do NOT prove successful live authentication.
- Parent cross-language test passed: actual Python Worker/JSONL drives Node OTP/store/finish and encrypted SQLite; zero provider calls.
- Parent nonroot sandboxed worker probe passed under 768M/256-task transient service: dependencies/browser/form ready true, auth and telemetry blocked. Earlier runtime-only candidate had one native crash; there is no acceptance guarantee.
- New MIT HTML keeps exact raw LICENSE.txt; nine native ToS FAQ entries. Independent DOM/browser legal checks passed both JavaScript/no-JavaScript. At320px popup288×429px, margins16px. Representative ToS mobile390 screenshot visually verified: small centered dialog, no clipping. License/FAQ image analysis returned504; geometry/content checked, not full aesthetic acceptance.
- Asset faq1, substantive terms version 2026-09-08-pw1.
- Review fixes: page CDP blocks every main redirect hop; all subframe requests fail closed to prevent OOPIF redirect bypass. Python/browser21 tests and Node/Python cross contract passed. Parent nonroot sandboxed final worker probe dependency/browser/form ready true.
- GoPay sanitized stage/status/local UUID now distinguishes REAUTH/selection/save (local HTTP status null), native redirect and provider responses. Independent final GoPay18 checks PASS; upstream OTP root cause remains unverified.
- Frontend independent46 checks including9 native focus cases PASS. Full UI fixture exposed request-count/route timing: count captured before click; await exact late cancel and fresh status GET before focus. Parent final full browser `proc_6af171ed406d` exit0, clean stderr,64screenshots `/tmp/paygate-faq1-ui-artifacts-kt_xrkn0`, no JS errors, real legal HTTP/JS/no-JS and password flow fixtures passed. Independent iframe second-cycle review `deleg_b2164a2a` PASS; no known blocker within reviewed scope. Real merchant auth/payment not exercised.

## Deployment and final verification

- Deployed31 changed files, backup `/root/paygate-backups/20260908T175110Z-pre-terms-shopee`. DB integrity ok, business snapshot unchanged, env untouched; systemd browser resource drop-in768MiB/256tasks/LimitCORE0. Actual process UID/GID998, NoNewPrivs1, ProtectHome yes, ProtectSystem strict; service active/enabled. No weakening browser sandbox.
- Parent full final `npm test && node tests/shopee-cross.mjs && /root/camofox-venv/bin/python -B tests/shopee_browser.py && python3 tests/deploy_terms.py && python3 tests/deploy_browser.py && npm audit --omit=dev` exit0 (`proc_a69f7a1c3147`), worker21 and deployment10 regressions, audit0. Native focus opt-in command46/46 separately; npm baseline skips9 native cases because Python opt-in not set.
- Deployed worker empty-form probe under hardened transient nonroot unit: dependency/browser/form ready true. No credential, OTP or auth submit; telemetry blocked in probe mode.
- Public HTTPS readonly `live_readonly.py` and authenticated `live_accounts_readonly.py` exit0 with clean stderr. faq1 asset hashes match;8pages×4widths×2themes, no JS errors/overflow. Password login control available, legacy importer UI absent, raw license download exact. No provider/payment mutations. Artifacts `/tmp/paygate-faq1-live-public-eqjygvmp`, `/tmp/paygate-faq1-live-accounts-51cry2qk`. All69 selected source/runtime files match before final document sync.
- Still not verified: real Shopee merchant password/OTP acceptance, real GoPay OTP delivery/root cause, real transaction feed, payment/settlement. CAPTCHA and unsupported iframe-dependent flows stop. QRIS static entry still required if not captured; token acquisition is web-owned, not DevTools.

## Previous release (historical)

# PayGate checkpoint — 2026-09-08, flow1 live

## Account flow / source licence

- Deployed 24 changed production/docs/licence files with protected updater. Runtime backup `/root/paygate-backups/20260908T163952Z-pre-terms-shopee` mode0700, DB integrity ok, business snapshot/env/unit unchanged, service active/enabled nonroot paygate. Source baseline `/root/paygate-backups/20260908T155226Z-pre-account-flow/source.tgz`. Final selected source/runtime comparison 59 files match.
- MIT licence (Copyright 2026 Carry) added for project code, package metadata, README and fixed public `/license`. Dependencies keep their licences. Deployer ToS states source-only, auditable, AS IS, limited liability subject to mandatory law; no public repository or security-certification claim.
- Consent version `2026-09-08-source-mit`; validly signed previous-version acknowledgement rejected. Compact first visit kept, full details readable; one 320px consent screenshot visually checked with no clipping. Earlier guide/import analyzer attempts timed out; final guide image succeeded below. Full import visual review remains unverified.
- Shopee guide-first flow and authenticated `/docs/SHOPEE_CONNECT.md`: token is secret, B: from source-observed `data.metadata.token` only if portal already exposes it, merchant/store scope must match; stop if unavailable. No verified merchant PW/OTP or universal export method. No request made merely opening guide/import.
- Account controls depend on configured/status/cooldown; active has pause, configured/paused have activation only when allowed, auth/challenge stopped. Explicit checkbox + Simpan & aktifkan saves then sends one separate feed check; uncheck for save-only. No auto OTP resend, session refresh, or failure retry.
- Removed duplicate topbar Info/Settings, dashboard misleading create link, ineffective Transactions polling button/handler; provider option loading labels removed. Transaction provenance now sourced from joined order, unmatched remains null.
- Initial full `npm test && python3 tests/deploy_terms.py && npm audit --omit=dev` exit 0: backend28, provider15, LAB/login/Shopee/terms/render/website groups, QRIS/UI30; audit0. Source scan added lines found no eval/shell=True/pickle/os.system. These initial results are superseded by the post-review run below.
- Independent review identified stale concurrent account refresh, action-change focus loss, Shopee reset-button mismatch, and updated consent missing on GoPay/test/resume APIs. Fixed with regression red→green in `tests/account-flow.mjs`, `tests/login.mjs`, `tests/lab.mjs`. Pause and cancel deliberately remain available without renewed consent so stopping is never blocked.
- Parent final `npm test && python3 tests/deploy_terms.py && npm audit --omit=dev`: exit 0 after fixes (28 backend, 15 provider, all LAB/login/Shopee/terms/render/website integration groups, 46 QRIS/UI/account-flow Node tests; audit 0 vulnerabilities). Parent independent browser rerun exit 0 with clean stderr, 32 PNGs at `/tmp/paygate-flow1-ui-artifacts-yytvec_g`, no console errors/upstream. Final independent review `deleg_a4df4566` passed with empty security_concerns/logic_errors and fresh focused tests. Representative final guide 320×844 visually checked: all text, close and footer actions visible, no overlap/clipping. Full visual/aesthetic acceptance not claimed.
- Final public `tests/live_readonly.py` + `tests/live_accounts_readonly.py`: exit0, clean stderr, normal TLS, flow1 asset hashes match source, actual new ToS + MIT licence and guide downloads verified. Eight authenticated pages at 1280/768/390/320 in light/dark; no JS errors/overflow. Provider requests0, payment mutations0. Consent refreshed once in each test browser. No provider login/feed/payment/settlement verification performed.
- Live merchant login, feed acceptance, payments, settlement, provider permission and full aesthetic acceptance remain unverified.

## Previous compact1 (historical)

## ToS rendering / compact mobile / GoPay error classification

- Deployed 12 changed files through existing protected updater; backup `/root/paygate-backups/20260908T154059Z-pre-terms-shopee`. Service active/enabled, nonroot; DB integrity ok, deployment business snapshot unchanged, existing Shopee paused, zero orders/seen transactions. 54 selected source/runtime files matched before final docs sync. Source backup `/root/paygate-backups/20260908T151442Z-pre-fix-ui-official/source.tgz`.
- Reproduced actual `/tos` `[object Promise]`: `renderPage` used EJS `async:true` without awaiting nested include. Removed unnecessary async template mode (templates contain no await). New real Express `tests/render.mjs` reproduced red then green, and browser tests now check actual response content and all seven terms rows. Previous layout-only PASS did not verify ToS contents.
- Compact first-visit consent card: short risks remain visible, required acknowledgement above expandable full terms; no recurring global warning banner. Mobile 320px accepts without scrolling; ToS table stacks as readable cards. Account connection notices shortened; provider cards use restrained brand colors. Existing terms cookie/version/CSRF unchanged.
- GoPay errors now distinguish HTTP 5xx (`PROVIDER_ERROR`), HTTP 401/403 (`AUTH_REJECTED`), other rejections, challenge bodies and malformed response; timeout corrected to `NETWORK` instead of `EXPIRED`. Sanitized output, no automatic resend/retry, durable cooldown preserved. **User's actual upstream rejection remains undiagnosed; no merchant OTP/feed/payment calls performed.**
- Official API docs researched in `GOPAY_OFFICIAL_RESEARCH.md` and `SHOPEE_OFFICIAL_RESEARCH.md`. GoBiz supports hosted OAuth + authorized outlet selection after partner onboarding; ShopeePay public APIs require business credentials, customer account linking is not merchant login/discovery. No issued credentials configured; user chose bug/UI + official signup links first. Native accounts help links only; no official connector or Shopee PW/OTP claimed operational.
- Fresh `npm test && python3 tests/deploy_terms.py && npm audit --omit=dev`: exit 0 (26 backend, 15 provider, LAB/login/Shopee/terms/render/website groups, 28 QRIS/UI Node tests); audit 0 vulnerabilities. `tests/ui_smoke.py`: Chromium exit 0, eight real local pages plus explicit synthetic connection contracts, 320/390 mobile, no console errors. Artifacts `/tmp/paygate-compact1-ui-artifacts-xxcywtyg`.
- Independent review `deleg_9328924d`: `PASS_SCOPED`, no blockers; independent old-mode reproduction and timeout/challenge checks pass. Visual analysis succeeded for local 320px consent and dark ToS screenshots: real content, no visible overlap/clipping, consent controls visible; not a full WCAG or user aesthetic acceptance claim.

- Final public HTTPS `tests/live_readonly.py` and authenticated `tests/live_accounts_readonly.py`: both exit 0, no console errors, normal TLS, actual ToS response has seven provider rows and no Promise text, compact1 asset bytes match source, eight pages in light/dark at 1280/768/390/320. Zero provider/payment requests from tests; expiry guards on GET remain allowed to update stale account security state.
- First public static run exposed a test callback race: `page.on('load')` called `page.content()` while next navigation began; Python traceback despite exit 0. Not accepted as clean QA. Moved content assertions into ordered flow after settled navigation in all three browser scripts. Final reruns captured stderr and failed on tracebacks: all three exit 0 with no traceback. Final local artifacts `/tmp/paygate-compact1-ui-artifacts-ptn42n2m`; deployed GoPay 320px screenshot visually reviewed with full fields/buttons and two-line private-connection notice. No production changes after deployment except this documentation sync.
- Review copy precision addressed with red/green regression: introduction says 180 days and reappearance if cookies lost or terms change. Direct public `context.request.get` calls use `max_redirects=0`. Existing 5xx status-first policy stops safely even if response body contains challenge.

## Previous terms1 deployment (historical)

## First-visit terms and Shopee session import

- Deployed 25 changed files through `deploy/update_terms.py`; runtime backup `/root/paygate-backups/20260908T145259Z-pre-terms-shopee` includes protected DB/env/fallback key. Service active/enabled and nonroot; business data, credentials, account status, cooldown and env unchanged. DB integrity `ok`; 0 orders/seen_transactions; existing Shopee remains paused.
- Initial deploy rolled back correctly: existing incomplete-env startup sync refreshes only account updated_at. Diagnosed exact column; narrowed comparison exception to paused ENV_INCOMPLETE non-dashboard rows. `python3 tests/deploy_terms.py` red then green protects credentials/status/cooldown/user/dashboard revisions.
- `/terms` first-visit summary and provider ToS table; explicit versioned acknowledgement stored in signed HttpOnly/Secure/SameSite cookie for 180 days. `/tos` always accessible after auth. No recurring banners or visible LAB UNOFFICIAL labels; mandatory authentication, payment checks and API provenance preserved.
- ShopeePay owner session import available, NOT phone/OTP login. Exact scoped form, password reauth, encrypted DB storage, 12-hour local lease, configured/paused until deliberate feed test. Immutable historical scope, durable local/provider cooldown, async reauthorization and stale-fetch cancellation tested. No device-risk/browser identity replay.
- `npm test`: exit 0 (26 backend, 15 synthetic provider checks, 7 LAB groups, 4 login groups, 6 Shopee groups, ToS and website real local HTTP checks, 27 Node QRIS/UI tests). Follow-up `node --test tests/ui.test.js`: 12/12; Node syntax + deploy Python syntax pass. `npm audit --omit=dev`: 0 vulnerabilities. Independent review `deleg_c8108b2c`: no blocking regression.
- `tests/ui_smoke.py`: Chromium exit 0, first visit/decline/required/accept/reload, 8 authenticated pages, GoPay and Shopee fixture flows, mobile 320/390, focus/Escape, secret clearing, configured-only state, no console errors. Screenshots `/tmp/paygate-terms1-ui-artifacts-2ofwvcj0`; fixture success is not upstream acceptance.
- Public `tests/live_readonly.py` and `tests/live_accounts_readonly.py`: both exit 0. Normal TLS, public asset hashes match `terms1`, secure acknowledgement once, eight pages at 1280/768/390/320 in light/dark, no overflow or JS errors. Only acknowledgement POST; 0 provider requests/payment mutations. Public screenshots `tests/ui-artifacts/terms1-*`.
- No merchant login/feed/payment/settlement verified upstream. Automated browser/layout tests passed; overall screenshot visual review remains unverified (ToS image unavailable/timeout). ToS acceptance does not grant provider permission or erase mandatory legal obligations.

## Prior clean1 UI update (historical)

- Deployed 12 UI files: neutral sidebar/surfaces, restrained emerald actions, quieter cards, consistent section headings, 2-column mobile stats, simpler provider controls, native expandable setup help, restyled login/docs. Payment warnings and required consents retained.
- `npm test && /root/camofox-venv/bin/python tests/ui_smoke.py`: exit 0 after section-heading regressions were reproduced and fixed. Final isolated screenshots `/tmp/paygate-ui-artifacts-qs9sjh91`. 24 backend, 15 synthetic provider, 7 LAB groups, 4 login groups, website HTTP tests and 25 Node QRIS/UI tests pass. No real provider acceptance or money verification.
- Independent review `deleg_d6850c34`: PASS, no security/logic regressions. Docs h2 selector suggestion fixed and browser regression expanded. Representative stable heading/body/link/navigation contrast 5.47:1 or higher in both themes; not a full WCAG audit.
- Runtime backup `/root/paygate-backups/20260908T140410Z-pre-clean-runtime`; source backup `/root/paygate-backups/20260908T133811Z-pre-clean-ui`. Deployment used `deploy/update_ui.py`; 21 backend files unchanged, DB/env/unit untouched, service health active.
- Public `tests/live_readonly.py` and `tests/live_accounts_readonly.py`: both exit 0. `clean1` public asset bytes match source. All seven authenticated pages checked at 1280/768/390/320 in light/dark, no horizontal overflow or JS errors, no provider calls/payment mutations. Owner wizard, disconnected order gate and authenticated downloads retained.
- Public screenshots `/root/paygate/tests/ui-artifacts/clean-dashboard-light-1280.png` and `clean-dashboard-light-320.png`; accounts/modal screenshots in same directory. Image-analysis provider returned 504 and browser-tool backend unavailable; screenshots captured, final aesthetic inspection not verified. No visual PASS claimed.

## Prior login1 baseline (historical)

## Live deployment

- Source `/root/paygate`; runtime `/opt/paygate`; `paygate.service` active/enabled, user `paygate`, listener `127.0.0.1:3000`, HTTPS via Caddy at https://paygate.38-47-90-111.sslip.io.
- Mock/demo removed from runtime config, setup, provider factory, polling, UI, systemd and simulation endpoint. Obsolete environment cannot reactivate. Simulation URL returns 404. No mock flag required to show live QR.
- Known Mock cleanup performed earlier, not repeated: runtime has zero orders and zero seen_transactions. Existing non-Mock account credential hashes preserved by deployment verification. Old Shopee account paused, not configured/live.
- Runtime `LAB_UNOFFICIAL=1`, explicit `LAB_USER_ID=1` (existing admin). This exposes GoPay form, not merchant activation. No GoPay credentials or successful merchant login. No OTP, private feed, payment or settlement request sent.
- GoPay source-audited phone/OTP wizard: reauth PayGate password+consent; durable 2-minute/5-per-hour budget; session/password-bound opaque attempts, 5-minute TTL; bounded requests without auto retry/refresh. Final token encrypted in DB, configured until separate deliberate Test.
- Honest reduced Node headers. Public first-party client ID does not grant integration permission. Current provider acceptance unverified; challenge/auth/rate/schema failure stops and surfaces safe error.
- Only one POP per merchant supported because feed scope is merchant-wide. Persist merchant+outlet+QR and forbid changing scope when history exists. Known-expired dashboard tokens block readiness, order create and feed, clear validation and abort in-flight requests.
- Shopee direct login explicitly unavailable: audited flow relies on replayed device-risk/browser identity. Official portal link does not connect PayGate. Do not bypass challenges.
- Polling remains account scoped with durable lease/cooldown, pause abort and per-fetch revision guard. Exact amount/time match + txid dedup, transaction rollback and ambiguous-time manual review retained.
- New orders `payment_origin=live`; old unknown provenance withheld from QR/reconciliation/revenue. Max Rp100000; no amount reuse in provider history. No force-paid or automatic fulfillment.

## Executed verification

- `npm test`: all checks pass. 24 backend, 15 synthetic provider, 7 LAB groups, 4 login groups, 15 QRIS + 9 Node UI tests. Standalone website test also passes separately and included in npm script.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Independent login review `deleg_1107ee68`: PASS after two blockers (outlet scope, expiry) reproduced and fixed. No unresolved reported blockers in login review.
- Browser `tests/ui_smoke.py`: exit 0; real isolated Chromium, fresh DB, no upstream. Owner/disconnected/error gates, OTP/discovery/save/cancel API contract fixtures, live QR without mock DTO, CSRF, secret clearing, dialogs/focus, themes, 320/390 mobile. Final artifact `/tmp/paygate-ui-artifacts-xs058i6u`.
- Public `tests/live_readonly.py`: exit 0; normal TLS, login/health 200, unauth orders 401, Secure CSRF/no-store/CSP, login1 public JS/CSS bytes match source, no overflow/console errors.
- Public authenticated `tests/live_accounts_readonly.py`: exit 0 using existing owner session, GET-only. Exact `/accounts`, enabled Hubungkan GoPay, honest Shopee unavailable, real modal, disconnected orders disabled, both themes 1280/390/320, no provider calls/payment mutations. Screenshots `/root/paygate/tests/ui-artifacts/`.
- Visual analysis provider timed out on final screenshots. Browser layout checks pass; final visual review remains unverified. Earlier screenshot taken mid-animation is not final contrast evidence.

## Website attachment artifact

`examples/website.mjs`, `tests/website.mjs`, `docs/WEBSITE.md`: standalone Node24 loopback checkout example, no extra dependencies. API key/price server-owned, opaque buyer mapping, Host/Origin checks, no create retries, strict response filtering and QR expiry. Real HTTP tests against explicitly synthetic local PayGate transport. One review bug (non-string order ID coercion) reproduced RED and fixed with explicit type guard plus missing/null/number/array regressions.

Not deployed to a user's storefront: its code/domain was not provided. Example is single-process/volatile, one checkout per buyer session, no production fulfillment. Instructions explain persistent-cart/idempotency/reconciliation requirements before public use. No claim of end-to-end money verification.

Final website checks: `deleg_fc8694ba` reviewed the explicit string-ID guard and regressions, PASS; `deleg_d0cab8d6` reviewed authenticated fixed download paths, PASS. Parent reran `npm test` plus syntax checks, exit 0. Website Chromium HTTP smoke against a synthetic local transport passed at 320/1280: one create, pending QR, paid hides QR, reload no duplicate, no page errors. Initial `networkidle` navigation timed out; DOM-ready plus concrete status assertions passed. Screenshots `/tmp/paygate-checkout-ui-gixpwq78`; money processing not tested.

Website download addition deployed with backup `/root/paygate-backups/20260908T125738Z-pre-downloads`; DB/env/unit untouched. `/docs` now links `/docs/WEBSITE.md` and `/docs/website.mjs`, authenticated attachments only. Post-deploy `tests/live_readonly.py` + `tests/live_accounts_readonly.py` exit 0, including byte-equality of both public authenticated downloads with source and anonymous denial. GoPay modal screenshot now waits for animation and asserts opacity=1; final visual-analysis provider still returned 504, so no visual PASS claimed.

## Backup / rollback

`/root/paygate-backups/20260908T123141Z-pre-login`: protected mode 0700 directory, runtime archive, env/unit, SQLite backup integrity ok, encryption fallback key preserved. Same-host only, not disaster recovery.

Deployment preserved users=2, orders=0, seen_transactions=0, payment_accounts=1, api_keys=10 and non-Mock credential hashes. Additive migrations: credential_source, payment_origin, merchant_login_limits. Roll back code/env/unit deliberately; do not restore old DB over new payments. Do not rerun one-time install or purge scripts. Hermes/unrelated services unchanged.

## Remaining real prerequisites

- User supplies own GoPay number and OTP through HTTPS dashboard only, then deliberately tests feed. Actual minimal-header acceptance may fail upstream; no workaround/spoof promised.
- Shopee direct login remains blocked; official onboarding is separate route, not silently substituted.
- Storefront code/domain needed for actual installation. Payment identity/settlement/manual review, legal/provider permission and safe business fulfillment remain external to local tests.
