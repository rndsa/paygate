# Merchant login / live-only — 2026-09-08

User chose merchant login inside PayGate, explicitly removed Mock/demo and then requested deleting Mock history. Known Mock history was deleted separately with backup. No active simulation allowed.

## Selected
- GoPay source-audited private phone/OTP + explicit merchant/outlet choice. Transient attempt only in memory, encrypted final DB session. User must reauthenticate PayGate and consent; deliberate feed Test activates orders. No upstream requests from page GET or mere login-form setup.
- Keep server owner scope via LAB_USER_ID and opt-in. Dashboard credentials override old env import; no automatic refresh/retry/resume. Provider session rejection requires manual reconnect, stop on CAPTCHA/403/429/schema/network failure.
- Honest reduced Node client headers; no official app version/appId, Chrome fingerprint, Origin/Referer spoof. Acceptance with reduced headers is unverified. Public go-biz-web-new client ID is source-observed, not provider permission.
- Shopee unsupported direct login: audited flow depends on captured device telemetry/browser impersonation, outside constraints. Official portal link is NOT PayGate connection. Existing manual-env feed adapter can remain for an operator-sanctioned session.
- New live-only order provenance, prior unknown records quarantined, strict scoped matching and unique amounts unchanged. No provider credentials or OTP exposed by status JSON.

## Alternatives
- Official GoBiz facilitator OAuth: supported redirect/consent, but needs issued partner client credentials/scopes and separate official payments adapter; not equivalent to embedded phone/OTP. Preferred supported production route, not silently substituted.
- Copy MerchantID whole package: rejected because unnecessary machinery and Shopee shared fingerprint; code trust and anti-fraud constraints unmet.
- Manual token in env only: existing path retained as import but does not satisfy requested GoPay login UX.

## Verification boundary
Local tests use isolated DB and explicitly synthetic fetch responses. They cannot prove current merchant login acceptance, OTP delivery, provider permission or money settlement. Actual user input/OTP required for final live authentication. Never present source-audited as live-verified.
