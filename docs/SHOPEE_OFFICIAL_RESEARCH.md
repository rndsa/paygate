# ShopeePay Indonesia: official API authentication and payment boundary

Research: 2026-09-08 UTC. Public official documentation only; existing login research read for context. No credentials, `.env`, session stores, or live DB accessed. No authentication, OTP, payment, or other authenticated API requests sent. Only repository deliverable: this document. Documentation evidence is not live integration verification.

## Decision

**No public official API contract found for “enter Shopee merchant password/OTP in PayGate, discover all owned merchants, select one, import dashboard payments.” Do not advertise this flow as supported.** This is a bounded public-documentation finding, not proof that Shopee has no private contracted partner offering.

Public Indonesia APIs document **onboarded business-client credentials** for payment operations, and separately **customer wallet account binding** for customer authorization and charging. B2B tokens, buyer account tokens, and first-party merchant dashboard sessions are different authorities; they are not interchangeable.[2][3][4]

**Minimal official route:** complete ShopeePay integration onboarding; configure approved merchant/store identities; use PayGate's own operator login and merchant permissions; create new payments through approved SNAP product; persist those references; reconcile signed notifications with transaction-status queries. Until issued credentials and merchant/product approval exist, show **“Official integration requires onboarding / not connected.”** Do not show working Shopee login or auto-discovery.

## 1. Onboarding and credentials

Official onboarding starts by contacting ShopeePay's integration team, signing NDA and commercial agreement, choosing payment product, then receiving integration-testing credentials.[1]

Indonesia SNAP language-specific integration guide requires:[2]

| Party | Required material / action |
|---|---|
| ShopeePay | Issued Client ID; Client Secret shared offline; ShopeePay public key shared offline for verifying callbacks/API responses. |
| Integrator | Generate own RSA key pair; keep private key secret; share public key offline with ShopeePay. |
| Integrator and ShopeePay | Exchange/register callback URL; agree enabled merchant/store identities and product access. Merchant/store identifiers occur in payment API requests; they are not discovered by credential login.[5][6] |
| Runtime | Server-side integration, OAuth 2.0/HMAC compatibility, HTTPS with TLS 1.2 or 1.3. |

Do not reuse documentation sample keys, first-party Shopee client IDs, or imported dashboard session tokens as issued PayGate credentials. Never send secrets to online signature-debugging sites.

SNAP bases documented by Indonesia JavaScript guide:[2]

- Sandbox: `https://api.snap.uat.airpay.co.id`
- Live: `https://api.snap.airpay.co.id`

**Documentation inconsistency:** bare `/integration/get-started/` currently presents older wallet-domain/HMAC-SHA256 material and cross-region links, while `/integration/get-started/javascript/` documents Indonesia SNAP domains, RSA signing and HMAC-SHA512. Do not mix protocol families. Earlier research's citation of bare guide as evidence for SNAP domains was too broad; use language-specific SNAP guide and obtain current assigned integration profile from ShopeePay.[1][2]

Sandbox credentials, successful test requests, merchant acceptance, and live enablement are separate milestones. Public pages reviewed do not establish this project's approval, sandbox account, or production permission. Exact onboarding portal account, certification checklist, IP allowlist requirements, supported key encoding and channel value must be confirmed with assigned integration team; do not invent them.

## 2. Official auth is not merchant password login

### Business-client authentication

`POST /v1.0/access-token/b2b`, body `{"grantType":"client_credentials"}`. Response includes `accessToken`, `tokenType: "Bearer"`, `expiresIn`, and `responseCode`; sample successful response code is `2007300`. Token is for subsequent payment/refund/query APIs, not merchant-dashboard session exchange.[3]

Token signing: Base64 RSA-SHA256 signature using integrator private key over `X-CLIENT-KEY + "|" + X-TIMESTAMP`. Issued client ID, timestamp, signature and JSON content-type belong in request headers.[2]

Transactional calls use issued client ID as `X-PARTNER-ID`, Bearer access token where required, `X-TIMESTAMP`, `X-SIGNATURE`, `X-EXTERNAL-ID` and `CHANNEL-ID`. Guide describes `X-EXTERNAL-ID` as numeric string, unique that day under same Client ID. Payment signature is Base64 HMAC-SHA512 with **Client Secret** as key, over method, documented relative endpoint/query encoding, access token, lowercase SHA256 hex of minified JSON, and timestamp, colon-separated.[2]

Node's native crypto can provide these primitives. Correct encoding/canonicalization still requires provider test vectors and sandbox confirmation; successful local signature generation is not provider authentication.

### Buyer linking and verification

`GET /v1.0/get-auth-code` takes existing `merchantId`, `redirectUrl`, CSRF `state`, and scope **`ACCOUNT_BINDING` only**. Merchant redirects **customer** into ShopeePay's authorization frontend. After consent/verification and redirect, server exchanges returned `authCode` or `partnerReferenceNo` via `POST /v1.0/registration-account-binding`, receiving `accountToken` for subsequent permitted customer operations.[4]

Get User Information uses `POST /v1.0/registration-account-inquiry`; documented data refers to linked customer, including masked customer phone subject to merchant contract, not merchant businesses or staff permissions.[4]

**Any OTP/PIN or login shown in that hosted customer verification journey is not evidence of a merchant password/OTP API.** Reviewed account-binding contract does not provide a merchant OTP-send/OTP-verify endpoint, merchant-list scope, or dashboard-session handoff. Specific OTP channels/challenge rules were not established; do not invent them or collect customer secrets in PayGate. Scope and workflow explicitly concern linking customer wallet to an already-identified merchant.[4]

## 3. Multi-merchant and discovery: exact evidence boundary

| Facility | Finding |
|---|---|
| Merchant/store addressing | Official payment contracts expose `merchantId` and `externalStoreId`; MPM returns onboarded store name. Supports explicitly addressed, onboarded merchant/store transactions.[5][6] |
| Partner credential identity | `X-PARTNER-ID` identifies issued API client, not logged-in Shopee user.[2] |
| Account binding | Requires merchant identity before linking customer. Not merchant discovery.[4] |
| Merchant list / switch / registration API | No public official endpoint contract found in searched Indonesia API docs. Do not invent `/merchants`, `MerchantDetect`, OAuth merchant scopes, or onboarding API paths. |
| Partner multi-merchant portal/contract | Public pages reviewed do not establish entitlement to onboard/manage arbitrary sub-merchants under one credential, nor a discover-all-merchants endpoint. Must obtain partner onboarding documents and permission from ShopeePay. Fields alone do not prove that entitlement. |
| Local merchant selection | Viable design only over identities explicitly approved/configured for this integration and authorized for current PayGate operator. Label “configured merchants,” not “merchants discovered from Shopee login.” |
| Existing dashboard history | Not established by public APIs reviewed. MPM docs explicitly state status API cannot query MPM transactions not made using ShopeePay Payment API.[5] |

Ask integration team: direct merchant vs aggregator/ISV contract; whether one Client ID can serve multiple merchants; approved merchant/store mapping; supported portal/API for sub-merchant onboarding, listing and suspension; access to settlement/reconciliation reports and pre-integration history; separate per-merchant callback/key requirements. These are blockers for promised merchant discovery, not details to assume.

## 4. Payment operations verified in official documentation

All paths below are contracts read from docs, **not requests executed**.

| Product / operation | HTTP path | Important boundary |
|---|---|---|
| MPM dynamic QR create | `POST /v1.0/qr/qr-mpm-generate` | Unique `partnerReferenceNo`, amount/currency, approved `merchantId`, `additionalInfo.externalStoreId`; returns QR material.[5] |
| MPM status | `POST /v1.0/qr/qr-mpm-query` | Original reference, merchant/store, service code `47` for payment; not general private dashboard history.[5] |
| MPM cancel | `POST /v1.0/qr/qr-mpm-cancel` | Invalidates QR/payment reference for closed/cancelled order.[5] |
| Checkout create | `POST /v1.1/debit/payment-host-to-host` | Unique reference, amount, merchant/store, `urlParams` with `PAY_RETURN`; returns `webRedirectUrl` for buyer payment.[6] |
| Checkout status | `POST /v1.0/debit/status` | Query original reference, merchant/store, amount and original service code; read `latestTransactionStatus`, not merely HTTP success.[6] |
| Checkout cancel | `POST /v1.0/debit/cancel` | Invalidates existing checkout order.[6] |
| Merchant's MPM callback receiver | `POST .../v1.0/qr/qr-mpm-notify` | Merchant-provided URL registered with ShopeePay; service `52`.[7] |
| Merchant's checkout callback receiver | `POST .../v1.0/debit/notify` | Merchant-provided URL registered with ShopeePay; service `56`.[7] |

Choose **one enabled product** first: dynamic MPM QR for QR checkout, or Checkout with ShopeePay for hosted buyer authorization. Buyer account binding is unnecessary for initial MPM flow and is not a workaround for merchant onboarding.[4][5][6]

## 5. Callback and payment-state security

Provider requirements:

- Verify callback `X-SIGNATURE` with **ShopeePay public key and RSA-SHA256**, not outgoing request HMAC secret. Signed string is `HTTPMethod + ":" + callbackURL + ":" + lowercaseHex(SHA256(rawRequestBody)) + ":" + X-TIMESTAMP`; callback URL includes full scheme/domain/path.[2][7]
- Preserve received raw body before JSON parsing. Callback page specifically says hash raw JSON **without modifications**; this differs from outgoing minified transaction JSON. Never parse/reserialize first.[7]
- Check payment amount and `originalPartnerReferenceNo` match original order. Check product-specific merchant/store location in callback body; MPM sample nests merchant in `additionalInfo`, checkout uses top-level merchant.[7]
- Browser return URL is **never proof of successful payment**. Successful API response alone is not completed payment; inspect `latestTransactionStatus` (`00` for successful payment in documented workflow) and reconcile server-side.[5][6]
- Current notification page explicitly states **one callback per transaction, no automatic retries**. Acknowledge valid notifications and use Check Transaction Status to obtain latest status. Page shows checkout acknowledgement `{"responseCode":"2005600","responseMessage":"Successful"}`; confirm exact acknowledgement for selected product rather than blindly reusing service `56` for MPM.[7]

PayGate design requirements, not claims of provider behavior:

1. Use configured canonical public callback URL when constructing signed string; never trust arbitrary inbound Host or forwarded headers.
2. Validate signature, schema, tenant/merchant/store, original reference, currency, amount, and acceptable timestamp policy before applying payment state. Reject unknown/mismatched payments; do not create credited orders from arbitrary callback input.
3. Persist incoming event and state transition atomically; deduplicate and make fulfillment idempotent. Do not assume signature validation prevents replay or duplicate processing.
4. Keep pending/unknown states on timeouts; query existing reference before any ambiguous retry. Do not issue fresh references blindly or mark failed just because request timed out.
5. Reconcile missed callbacks with bounded status polling. Use TLS verification; keep keys/tokens server-side and redact logs. No browser-exposed secrets or unverified signed-state shortcuts.

## 6. Honest MVP and blocked work

**Possible now, without keys:** documentation; unconnected official-setup UI; checklist of required issued credentials and approved merchant/store IDs; operator permission model; locally testable crypto/state-validation logic with clearly labeled test fixtures. None establishes a real connection.

**After issued sandbox credentials and merchant/product approval:** validate B2B auth; create one real sandbox order; query its state; process provider-signed callback; test mismatch/replay/missed-callback cases; offer merchant selection only from approved configuration. Live payments remain blocked until live enablement is confirmed.

**Cannot claim or deliver without further provider access:** real merchant PW/OTP login through official API; automatic list of existing Shopee merchant accounts; keys derived from dashboard cookies; live QR/payment creation; confirmed merchant discovery; existing full dashboard transaction/history import; verified callbacks from ShopeePay; production-ready payment integration.

Recommended UI copy: **“ShopeePay API resmi memerlukan onboarding dan kredensial dari ShopeePay. Login password/OTP akun merchant dan deteksi merchant otomatis belum tersedia melalui API publik yang terverifikasi. Belum terhubung.”**

## Evidence limitations

Public docs mix legacy/SNAP pages and contain sample/field typos (`latestTransctionStatus` in prose versus `latestTransactionStatus` in schema). Prefer product schema plus current integration-team test vectors; do not copy examples unquestioningly.[1][2][6]

Generic API-index URL returned HTTP extraction error. Direct product reference pages were readable. Initial Python HTML fetch stopped on HTTP 308; curl followed redirects and confirmed notification no-retry text. No gated partner portal was entered. Search surfaced an integration-suite domain outside official ShopeePay domain; ownership/official delegation was not verified, so it was not used as authority and no credentials were entered.

Citation ledger persistence attempt using stdout timed out; source numbering below was generated in memory using citation script URL normalization to avoid adding another repository artifact. No financial output or provider success fabricated.

## Sources

[1] https://product.shopeepay.co.id/integration/get-started
[2] https://product.shopeepay.co.id/integration/get-started/javascript
[3] https://product.shopeepay.co.id/integration/api/access-token
[4] https://product.shopeepay.co.id/integration/api/account-linking/php
[5] https://product.shopeepay.co.id/integration/api/merchant-presented-mode
[6] https://product.shopeepay.co.id/integration/api/checkout-with-shopeepay
[7] https://product.shopeepay.co.id/integration/api/notify-transaction-status
