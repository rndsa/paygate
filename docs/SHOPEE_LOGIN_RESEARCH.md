# Shopee Merchant / ShopeePay dashboard login research

Research date: 2026-09-08 UTC. Scope: public documentation plus static source audit. **No authentication, OTP, device-risk, session-status, or transaction requests sent. No credentials used. Repository not executed. No production code, environment, service, or database changed.**

## Decision

**Do not ship MerchantID's fetch-only login as working PayGate login under current constraints.** Its implementation impersonates browser request context; its documented successful delivery depends on captured device telemetry. Removing spoofed headers and refusing replay is correct, but leaves no demonstrated working credential-to-session path. This is a source-audit conclusion, not proof Shopee rejects every honest server client.

Minimal honest options:

- **Viable now:** show real disconnected/unsupported state, link to official Shopee Partner login, explain integration restriction. This does **not** connect PayGate or import browser cookies. Do not label it “connected”.
- **Supported integration route, onboarding required:** ShopeePay commercial/API integration. Its B2B client credentials are not merchant phone/password and do not establish access to existing private dashboard history.[5][6]
- **Conditional future direct login:** only after Shopee-authorized integration requirements and sanctioned device/challenge flow are known. Fail closed on CAPTCHA, risk rejection, malformed replies, rate limits, or missing state. Current research does not justify claiming this path works.
- A user-operated, ordinary first-party browser can run Shopee's own SDK and challenge UI without spoofing. No documented PayGate callback/token handoff was found; opening that browser alone does not solve PayGate session acquisition. Do not invent OAuth callback support, copy browser telemetry into server requests, or offer shared-fingerprint fallbacks.

Preserve historical PayGate rows; label prior simulations explicitly. No migration/deletion performed here. Removing demo generation is separate from making real login work.

## What official sources establish

Indonesian Shopee Partner help describes password reset, slider/image CAPTCHA, and OTP delivered to registered WhatsApp/SMS/email **for password reset**. It also describes app login using registered phone number, CAPTCHA, then OTP. It does not document these private web API bodies or prove email OTP works for merchant web login.[4]

Singapore help explicitly describes Partner app/web credentials and admin phone+OTP. Malaysia's One Shopee Account help describes phone/email/username plus existing Shopee password. These are useful regional comparisons, not Indonesian API contracts or two independent publishers.[7][8]

Merchant terms §5 prohibit robots/spiders/automated or manual monitoring/copying of platform content without prior written approval; §12.2(n) prohibits decompiling/reverse engineering/hacking or defeating security/encryption measures. §7.3 places credential confidentiality and account activity responsibility on merchant. §7.2 discusses third-party services enabled by or connected to Shopee, not blanket permission for arbitrary private API clients. User ownership/consent does not itself establish provider permission. Obtain Shopee approval/legal review before production private-dashboard integration.[1]

Official Indonesia integration docs require contacting ShopeePay, NDA/commercial agreement, issued onboarding credentials, signed API calls, OAuth 2.0-compatible integration, TLS 1.2/1.3, and server integration. Live SNAP domain: `api.snap.airpay.co.id`; sandbox: `api.snap.uat.airpay.co.id`.[5]

Documented API alternative: `POST /v1.0/access-token/b2b`, body `{ "grantType": "client_credentials" }`, response fields `responseCode`, `responseMessage` in example, `accessToken`, `tokenType: "Bearer"`, `expiresIn` string; documented default 900 seconds. Example success code `2007300`. Access-token request requires issued client identity and asymmetric SHA256/RSA signature per onboarding docs. This is **B2B payment API access**, not password login or private dashboard cookie exchange.[5][6]

### Independent-source comparison

| Publisher | Retrieved evidence | What it does not establish |
|---|---|---|
| Midtrans, docs updated 2025-11-10 | Charge API, redirect into Shopee app, notification handling.[9] | No merchant-password login or dashboard-feed export authorization. |
| Xendit, Indonesia docs updated 2026-07-22 | Customer QR/app authorization and payment confirmation.[10] | No merchant-password login or dashboard-session handoff. |

These are two independent payment integrators, corroborating legitimate payment integrations rather than MerchantID's private auth implementation. No two independent credible sources were found corroborating exact `authenticate_toc_by_password`, risk-token grading, or OTP-channel integer mapping. Do not present generic buyer login guides or Seller Center marketplace OAuth as proof for ShopeePay merchant dashboard login.

## Static audit provenance

Repository: `/root/shopeepay-research/merchantid`.
HEAD observed: `1fa55b3e1024861ef74968f9cdb1bb1bfb899fea`, commit timestamp `2026-08-23T16:22:56+07:00`. Working-tree file contents were read; clean-tree status not established. No test/build/package scripts run. No HAR, saved account session, environment file, or credential store read.

Local references below identify exact files/line ranges. Repository comments about “reference capture”, “live testing”, silent delivery suppression, and token segment lengths are **maintainer claims**, not independently reproduced observations. TypeScript interfaces describe expected/consumed shapes, not complete upstream response schemas.

## Private login flow as implemented, not live-verified

Bases:

- `A = https://partner.business.accounts.shopee.co.id`
- `P = https://partner.shopee.co.id`
- `M = https://api.partner.shopee.co.id`
- `W = https://shopeepay.shopee.co.id`
- `D = https://df.infra.sz.shopee.co.id/v2/shpsec/web/report`

Wire envelopes (`api.ts:15–31`):

```ts
Account<T> = { error?: number; error_msg?: string; data?: T }
Partner<T> = { errorCode?: number; errorMsg?: string; data?: T }
Payment<T> = { code?: number; msg?: string; data?: T }
```

Success helpers require numeric zero and defined `data`; they do not fully validate nested payloads. Error codes as strings would not match numeric-zero success.

### 1. Bootstrap, password, request OTP

All `/api/v4/account/business/*` paths below are under `A`. Source: `authClient.ts:161–314,540–648`; paths/constants: `constants.ts:4–111`.

| Step | Method/path | Request fields | Consumed reply / behavior |
|---|---|---|---|
| Bootstrap | `GET A/login?lang=id` | Clear existing cookie jar first | Captures anonymous cookies; source expects `csrftoken`, `SPC_*`, language. HTML not executed. Bootstrap status/redirect not validated here. |
| Risk report | `POST D` | Caller-supplied telemetry string, or `{}` when absent | `{code?:number,msg?:string,data?:{riskToken?:string}}`; requires `code===0` and token. |
| Migration check | `POST /api/v4/account/business/check_password_migrate` | `{phone}` | `Account<{need_migrate?:boolean}>`; flag ignored. |
| Existence lookup | `POST /api/v4/account/business/check_account_exist_by_password` | `{phone,password:passwordHashOrEmpty}` | Expected `has_password?`, `otp_channel?:number[]`, `otp_default_channel?:number`; **all JSON business error results ignored**. Source says `48401004` occurred and phone-only yielded `10002`. |
| Password auth | `POST /api/v4/account/business/authenticate_toc_by_password` | `{phone,password:passwordHashOrEmpty,security_device_fingerprint:riskToken}` | `Account<{toc_account?:{has_password?:boolean,userid?:number}}>`; `48401102` treated as accepted password requiring OTP, but absent password throws. `error===0` returns `hasPassword=false`, not completed session. Other errors fail. |
| OTP settings | `POST /api/v4/account/business/get_otp_settings` | `{operation:50001,phone,security_device_fingerprint,support_session:false,supported_channels:[1,2,3,5]}` | `Account<{available_channel_list?:number[],captcha_required?:boolean,default_channel?:number}>`. CAPTCHA stops via helper. |
| OTP send | `POST /api/v4/account/business/send_otp` | Same operation/phone/fingerprint/session fields; `supported_channels:[1,2,3,5,4]`, selected `channel`, `captcha_signature:""` | `Account<{seed?:string}>`; no seed still returns local challenge. Success **does not prove delivery**. |

Phone normalized to Indonesian compact `62...` form. Password wire transform is lowercase `SHA256(MD5_UTF8(password).hexLowercase)`, i.e. SHA256 over MD5 **hex text**, not MD5 bytes (`crypto.ts:21–89,226–238`). Treat hash as credential-equivalent; never persist/log it. Node 24 native crypto can compute this if an authorized flow is later approved; porting handwritten hash functions unnecessary.

This class always continues to OTP even when password endpoint returns zero. It does not implement a general password-only completion branch. Its comments about passwordless accounts do not establish all actual upstream account modes.

Local challenge returned: `{version:1,phoneNumber,channel,availableChannels,deviceFingerprint,riskToken,hasPassword,cookies,requestedAt}`. `deviceFingerprint` and `riskToken` initially contain same token. These are server-only secrets/state, not browser DTO fields.

### 2. Verify OTP and detect merchants

Source: `authClient.ts:316–423`.

1. Restore challenge cookies. Validate OTP against `^\d{4,10}$`; no challenge-age check inside this method.
2. `POST A/api/v4/account/business/verify_otp` body `{operation:50001,otp,phone,security_device_fingerprint,support_session:false}`. Unlike earlier requests, source formats phone as `(+62) <3 subscriber digits> <4 digits> <remaining digits>`. Consumed reply: `Account<{otp_token?:string}>`; token required.
3. `POST A/api/v4/account/business/authenticate_toc_by_otp` body `{otp_token,security_device_fingerprint,is_signup:false}`. Reply: `Account<{toc_nonce?:string,toc_account?:{userid?:number}}>`; nonce and numeric user ID required.
4. Read `SPC_CLIENTID` cookie scoped to `A`.
5. Follow `GET P/account/login/auth` with query `lang`, `spc_clientid`, `state`, `toc_nonce`.
6. `POST M/nb/mss/mer-detect-api/PartnerMerchantDetectServer/MerchantDetect`, body `{}`, `X-Merchant-ToC-Nonce: toc_nonce`. Reply: `Partner<{TocUid?:number,selectMerchant?:{merchantList?:RawMerchant[]}|null}>`.

`RawMerchant`: `merchantId`, `merchantName`, `merchantStatus`, `staffTobUid`, `staffRole`, `staffStatus`, `isActive`, `isBanned`, `isCurrentLoginUser` (all optional in interface). Numeric merchant and staff IDs required to retain row. Empty merchant list fails. Local verification: `{version:1,tocNonce,tocUserId,spcClientId,deviceFingerprint,cookies,merchants,verifiedAt}`.

SSO `state` is URL `P/` with query `business_next=P/login/auth`, `business_state=P`, `business_client_id=1`; source uses `client_id=5`. These are Shopee first-party client IDs, **not credentials or authorization granted to PayGate**. No custom PayGate callback is implemented.

### 3. Merchant selection and token exchange

Source: `authClient.ts:444–537,652–727`; `token.ts:40–86`.

1. Restore verification cookies. Select requested accessible merchant; otherwise exactly one current usable merchant or single usable merchant. Active and not banned required; ambiguous choice fails.
2. Follow `GET A/authenticate/login/token/` with `lang`, `spc_clientid`, `state`, `tob_userid=merchant.staffUserId`, `next=P/account/login/tob/auth`, `client_id=5`, `toc_nonce`.
3. `POST A/api/v4/account/business/login_toc` body `{toc_nonce,tob_userid,security_device_fingerprint}`. Reply `Account<{nonce?:string}>`; nonce required.
4. Follow `GET P/account/login/tob/auth` with `code=nonce`, `lang`, `spc_clientid`, `state`.
5. Read `__shopee_partner_website_x_token_live` cookie at `P`. Split three JWT segments and decode payload; required `token:string`, `userid:string|number`; optional `businessId:string|number`, `exp:number`.
6. Compare JWT `userid` to selected staff ToB ID. `businessId` represents SSO business client, not merchant ID. Return session `{version:1,cookies,accountId,merchant,merchants,stores:[],storeId,createdAt,expiresAt}`.

JWT is **decoded, not signature-verified**. Do not trust externally supplied cookie/JWT to authorize PayGate tenant or merchant ownership. Use cookies obtained from trusted upstream exchange plus actual authorized profile checks. JWT expiry is not a server-session liveness guarantee.

`POST A/api/v4/account/business/login_status` body `{}` returns expected `Account<{userid?:number}>`; code returns boolean `error===0`. Comments call `48500102` “not login”. Not invoked here; does not establish official refresh contract. `SwitchMerchant` endpoint exists in constants but is not part of this audited login sequence.

### 4. Merchant profile/store/feed boundary

`merchantClient.ts:69–99`: `POST M/nb/mss/web-api/PartnerAccountServer/GetUserInfo`, body `{}`, header `X-Merchant-Token: innerToken`. Reply `Partner<{merchantId?,merchantName?,store_id?,tobUserId?,tocUid?,userName?,tocUserName?,language?,shopeepay_service_status?,...}>`. Checks returned merchant ID matches configured merchant.

`merchantClient.ts:112–185`: `POST W/merchant/v1/partner-web/get-store-list`, body `{data:{metadata:{token,language:"id",timezone:"Asia/Jakarta"},storeName:"",lastStoreId:0,pageSize:30,serviceList:[1,10]}}`. Reply `Payment<{list?:{storeId?,storeName?,status?}[],storeCount?:number}>`; cursor is last raw store ID; retries unfiltered only if complete filtered result empty. Bounded pagination and repeated-cursor checks present.

Transaction path is `POST W/merchant/v1/partner-web/get-transaction-list` (`constants.ts:43`). Transaction request/response implementation was outside requested nine-file audit. Existing PayGate body-token feed is supplied context, not independently validated here. Partner `X-Merchant-Token`, JWT wrapper, inner token, and SNAP B2B access token are distinct; do not interchange them.

## Device risk, OTP channels, CAPTCHA

### Device risk is main feasibility blocker

`httpClient.ts:14–25,96–109` stamps captured Windows/Firefox browser identity and synthetic `Sec-Fetch-*` headers on server requests. `authClient.ts:540–563` adds official-site Origin/Referer, `X-App-Type:2`, `af-ac-enc-sz-token`, SDK version `1.12.26-user.1`, CSRF cookie-derived header, same-origin fetch metadata. `constants.ts:85–106` constructs official login referrer specifically to resemble passport client. Copying these as identity camouflage violates requested no-spoof constraints.

`deviceRisk.ts:1–33` explicitly documents **shared captured fingerprint**, cross-account linkability, collective blocking risk, and working around anti-fraud checks. Its exported blob is deliberately not reproduced. `authClient` accepts a supplied report or posts empty JSON; no genuine SDK/device measurement generation exists in audited implementation. Supplementary read of `shopeeProvider.ts:69,256–259` confirms report forwarded from caller/config, not generated there.

Maintainer claims empty telemetry produces degraded risk token and suppressed OTP despite success; captured report produces delivery. Token segment-length heuristics are not documented provider contracts, proof of safety, or reliable delivery tests. Do not use them to select bypasses. Replaying even merchant's own captured report from a different server/context is not same as fresh authentic device measurement and remains outside constraints.

### OTP channel support: distinguish enum from available product feature

Source mapping (`constants.ts:65–80`): SMS `1`, voice call `2`, WhatsApp `3`, email `4`, Zalo `5`, Viber `6`, WhatsApp auth link `9`, none `0`. Mapping source-only, not official public contract.

- WhatsApp: source fallback `3`; comments claim successful reference capture, not current independent delivery proof.
- SMS: advertised in source settings and send lists; actual availability must come from per-account upstream response.
- Email: integer exists and send list includes `4`, but settings list **omits `4`**, input only accepts Indonesian phone, and no email recipient/login flow exists. **Do not offer email login OTP as supported.** Official email OTP evidence here concerns password reset.[4]
- Do not offer Zalo/Viber/voice/auth-link solely because enum exists. Source validates selected channel only when nonempty available list returned; empty list falls back to WhatsApp. Safe UI should not invent availability from empty/malformed settings.

### CAPTCHA is stop condition, not completed authentication

Official Partner help uses CAPTCHA for verification before OTP and password-reset OTP.[4] In source, `requireAccountData` throws `CaptchaRequiredError` when `data.captcha_required===true` or `error_msg` contains “captcha” (`api.ts:62–99`). Thus settings CAPTCHA stops before `send_otp`. Source always sends empty `captcha_signature`; it has no CAPTCHA solver, human completion callback, widget integration, or resume protocol.

Coverage gap: existence/password requests bypass `requireAccountData`; existence ignores business errors entirely and password handler lacks dedicated CAPTCHA handling. HTML/HTTP 403 challenges become generic auth/non-JSON failures. These must stop without attempting alternate headers, telemetry replay, proxies, or repeated OTP requests. Completing official CAPTCHA proves challenge completion, not OTP delivery, account login, merchant access, or successful PayGate connection.

## Remaining static audit findings

| File | Finding / ceiling |
|---|---|
| `authClient.ts` | Clears jar on new OTP; concurrent flows cannot share client. No local challenge TTL, resend cooldown, OTP-attempt ceiling, or account/session binding inside class. Missing seed still yields challenge. Password success does not finish login. Migration flag unused. |
| `crypto.ts` | Implements MD5 + SHA256 wire transform, not password storage protection. Native Node 24 crypto preferable if later approved. No execution/vector verification performed. |
| `api.ts` | Three distinct envelopes, some redacted diagnostics, CAPTCHA helper present. Broad `token|auth|login|session` message regex may classify unrelated errors as session failure. Nested JSON not schema validated. Partner headers include client-context values `X-Merchant-ToB-Clientid:"undefined"`, `X-Merchant-Login-From/From:"12"`, request ID, `shopee-baggage:"PFB=undefined"`; necessity is maintainer assertion. |
| `constants.ts` | Private paths, SDK version, integer channels, first-party client IDs are observed constants, not negotiated/public API guarantees. `200020` and `2010000` treated terminal auth errors. |
| `httpClient.ts` | Synthetic browser identity forbidden for this project. Cookie capture and bounded manual redirects present. `followGet` lacks HTTPS/host allowlist and returns final 4xx/5xx without rejection. It does not validate challenge pages. 401/403 generic auth failure; 429 generic HTTP error; no resend-safe retry policy. |
| `deviceRisk.ts` | Captured shared blob is incompatible with project constraints. Never import, send, display, log, or duplicate it. |
| `cookieJar.ts` | Domain/path/Secure/expiry matching, Set-Cookie handling, basic injection guards, small public-suffix denylist present. `restore` assumes trusted typed input and bypasses origin/domain validation; SameSite/HttpOnly stored but browser enforcement not recreated. Use server-owned isolated snapshots only; this is not full browser cookie engine. |
| `merchantClient.ts` | Profile merchant-ID match valuable. Bounded store enumeration exists. `raw` profile returned to caller may contain PII; never pass through dashboard wholesale. Validate safe integer IDs and precise tenant/store scope before accepting account binding. |
| `token.ts` | JWT payload decoding only, no signature verification; `exp` converted to milliseconds but not checked here. Secret inner token must remain server-side. Staff ID and merchant ID differ. |

## Requirements before any approved implementation

1. Obtain sanctioned flow/API permission; keep direct private login unavailable until prerequisites exist. Do not promise “no password needed” based on a success comment or regional article.
2. Admin-only action with explicit owner consent, CSRF protection, rate limits, masked phone, no account enumeration, no logs containing passwords/hashes/OTP/cookies/nonces/risk reports. Password transient only; session encrypted server-side; no raw secret fields in EJS/browser JSON.
3. Per-user/per-attempt isolated cookie state, short TTL, resend cooldown, bounded verification attempts; stop on CAPTCHA/risk/403/429. Never automatically resend OTP after ambiguous timeout.
4. Real states: disconnected, prerequisites missing, requesting, OTP requested-but-delivery-unconfirmed, verifying, merchant selection, connected, expired, CAPTCHA required, unsupported. Connected only after genuine merchant profile/store validation; never based on mock reply, cookie presence, or JWT expiry alone.
5. Approved browser handoff must keep credentials/challenges at Shopee and have documented return semantics. Otherwise official-login link remains informational, not integration.
6. Preserve prior transactions and simulation labels. Never convert simulated historical rows to verified live settlements. New payment success requires real scoped upstream evidence.

## Verification and limits

Nine requested files audited; opaque device blob contents were not analyzed (tool display truncated its long literal) and not copied into report. Extra provider configuration lines and git commit metadata read. Official terms HTML and Partner help HTML retrieved by ordinary unauthenticated GET because extraction omitted sections/timed out. Public ShopeePay integration docs, Midtrans, and Xendit retrieved. No live login page/browser execution or authenticated requests performed.

Extractor timed out on three pages once; direct public HTML retrieval recovered Partner help and integration guide; removing trailing slash recovered access-token documentation. General ShopeePay terms extraction was too sparse to support additional claims, so merchant-specific terms carry conclusions. Deadline-limited independent research found payment integrations, not independent reproduction of private merchant login.

**Live unknowns:** current private endpoint acceptance, exact full response schemas, whether honest non-browser risk submission is allowed, actual per-account channels and delivery, challenge codes/resume protocol, password-only/passwordless modes, session duration/refresh, permission for external dashboard access. Public docs retrieval is current evidence of published guidance, not live auth certification.

## Sources

[1] https://help.shopee.co.id/portal/4/article/185486-Persyaratan-Layanan-Bagi-Merchant
    > "Selain itu, Anda setuju bahwa Anda tidak akan menggunakan robot, penggali informasi (spider) atau perangkat otomatis maupun proses manual lain untuk memantau atau meniru Konten kami, tanpa persetujuan tertulis sebelumnya dari kami"
[4] https://help.shopee.co.id/portal/1/article/115866
    > "Masukkan kode OTP yang telah dikirimkan ke WhatsApp/SMS/email terdaftar dalam halaman atur ulang password."
[5] https://product.shopeepay.co.id/integration/get-started/php
    > "Start by contacting ShopeePay team to sign the NDA (Non-Disclosure Agreement) and commercial agreement."
[6] https://product.shopeepay.co.id/integration/api/access-token
    > "Access Token API is an API call that can be used to acquire B2B access token."
[7] https://help.shopee.sg/portal/1/article/86240-%5bShopeePay-Merchant%5d-How-do-I-login-to-my-ShopeePartner-app
    > "Admin account login **-** log in using your **registered phone number and One Time Password (OTP).**"
[8] https://help.shopee.com.my/portal/4/article/132463-%5BShopee%20Partner%5D%20%20How%20do%20I%20login%20into%20Partner%20App%20under%20One%20Shopee%20Account%20login%3F
    > "One Shopee Account login allows you to access your ShopeePartner app with your personal Shopee account."
[9] https://docs.midtrans.com/reference/shopeepay-1.md
    > "Send the charge API request to Midtrans."
[10] https://docs.xendit.co/docs/shopeepay-e-wallets-id
    > "When customers choose ShopeePay at checkout, they can complete the payment by scanning a QR code or authorizing the transaction directly in the Shopee app."
