# GoPay Merchant / GoBiz login: feasibility audit

Checked 2026-09-08 UTC. **Source audit, not live authentication verification.** No OTP/auth/refresh/merchant API requests, credentials, exposed secrets, repository execution, installs, live environment, service or DB changes. Public documentation and GitHub metadata/raw source GETs only.

## Decision

- **Supported path exists:** PayGate initiates GoBiz facilitator OAuth; merchant enters phone/OTP and consents on **Gojek-hosted page**, then returns to PayGate. Requires provider-issued partner credentials for PayGate, registered redirect URI and relevant scopes. No manual merchant token, copied device fingerprint or browser impersonation needed. This does **not** satisfy literal requirement that phone/OTP fields stay inside PayGate.[4][9][10]
- **Embedded phone/OTP implementation can be built now from source contract**, using private `/goid/*` APIs, public `go-biz-web-new` client ID, native Node fetch and per-account stable UUID, without copied secrets, fake Chrome/Android fingerprints or bypass. No client secret appears in audited private flow. **This confirms implementability, not successful login:** current server acceptance and provider permission remain unverified. GoBiz app ID/version still claim first-party application identity, even though Node phone model is honest. If “no spoof” also forbids that app identity, there is no proven accepted substitute.[5][7]
- **Implementation decision:** acceptable only as explicitly unofficial, source-audited, live-unverified owner-account connection flow, with risk warning and fail-closed challenge handling; do not report connected until real OTP/token response validates, and do not report payment-ready until merchant/QR discovery completes. Provider-supported production path remains official OAuth; obtain provider permission for private integration rather than treating merchant consent as permission. Stop on challenge; do not rotate identities or substitute leaked credentials. OAuth tokens must not be assumed valid for existing private analytics adapter; official integration needs its own supported payment endpoints.[4][9]

## Official facts and terms

Official merchant help: registered phone from GoPay Merchant, GoFood Merchant or merchant.gopay.co.id; active phone/email; WhatsApp OTP by default; alternate SMS/email through “Coba metode lainnya” (email only if registered). **One device at a time.** Do not promise SMS specifically, no-session-displacement or coexistence with merchant app.[2]

Terms retrieved directly; accordion clauses recovered by parsing public `__NUXT_DATA__` JSON as data, without executing scripts. Section 10 makes merchant responsible for account access and verification-code secrecy, prohibits account transfer to third parties and permits access blocking. Exact quote: “Akun GoBiz hanya digunakan oleh Mitra Usaha dan tidak bisa dialihkan kepada pihak ketiga lain dengan alasan apapun.” Section 14 explicitly lists reverse engineering, scraping and disruptive automated programs among prohibited conduct. Thus own-account consent is not blanket provider permission; this is contractual risk, not legal advice.[1]

### Official OAuth contract

Production OAuth host `https://accounts.go-jek.com`; API `https://api.gobiz.co.id`. Sandbox OAuth `https://integration-goauth.gojekapi.com`; API `https://api.partner-sandbox.gobiz.co.id`. Credentials obtained through GoBiz Developer Portal; docs require existing merchant **owner role** for portal access. Sandbox testing and production credentials are separate.[3][9][10]

1. Redirect browser to `GET https://accounts.go-jek.com/oauth2/auth` with `client_id`, `response_type=code`, `scope` (at least `openid`, plus approved permissions), unpredictable session-bound `state`, registered `redirect_uri`; optional `nonce`, `max_age`, `ui_locales`. Provider handles phone/OTP/consent.[4][10]
2. Callback: `redirect_uri?code=<one-time-code>&state=<same-state>`; validate state. Code valid no more than two minutes per docs.[9]
3. Backend `POST /oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, body `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, identical `redirect_uri`. Response documented as `{access_token:string,expires_in:number,token_type:string,id_token:string,scope?:string,refresh_token?:string}`; examples use `expires_in:3600`.[4][9]
4. Refresh same endpoint/form encoding: `{client_id,client_secret,grant_type:"refresh_token",refresh_token}`. **Documentation conflict:** scope table uses `offline`, while token-response prose says `offline_access`; confirm scope with issued configuration, do not invent compatibility.[4][9]
5. Direct own-merchant integration instead uses `grant_type=client_credentials` + approved `scope`, authenticating client ID/secret (Basic Auth in example); no end-user OTP in that model.[9]

Official discovery: `GET /integrations/partner/v1/linked-outlets?per=<n>&page=<n>` returns `{success:true,data:{outlets:[{id,external_outlet_id,created_at,updated_at}]}}`; `GET /integrations/partner/v1/token-info` returns `{success:true,data:{outlets:[{id,name,address,email,phone}]}}`; `GET /integrations/partner/outlets/{outlet_id}/v1` returns `{success:true,data:{outlet:{id,name,merchant_name,status,email,payment_settings,applications}}}`. Scope requirements include `partner:outlet:read`; outlet linking and grant-specific access must follow partner onboarding.[4]

Official payment endpoints include `POST /integrations/payment/outlets/{outlet_id}/v2/transactions` and `GET /integrations/payment/outlets/{outlet_id}/v1/transactions/{id}`. These are not private history-search/static-QR-discovery endpoints. No documented equivalent of `pops[].gopay.aspi_qr_string` found in reviewed official discovery endpoints. Historical guide incorrectly says POST token endpoint “to show GoBiz login page”; detailed auth reference correctly specifies redirect to `/oauth2/auth`.[4][10]

## Audited private flow: MerchantID

Pin `alhifnywahid/merchantid@1fa55b3e1024861ef74968f9cdb1bb1bfb899fea` (2026-08-23). GitHub current `master` resolves to same commit; all five requested files plus provider wiring byte-identical to fetched pinned raw source. Local tracked tree clean.[5]

### Endpoints and JSON shapes

Base `https://api.gobiz.co.id`; JSON encoding throughout. These are **code expectations**, not captured responses from this audit.[5]

| Step | Exact request | Expected response / handling |
|---|---|---|
| Request OTP | `POST /goid/login/request`, `{client_id:"go-biz-web-new",phone_number:"<subscriber digits, no 0/+62>",country_code:"62"}` | `{success:boolean,data:{otp_token?:string,token?:string}|null,errors?:[{code?,message?,message_title?}]}`. Requires `success`; extracts `data.otp_token ?? data.token`. No `login_type` or channel in this implementation. |
| Verify OTP | `POST /goid/token`, `{client_id:"go-biz-web-new",data:{otp:"<user supplied>",otp_token:"<challenge>"},grant_type:"otp"}` | **Flat** `{access_token:string,refresh_token?:string,token_type?:string,expires_in?:number}`. No phone resent. Requires nonempty challenge before request. `token_type` is observed live as `GoBearer`; the scheme is not replayed (discovery always sends `Bearer <access_token>`), so any bounded scheme token is accepted. `expires_in` is optional per the audited contract; when absent a 30-minute local lease is assumed. |
| Refresh | `POST /goid/token`, `{client_id:"go-biz-web-new",data:{refresh_token:"<server-held token>"},grant_type:"refresh_token"}` | Same flat token shape; adopt replacement refresh token, preserve old only when absent. Source comment claims nested form received HTTP 201 and flat form 401; **author claim, not our live verification**. |
| Current account | `GET /v1/users/me` with access bearer | `{user:{id?,merchant_id?,email?,full_name?,phone?,roles?}}`. Resolve default merchant ID. |
| Merchant search | `POST /v1/merchants/search`, `{from:0,size:200,_source:[...]}` | `{total?:number,success?:boolean,hits?:MerchantDetail[]}`. Code does not paginate beyond first 200 or enforce success flag. |
| Merchant detail | `GET /v1/merchants/{merchantId}` | **Flat** `{id,merchant_name?,outlet_name?,phone?,email?,server_key?,client_key?,timezone?,pops?:[...]}`. Do not expose raw response or keys to browser/logs. |

Exact search `_source`: `id,director_name,merchant_name,email,feature_types,phone,outlet_address,outlet_name,outlet_city,payment_settings.GOPAY,tags,bank_account,applications,pops,aspi,business_type,metadata,id_type,merchant_type,service_area`.[5]

`pops[]` expected as `{pop_id?,name?,status?,gopay?:{status?,gopay_receiver_id?,gopay_qr_string?,aspi_qr_string?}}`; interoperable static QR comes specifically from **`pops[].gopay.aspi_qr_string`**, not `gopay_qr_string`. Code picks first nonempty QR; PayGate should require explicit merchant/outlet selection and validate QR before payment activation. Successful token exchange is not proof that merchant discovery or QR discovery succeeded.[5]

Provider sequence: normalize Indonesian phone; OTP request; OTP verification; initialize bearer/token manager; best-effort `/users/me`; best-effort merchant detail/static QR. `LoginService` exports session, searches merchants, falls back to profile when search empty, calls persistence callback, clears remembered challenge. Discovery failure may still return `success:true, session, merchants:undefined`. Session and challenge must remain server-side and account/session-bound; do not share one `LoginService` singleton across users.[5]

### Headers, client identity, device ID

No `client_secret` or app signature in audited private GoID calls. `go-biz-web-new` is observed first-party **client identifier**, not a credential issued to PayGate; its presence in public source does not authorize reuse.[5]

Audited headers:[5]

```text
Accept: application/json, text/plain, */*
Content-Type: application/json   # bodies only
Authentication-Type: go-id
Authorization: Bearer           # bare literal for OTP/refresh, overrides session
Authorization: Bearer <token>   # authenticated discovery/analytics
X-PhoneMake: Web
X-PhoneModel: Node.js Client
x-DeviceOS: Web
X-User-Locale: id
Gojek-Country-Code: ID
Gojek-Timezone: Asia/Jakarta
X-Platform: Web
X-User-Type: merchant
x-appId: go-biz-web-dashboard
X-AppVersion: platform-v3.109.0-d4b20f12
x-uniqueid: <stable per-session UUID>
```

Device precedence: persisted `session.deviceId`, explicit configuration, otherwise fresh UUID. Provider preserves device ID across token refresh. No copied fingerprint required by this source; no explicit Chrome user-agent, Origin, Referer, Sec-Fetch headers, cookie jar or CAPTCHA solver. **Server acceptance of these reduced headers remains unknown.** App ID/version still identify official dashboard; replacing them with honest PayGate identity is unverified, not a proven fix.[5]

### Existing analytics adapter compatibility

Audited feed: `GET https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions` with `from`, `size` (source clamps max 100), `start_time`, `end_time`, **`merchant_ids`**; optional comma-separated `statuses` and `payment_types`. Expected `{from,size,total,transactions:[{id,order_id,merchant_id,transaction_status,payment_type,gross_amount,real_gross_amount?,currency?,transaction_time,settlement_time?,transaction_source?}]}`. Source divides monetary amounts by 100 and considers `settlement`/`capture` paid; this audit did not verify units or settlement semantics against live payments.[5]

## Independent community comparison

Three separately maintained GitHub repositories inspected. GitHub reports each `fork:false`; **code lineage independence not proven**. Shared headers may be copied, so agreement is not three independent live validations.[5][6][7]

| Repository / pin / file | Findings | Weight |
|---|---|---|
| MerchantID, `1fa55b3e1024861ef74968f9cdb1bb1bfb899fea`, `src/api/authClient.ts`, `src/auth/loginService.ts`, `src/api/merchantClient.ts`, `src/http/httpClient.ts`, `src/core/constants.ts`, provider wiring | OTP + nested refresh + merchant search/detail/static QR; honest Node phone model, stable UUID; no private client secret | Strongest source contract, still unofficial/unverified live |
| kavionn/gobiz-payment, `0bac129fefa09a3b723b68dd8f09e4b0e3899527` (2026-09-07), `gobiz.js:71-271` | Same host/client/OTP endpoints; adds `login_type:"otp"`; extracts challenge from envelope or root; nested OTP exchange. If challenge missing, **guesses phone fallback**. Search `{from:0,to:50,_source:["id","merchant_name"]}`. Fresh UUID for login and subsequent merchant lookup; Chrome/Windows, Origin, Referer and browser client hints spoofed. | Corroborates main OTP fields; do not copy fallback, spoof headers, device rotation or search pagination assumption |
| xirf/gobiz-merchant-sdk, `6af2ce6a44b4656d293faf5f2f03d2eb5323d3ed` (2026-08-31), `src/services/portal.service.ts:87-301` | Private portal path supports **email/password or supplied token, not OTP**. Request `{email,login_type:"password",client_id}` then `{client_id,grant_type:"password",data:{email,password}}`; accepts flat/nested access token. Uses `/v1/merchants/self`, not corroborated by MerchantID; same browser impersonation family. | Not evidence embedded OTP works; do not borrow endpoint guessing or ignored advisory errors |

`/root/gopay-research` also contains unrelated Czech GoPay SDKs and old consumer-Gojek clients; those do not substantiate Indonesian merchant login. No repository tests executed; test fixtures are not live API evidence.

## Challenge, retry and security audit

- MerchantID HTTP timeout 20 seconds; non-2xx becomes `HttpError` with status/body; timeout mapped to 408. At most one 401 refresh/retry for authenticated requests; auth/refresh calls set `skipAuthRetry:true` to avoid recursion. **No specific GoPay CAPTCHA/challenge handler, Retry-After handling or OTP resend cooldown.** Response headers discarded; malformed/non-JSON 2xx becomes `{}`, which search may misread as empty merchants.[5]
- `requestOtp` may return missing challenge despite `success:true`; `verifyOtp` checks challenge. OTP format/attempt count/TTL/resend channel limits are not established here. `toTokenSet` requires access token but silently accepts missing refresh token despite comment saying required. `validateSession` collapses network failure and invalid credentials into `false`.[5]
- xirf recognizes some rate-limit wording during password advisory call but suppresses other advisory failures; password re-login on 401; 30–240-second randomized transaction polling is its own throttle, **not provider quota**. kavionn uses blocking curl without HTTP status capture for OTP and accepts unsupported missing-challenge fallback.[6][7]
- **PayGate requirements, not discovered provider contract:** stop on CAPTCHA, unusual-device, consent/re-auth challenge, 403, unsupported schema, invalid/expired OTP or 429. Show sanitized reason; respect provider Retry-After if supplied; no automatic OTP resend/verification retry, CAPTCHA bypass, rotating UUID/IP/UA or password fallback. Bind challenge to authenticated PayGate admin session + phone + stable device; enforce CSRF, local cooldown/attempt limits, encrypted token persistence, redacted logs and explicit expiry/reconnect state. Provider cooldown duration and exact challenge error codes remain UNKNOWN.
- Keep token acceptance, discovery completion and payment-ready status separate. Missing merchant/QR must never become connected/payment-ready or fake transaction success. No authenticated writes/refunds/withdrawals needed for login audit.

## Verification boundary and blockers

Verified: current public official content retrieval; exact local source + commits; MerchantID current remote master/file equality; distinct repository metadata. Not verified: OTP delivery, channel selection, response schema acceptance, rate limits, challenge codes, token expiry/rotation, cross-device effects, merchant permissions, static QR availability or current analytics units. Browser tool unavailable; terms recovered from public Nuxt JSON instead. Official docs contain legacy/inconsistent examples; current retrieval is not a provider support guarantee.

Only PayGate deliverable changed: this document. Live env/service/DB and historical rows untouched.

## Sources

[1] https://gopay.co.id/terms-and-condition/qris-gopay-merchant
[2] https://gopay.co.id/bantuan-merchant/masuk-ke-aplikasi/cara-masuk-login-ke-aplikasi-gopay-merchant
[3] https://developer.gobiz.com/docs/docs/getting-started/index.html
[4] https://app.gobiz.com/files/static/cpp/api-reference/index.html
[5] https://github.com/alhifnywahid/merchantid/tree/1fa55b3e1024861ef74968f9cdb1bb1bfb899fea
[6] https://github.com/xirf/gobiz-merchant-sdk/tree/6af2ce6a44b4656d293faf5f2f03d2eb5323d3ed
[7] https://github.com/kavionn/gobiz-payment/tree/0bac129fefa09a3b723b68dd8f09e4b0e3899527
[9] https://developer.gobiz.com/docs/docs/authentication/index.html
[10] https://app.gobiz.com/files/static/cpp/docs/index.html
