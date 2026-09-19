# Login diagnostics (developer guide)

## Client-visible errors
The login dialog displays a static explanation and suggested action, not raw
provider errors or transport codes. GoBiz's observed unsuccessful OTP-request
401 envelope maps to PHONE_REJECTED:

> GoBiz menolak login dengan nomor telepon ini. Periksa nomor dan akses akun merchant melalui portal resmi GoBiz.

This does not establish whether the account is registered, locked or disabled.
Other 401/403 failures remain generic. OTP verification and merchant discovery
never classify an expired/unauthorized token as a phone rejection. CAPTCHA and
rate-limit decisions retain precedence and stop the attempt.

## Browser console
Filter on `[PayGate] Request failed`. Structured metadata includes local
correlation ID, stage, HTTP response status, provider status and known error code.
The ID matches the API diagnostic and the server log. The visible dialog contains
only client guidance. Do not ask clients to share network dumps: those may include
credentials even though these application console entries do not.

## Server console / systemd

```sh
journalctl -u paygate.service --since "30 minutes ago" --no-pager
```

One JSON record is emitted per routed GoPay login failure. Generic failures carry
id, stage, provider_status and classification. The recognized phone rejection adds
event=gopay_otp_request_phone_rejected, the fixed known upstream code and a validated
UUID upstream_request_id (null when invalid/missing). The extra provider context
stays server-side and is not included in the API response.

No raw provider body/message/title, phone, password, OTP, cookie, access/refresh
or challenge token is copied into these application log entries. Unknown provider
codes are not logged. Correlation IDs are for support only, not credentials.

## Verification without provider traffic

```sh
npm test
/root/camofox-venv/bin/python tests/ui_smoke.py
python3 tests/deploy_login.py
```

API/UI regressions use isolated databases and explicit synthetic provider replies.
They cover client prose, console fields, no-secret output, one log per failure,
classifier boundaries and preserved cooldowns. Success in these tests is not
proof of live OTP delivery, verification, merchant discovery or settlement.

Deployment preserves existing merchant_login_limits rows. Never clear cooldown
state to make a deployment assertion pass. Do not use random real-format phone
numbers as safe dummy recipients; request acceptance can trigger an actual OTP.
