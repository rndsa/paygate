"""Scoped deploy for the studio4 redesign + Console Log release.
Copies code only (src/public/views/docs). Never edits ENV or DB.
Protected backup; byte-asserts ENV/unit unchanged, cooldowns/credentials/rows preserved.
Rollback to prior runtime on any health/assert failure. Additive DB migration retained.
No provider/login/payment/network requests beyond local /healthz.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request

SRC, APP = Path('/root/paygate'), Path('/opt/paygate')
ENV, UNIT = Path('/etc/paygate/paygate.env'), Path('/etc/systemd/system/paygate.service')
DB = Path('/var/lib/paygate/paygate.db')
PARTS = ['src', 'public', 'views', 'docs']

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def health():
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=2) as r:
                if r.status == 200 and json.load(r)['ok']:
                    return
        except OSError:
            time.sleep(.2)
    raise RuntimeError('PayGate readiness failed')

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def credential_hashes(conn):
    return [(r[0], hashlib.sha256(r[1].encode()).hexdigest())
            for r in conn.execute("SELECT id,credential FROM payment_accounts WHERE provider!='mock' ORDER BY id")]

assert run('systemctl', 'is-active', 'paygate.service') == 'active', 'service must be active before deploy'

# Snapshot protected config bytes; they must be identical after deploy.
env_before, unit_before = sha(ENV), sha(UNIT)

backup = Path('/root/paygate-backups') / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-pre-studio4b')
backup.mkdir(mode=0o700)
os.umask(0o077)
shutil.copy2(ENV, backup / 'paygate.env')
shutil.copy2(UNIT, backup / 'paygate.service')
if DB.with_name('secret.key').exists():
    shutil.copy2(DB.with_name('secret.key'), backup / 'secret.key')
with tarfile.open(backup / 'runtime.tgz', 'w:gz') as tar:
    for part in PARTS:
        if (APP / part).exists():
            tar.add(APP / part, arcname=part)

# Capture protected DB state before any change.
with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as before:
    assert before.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    original_credentials = credential_hashes(before)
    original_limits = before.execute('SELECT * FROM merchant_login_limits ORDER BY user_id,provider').fetchall()
    original_rows = {t: before.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
                     for t in ['users', 'orders', 'seen_transactions', 'payment_accounts', 'api_keys']}
    assert before.execute("SELECT COUNT(*) FROM orders WHERE provider='mock'").fetchone()[0] == 0

run('systemctl', 'stop', 'paygate.service')
try:
    for part in PARTS:
        source, target = SRC / part, APP / part
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
    run('systemctl', 'start', 'paygate.service')
    health()
    # ENV and unit must be byte-identical: this deploy never touches config.
    assert sha(ENV) == env_before, 'ENV changed unexpectedly'
    assert sha(UNIT) == unit_before, 'systemd unit changed unexpectedly'
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as after:
        assert after.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert credential_hashes(after) == original_credentials, 'Non-Mock credentials changed'
        assert {t: after.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in original_rows} == original_rows, 'Row counts changed'
        assert after.execute('SELECT * FROM merchant_login_limits ORDER BY user_id,provider').fetchall() == original_limits, 'Login cooldown state changed'
        console_table = after.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='console_events'").fetchone()[0]
        statuses = after.execute('SELECT provider,status FROM payment_accounts').fetchall()
    assert console_table == 1, 'console_events table not created'
    for folder in ['src', 'public', 'views']:
        for source in (SRC / folder).rglob('*'):
            if source.is_file():
                assert source.read_bytes() == (APP / source.relative_to(SRC)).read_bytes(), source
    print(json.dumps({
        'deployed': str(APP), 'release': 'studio4', 'backup': str(backup),
        'service': run('systemctl', 'is-active', 'paygate.service'), 'health': True,
        'db_integrity': 'ok', 'console_events_table': True,
        'rows_preserved': original_rows, 'non_mock_credentials_unchanged': True,
        'login_cooldowns_unchanged': True, 'env_unchanged': True, 'unit_unchanged': True,
        'account_statuses': statuses, 'upstream_requests': 0,
    }))
except Exception:
    run('systemctl', 'stop', 'paygate.service')
    with tarfile.open(backup / 'runtime.tgz') as tar:
        tar.extractall(APP, filter='data')
    run('systemctl', 'start', 'paygate.service')
    health()
    print('Update failed; original runtime restored. ENV/unit/DB untouched. Additive migration retained. Backup:', backup)
    raise
