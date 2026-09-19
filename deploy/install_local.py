"""One-time supervised PayGate deploy. Only touches PayGate, never the Hermes gateway."""
from pathlib import Path
import os
import pwd
import shutil
import signal
import sqlite3
import subprocess
import time

SRC = Path('/root/paygate')
APP = Path('/opt/paygate')
STATE = Path('/var/lib/paygate')
CONF = Path('/etc/paygate')
PID = 258687
assert not APP.exists() and not STATE.exists(), 'Deployment paths already exist; use documented update procedure'
proc = Path(f'/proc/{PID}')
assert proc.joinpath('cwd').resolve() == SRC
assert proc.joinpath('exe').resolve() == Path('/usr/bin/node')
assert proc.joinpath('cmdline').read_bytes().split(b'\0')[:2] == [b'node', b'src/server.js']
try:
    user = pwd.getpwnam('paygate')
except KeyError:
    subprocess.run(['useradd', '--system', '--home-dir', str(STATE), '--shell', '/usr/sbin/nologin', 'paygate'], check=True)
    user = pwd.getpwnam('paygate')
APP.mkdir(mode=0o755)
STATE.mkdir(mode=0o700)
CONF.mkdir(mode=0o700, exist_ok=True)
os.chown(STATE, user.pw_uid, user.pw_gid)
for name in ['src', 'views', 'public', 'node_modules', 'package.json', 'package-lock.json']:
    source, dest = SRC / name, APP / name
    if source.is_dir():
        shutil.copytree(source, dest)
    else:
        shutil.copy2(source, dest)
# Config secrets stay root-readable and are injected by systemd, not served or logged.
managed = {'NODE_ENV', 'HOST', 'PORT', 'DB_PATH', 'PAYGATE_DATA_DIR', 'ENABLE_MOCK_PAY', 'MOCK_AUTOPAY_PROBABILITY', 'RATE_LIMIT_MAX'}
lines = [line for line in (SRC / '.env').read_text().splitlines() if line.partition('=')[0].strip() not in managed]
lines += ['NODE_ENV=production', 'HOST=127.0.0.1', 'PORT=3000', 'DB_PATH=/var/lib/paygate/paygate.db', 'PAYGATE_DATA_DIR=/var/lib/paygate', 'RATE_LIMIT_MAX=600']
config_path = CONF / 'paygate.env'
config_path.write_text('\n'.join(lines) + '\n')
config_path.chmod(0o600)
(SRC / '.env').chmod(0o600)
unit = Path('/etc/systemd/system/paygate.service')
assert not unit.exists(), 'Existing service not overwritten'
shutil.copy2(SRC / 'deploy/paygate.service', unit)
subprocess.run(['systemd-analyze', 'verify', str(unit)], check=True)
# Stop exactly the validated old Node worker; leave its Hermes parent untouched.
os.kill(PID, signal.SIGTERM)
deadline = time.monotonic() + 15
while proc.exists() and time.monotonic() < deadline:
    time.sleep(0.1)
assert not proc.exists(), 'Old PayGate did not exit cleanly'
source = sqlite3.connect(f'file:{SRC}/data/paygate.db?mode=ro', uri=True)
target = sqlite3.connect(STATE / 'paygate.db')
source.backup(target)
assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
counts = {table: target.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in ['users', 'orders', 'api_keys', 'payment_accounts']}
source.close()
target.close()
if (SRC / 'data/secret.key').exists():
    shutil.copy2(SRC / 'data/secret.key', STATE / 'secret.key')
for file in STATE.iterdir():
    file.chmod(0o600)
    os.chown(file, user.pw_uid, user.pw_gid)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'paygate.service'], check=True)
print({'installed': str(APP), 'state': str(STATE), 'unit': str(unit), 'preserved_row_counts': counts})
