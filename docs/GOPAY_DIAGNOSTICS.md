# GoPay login diagnostics

## Scope and evidence

This change fixes an observed **classification bug**, not proven cause of live OTP failure. `/root/paygate-otp-audit.mjs` demonstrated that native fetch with `redirect:'error'` rejects a loopback 302 as a transport error, while an injected 302 `Response` reached `CHALLENGE`. Existing provider HTTP status was then lost before API serialization. Audit script is historical evidence; its old `redirect:'error'` and metadata assertions intentionally no longer describe current code.

`tests/login.mjs` now exercises native fetch against a loopback 302 server. `redirect:'manual'` exposes status; all HTTP 3xx and already-redirected responses fail closed as `CHALLENGE`. No `Location` is followed, no request retried. This label includes blocked redirects; a 302 alone does **not** prove CAPTCHA/device verification.

Provider URL, client ID, method, request headers and JSON bodies remain unchanged. No guessed browser headers, device spoofing, token refresh or auth retry added.

## API contract

Login action errors retain fixed `error` and `code`, adding singular `diagnostic`:

```json
{
  "error": "<fixed local message>",
  "code": "AUTH_REJECTED",
  "diagnostic": {
    "id": "<locally generated UUID v4>",
    "stage": "otp_request",
    "provider_status": 403,
    "classification": "AUTH_REJECTED"
  }
}
```

Placeholders above describe schema, not captured provider output.

- `id`: fresh local `crypto.randomUUID()` per failure; not attempt ID, device ID, session ID or provider request ID.
- `stage`: fixed enum `otp_request`, `otp_verify`, `merchant_discovery`, `reauth`, `attempt_validation`, `otp_validation`, `merchant_selection`, `merchant_save`, `cancel`, `local_validation`. Provider requests retain actual stage/status through response validation. Local failures have `provider_status:null`: a wrong PayGate password is `reauth`, not an OTP request; invalid selection is `merchant_selection`; a database write failure is `merchant_save`.
- `provider_status`: integer 100–599 from actual `Response`, otherwise `null`. Null means no usable HTTP status captured, not HTTP 0. A semantic rejection may legitimately have 200/201.
- `classification`: fixed local error code, identical to top-level `code`. Never copies upstream `errors[].code` or message.

One `console.warn(JSON.stringify(diagnostic))` occurs in login action catch. Log has exactly `id`, `stage`, `provider_status`, `classification`; same values reach API. No service-layer duplicate log. Existing middleware failures (CSRF, consent, generic route rate limiter) occur before this catch and retain their own contracts.

No phone, password, OTP, challenge/access/refresh token, QRIS, raw response, header value, URL, user/session/device ID, upstream error code, stack or error cause enters diagnostic/log. Provider request headers are never copied, even when request ID looks like UUID. Login route clears `phone`, `password`, `otp` from parsed request body in `finally` on both success and failure; this is reference removal, not guaranteed memory zeroization. Do not enable raw request/response logging elsewhere.

## Classification

| Local classification | Meaning; not inferred root cause |
|---|---|
| `CHALLENGE` | Blocked redirect or existing challenge marker; stop and use official app |
| `AUTH_REJECTED` | HTTP 401/403 without recognized challenge |
| `PROVIDER_ERROR` | HTTP 5xx |
| `REQUEST_REJECTED` | Other unsuccessful HTTP response |
| `RATE_LIMITED` | HTTP 429; durable cooldown honors Retry-After |
| `BUSINESS_REJECTED` | OTP request JSON explicitly has `success:false`; upstream details omitted |
| `BAD_RESPONSE` | Invalid/oversized/unsupported response, absent challenge/token or invalid merchant schema |
| `NETWORK` | Fetch/body transport failure or request timeout |
| `EXPIRED` | Cancelled, expired or changed local session/attempt |
| `NO_MERCHANT`, `MULTI_OUTLET` | Discovery has no valid QRIS or unsupported multi-outlet scope |

Existing fixed local validation/access codes remain: `FORBIDDEN`, `UNSUPPORTED`, `INVALID`, `REAUTH`, `COOLDOWN`, `BUSY`, `SCOPE_CHANGED`. `SAVE_FAILED` reports local persistence failure without raw SQLite/error text or a claimed provider request.

`BUSINESS_REJECTED` is narrowly supported by audited unofficial [merchantid commit 1fa55b3e1024861ef74968f9cdb1bb1bfb899fea, src/api/authClient.ts](https://github.com/alhifnywahid/merchantid/blob/1fa55b3e1024861ef74968f9cdb1bb1bfb899fea/src/api/authClient.ts): envelope lines 10–14, `requestOtp` lines 40–68 and `assertSuccess` lines 171–182. Unlike that library, PayGate never surfaces `errors[]`. Only explicit boolean false receives new label, only for OTP request. Missing/invalid success or token stays `BAD_RESPONSE`; challenge detection takes precedence. This source contract is not official provider authorization or evidence of live acceptance.

## Verification and safe operation

Run isolated checks from `/root/paygate`:

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin node tests/login.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin node tests/provider.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin node tests/lab.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin node tests/shopee.mjs
```

Login suite uses copied source, temporary SQLite and synthetic provider responses. Native HTTP reaches loopback only; external fetch is blocked. Red regressions observed before production changes: native 302 incorrectly `NETWORK`; missing diagnostic metadata; API dropping metadata; explicit unsuccessful OTP envelope incorrectly `BAD_RESPONSE`.

Checks cover pinned wire body/header contract, stage/status retention through later response validation, null status after discovery network failure, local UUIDs, safe API/log keys, exactly one log per caught failure, raw input removal, real 302/no follow, synthetic 3xx, business/challenge precedence, 1 MiB stream limit, timeout/cancel, no retries, durable cooldown, current owner/session/password, immutable outlet scope, encryption and configured-not-active behavior.

For a future owner-authorized failure, correlate only local diagnostic ID with these safe fields. Do not request raw body, headers, OTP or tokens; do not resend to gather evidence during cooldown. No live OTP, auth, provider feed or payment was exercised for this change. No deployment performed. Live OTP cause remains unknown.
