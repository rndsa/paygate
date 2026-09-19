# PayGate isolated browser runtime

Verified 2026-09-08 UTC. Runtime preparation only; **not deployment approval**.

## Verdict

- **Sandbox feasible.** `paygate` UID 998 launched standard Chromium with `chromium_sandbox=True` directly and inside transient systemd with all requested restrictions. `/root` inaccessible. No sandbox disable, namespace sysctl change, elevated capabilities, Camoufox, stealth, fingerprint override, or proxy override.
- **Current resource configuration fails.** Isolated `MemoryMax=384M`, `TasksMax=64` run exited 1. Exact Chromium error: `pthread_create: Resource temporarily unavailable (11)`. `pids.events: max 11`; memory events all zero. Task limit, not blocked user namespace, caused this failure.
- **Candidate `512M/192`: four successful runs, one unexplained native Chromium crash.** Three final repeats passed consecutively. Failed repeat emitted `Received signal ... 11 ... SI_KERNEL`, `Possibly a General Protection Fault`, then `signal=SIGSEGV`; memory/pids limit events both zero. Root cause unknown; no workaround applied. Investigate before production/auth routing. A single successful launch does not prove reliability.
- No provider page, login, credentials, cookie store, or app code exercised. All page navigation was `about:blank`; page context offline. Initial direct/sandbox tests could still make Chromium background requests (Google registration warnings appeared). Later transient tests additionally set **test-only** `IPAddressDeny=any` to prevent browser background egress; no firewall change.

## Verified handles

| Handle | Value |
|---|---|
| Python | `/opt/paygate-browser/bin/python` |
| Interpreter | `/usr/bin/python3.10`, Python 3.10.12 |
| Browser env | `PLAYWRIGHT_BROWSERS_PATH=/opt/paygate-browser/browsers` |
| Chromium | `/opt/paygate-browser/browsers/chromium-1223/chrome-linux64/chrome` |
| Version | Google Chrome for Testing 148.0.7778.96; Playwright revision 1223 |
| ffmpeg | `/opt/paygate-browser/browsers/ffmpeg-1011/ffmpeg-linux`; `n7.0.1-playwright-build-1011`, executed as paygate |
| Runnable check | `/opt/paygate-browser/verify_runtime.py` |
| Raw evidence | `/root/paygate/docs/browser-runtime-evidence.json` |
| Installed distributions | `playwright==1.60.0`, required transitives `greenlet==3.5.5`, `pyee==13.0.1`, `typing_extensions==4.16.0` |
| Disk | `du -sh /opt/paygate-browser`: 519M |

Only Playwright and its mandatory dependencies installed. No pytest, app packages, system library install, additional browser, or pip bootstrap. Existing host Chromium libraries resolve via `ldd`. This venv uses system Python/stdlib and host shared libraries; it is not a portable container.

All runtime directories/executables root-owned 0755, non-executable files 0644; no group/world write access. Symlinks resolve only inside runtime or `/usr/bin/python3.10`, never `/root`. Browser tree is a copy, not root-cache symlinks. ffmpeg's build configuration prints historical `/root/prefix` compiler paths; runtime executable ran as paygate without root-home access.

Integrity checks: all 176 installed `playwright/` files matched official PyPI wheel, whose published SHA256 was checked:

```text
playwright-1.60.0-py3-none-manylinux1_x86_64.whl
1c2bfae7884fb3fb05b853290eab8f343d524e5016f2f1def702acbbdf14c93e
```

All 309 browser/ffmpeg files matched existing source cache byte hashes. Chromium executable SHA256:

```text
adc1c21ceed5c2a67184766376fe816ac03e556cc0ca3f782e8212235fe05c6f
```

Browser provenance is existing standard Playwright cache, not a separately re-downloaded browser signature verification. `browsers.json` inside pinned Playwright confirmed Chromium 1223 / ffmpeg 1011.

## Setup commands used

```bash
/root/.hermes/bin/uv venv --python /usr/bin/python3 /opt/paygate-browser
/root/.hermes/bin/uv pip install --python /opt/paygate-browser/bin/python --link-mode=copy playwright==1.60.0
```

Python stdlib `shutil.copytree` copied only these two directories after checking revisions from package `driver/package/browsers.json`:

```text
/root/.cache/ms-playwright/chromium-1223 -> /opt/paygate-browser/browsers/chromium-1223
/root/.cache/ms-playwright/ffmpeg-1011 -> /opt/paygate-browser/browsers/ffmpeg-1011
```

Do not copy source `.links`, headless-shell, other browser revisions, or secrets. For future clean installation instead of cache copy, pinned runtime supports official download:

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/paygate-browser/browsers \
  /opt/paygate-browser/bin/python -m playwright install --no-shell chromium
```

Download alternative documented, not executed here. No `--with-deps` / `install-deps` run. `uv pip check --python /opt/paygate-browser/bin/python` passed: four compatible distributions.

## Worker integration contract — not applied here

```python
browser = playwright.chromium.launch(
    channel="chromium", headless=True, chromium_sandbox=True
)
```

- Node worker environment allowlist must explicitly pass fixed `PLAYWRIGHT_BROWSERS_PATH=/opt/paygate-browser/browsers`; inheriting it elsewhere does not work if allowlist drops it. Interpreter stays `/opt/paygate-browser/bin/python`.
- Full Chromium only is installed. Default headless launch without `channel="chromium"` looks for separate headless-shell and will fail. Explicit matching full-Chromium executable is another supported selection; do not accidentally select system Chrome or root cache.
- `chromium_sandbox` defaults false in Playwright. Set true explicitly; do not retry false or add `--no-sandbox`.
- Check creates temporary HOME/XDG cache/config/profile under `/tmp`, deletes them after browser closes. Real worker must use approved writable paths; root-owned runtime stays read-only. Persistent auth storage not designed/tested here.

## Runnable checks

Direct nonroot:

```bash
cd /tmp
runuser -u paygate -- /usr/bin/env -i \
  PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONUNBUFFERED=1 \
  PLAYWRIGHT_BROWSERS_PATH=/opt/paygate-browser/browsers \
  /opt/paygate-browser/bin/python -I -B /opt/paygate-browser/verify_runtime.py
```

Transient check, full exact successful command (unit auto-collected; IP egress denied for local-only test):

```bash
systemd-run --wait --pipe --collect --unit=paygate-browser-check-candidate --property=User=paygate --property=Group=paygate --property=WorkingDirectory=/opt/paygate-browser --property=ProtectHome=yes --property=ProtectSystem=strict --property=PrivateTmp=yes --property=PrivateDevices=yes --property=NoNewPrivileges=yes --property=CapabilityBoundingSet= '--property=RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' --property=ProtectKernelTunables=yes --property=ProtectKernelModules=yes --property=ProtectControlGroups=yes --property=LockPersonality=yes --property=RestrictSUIDSGID=yes --property=UMask=0077 --property=MemoryAccounting=yes --property=TasksAccounting=yes --property=RuntimeMaxSec=30 --property=LimitCORE=0 --property=IPAddressDeny=any --property=MemoryMax=512M --property=TasksMax=192 /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONUNBUFFERED=1 DEBUG=pw:browser PLAYWRIGHT_BROWSERS_PATH=/opt/paygate-browser/browsers /opt/paygate-browser/bin/python -I -B /opt/paygate-browser/verify_runtime.py
```

Reproduce existing resource failure by changing only transient unit name and `MemoryMax=384M`, `TasksMax=64`. Do not apply to live service.

Actual properties captured while an independent transient run was active:

```text
MemoryMax=536870912
TasksMax=192
IPAddressDeny=::/0 0.0.0.0/0
CapabilityBoundingSet=
User=paygate
Group=paygate
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectHome=yes
ProtectSystem=strict
NoNewPrivileges=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
ActiveState=active

```

Service-process `/proc/self/status` under transient unit: `NoNewPrivs=1`, `CapBnd=0000000000000000`, `Seccomp=2`. Main browser also had empty host capability bounding set. Launch debug logs had no `--no-sandbox`. `runuser -u paygate -- unshare --user --map-root-user true` exited 0. Host already had `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=31581`; unchanged.

## Measurements and resource floor

Sampler reads process descendants and dedicated cgroup every 50 ms, including startup, three seconds of empty page, and shutdown. It adds one Python sampling thread. Linux 5.15 cgroup lacks `memory.peak`/`pids.peak`, so numbers are **sampled maxima**, not guaranteed absolute peaks. RSS sums count shared mappings repeatedly; size `MemoryMax` from cgroup memory instead.

| Run | Result | Cgroup MiB peak | Cgroup tasks peak | Descendant processes peak |
| current | fail | 152.18 | 40 | 7 |
| candidate | pass | 225.38 | 105 | 11 |
| direct-final | pass | not isolated | not isolated | 11 |
| verified-properties | fail | 153.58 | 39 | 6 |
| repeat1 | pass | 225.09 | 105 | 11 |
| repeat2 | pass | 223.82 | 105 | 11 |
| repeat3 | pass | 223.79 | 105 | 11 |

`current` sampled only 40 tasks because crash spike was shorter than sampling interval; `pids.events max 11` proves actual limit hits. Direct final process-tree peak: 101 tasks, 889.30 MiB summed RSS (not unique physical memory). Earlier 768M/192 sandbox run passed with 243.3 MiB cgroup peak / 104 tasks. Candidate final repeats: about 224–225 MiB / 105 tasks.

Live app baseline read-only: 11 tasks, 39,936,000 bytes cgroup memory (38.1 MiB); process RSS 92,500 KiB. Approximate blank-browser-plus-app envelope from highest observed sandbox peak: **281.4 MiB / 116 tasks**, before workload and sampling headroom.

**Parent deployment plan (not applied): `MemoryMax=768M`, `TasksMax=192`, `LimitCORE=0`; preserve every existing sandbox restriction and explicit `chromium_sandbox=True`.** 768M gives more page/app headroom but does not fix unexplained native SIGSEGV.

**Measured candidate floor: `MemoryMax=512M`, `TasksMax=192`, one browser / one context / one page / concurrency one.** 128 tasks would leave only ~12 tasks over sampled combined baseline; 192 avoids calling that narrow margin sufficient. 384M memory was not proven insufficient for blank page; 64 tasks was conclusively insufficient. This floor is a proposal, not measured production capacity; actual combined app/browser execution and provider pages were prohibited. Heavy pages, extra renderers, downloads, screenshots, or parallel jobs require separate measurement; 768M–1G may be needed. Increasing limits will not explain/fix unexplained SIGSEGV.

## Limitations, failures, cleanup

- First sandbox run launched and reached blank page, but extra diagnostic `Browser.getBrowserCommandLine` failed: `Command line not returned because --enable-automation not set.` Removed only that diagnostic; did not change browser flags. Official PyPI byte comparison confirms stock package. `DEBUG=pw:browser` supplies launch evidence instead. Some Chromium `/proc/*/cmdline` values expose only executable name; process subtype cannot be trusted there.
- One of five 512M/192 hardened runs crashed with native SIGSEGV; three unchanged consecutive reruns passed. Logs retained, cause unresolved. Do not describe this as blocked namespace or fully reliable deployment.
- Nonfatal restricted-environment logs included DBus errors, `Could not create NETLINK socket: Address family not supported by protocol (97)`, udev warnings, and one GPU context transient failure. No device/address-family allowances added to suppress them.
- Initial package threat-intelligence lookup timed out; install proceeded. Official package wheel hash/content verification then passed; this is provenance verification, not a complete vulnerability audit.
- `systemctl list-units --all 'paygate-browser-check-*'`: zero loaded units. `systemctl list-unit-files 'paygate-browser-check-*'`: zero unit files. All tests used `--collect`; no persistent test unit remains.
- Final `ps -u paygate`: only original app PID 414632, no browser descendants. Live `paygate.service` stayed active/running, same start `2026-09-08 16:39:52 UTC`, `NRestarts=0`, `MemoryMax=402653184`, `TasksMax=64`.
- No live service/unit/env/DB/firewall changes, reload, restart, app deployment, or auth routing performed. Changes limited to isolated runtime, this report/raw evidence, and reusable linux-server-ops reference.

## References checked

- https://playwright.dev/python/docs/browsers#chromium — full Chromium versus headless shell, channel selection, browser path.
- https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox — API; pinned installed generated Python source confirms sandbox defaults false.
- https://pypi.org/pypi/playwright/1.60.0/json — official wheel URL and published SHA256; installed package files compared to wheel.
