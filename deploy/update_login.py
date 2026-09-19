"""Supervised live-only update; no merchant login/feed/payment requests.
Keeps local protected backup; additive DB migrations allow old app rollback.
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
PARTS = ['src', 'public', 'views', 'docs', 'package.json', 'package-lock.json', 'README.md']

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

def credential_hashes(conn):
    return [(r[0], hashlib.sha256(r[1].encode()).hexdigest()) for r in conn.execute("SELECT id,credential FROM payment_accounts WHERE provider!='mock' ORDER BY id")]

assert run('systemctl', 'is-active', 'paygate.service') == 'active'
run('systemd-analyze', 'verify', str(SRC / 'deploy/paygate.service'))
backup = Path('/root/paygate-backups') / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-pre-login')
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
run('systemctl', 'stop', 'paygate.service')
try:
    with sqlite3.connect(DB) as before, sqlite3.connect(backup / 'paygate.db') as copy:
        before.backup(copy)
        assert copy.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert before.execute("SELECT username FROM users WHERE id=1").fetchone() == ('admin',)
        original_credentials = credential_hashes(before)
        original_limits = before.execute('SELECT * FROM merchant_login_limits ORDER BY user_id,provider').fetchall()
        original_rows = {t: before.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in ['users','orders','seen_transactions','payment_accounts','api_keys']}
        assert before.execute("SELECT COUNT(*) FROM orders WHERE provider='mock'").fetchone()[0] == 0
    retired = {'DEFAULT_PROVIDER','ENABLE_MOCK_PAY','MOCK_AUTOPAY_PROBABILITY','PAYMENT_TOLERANCE','POLL_INTERVAL_MS','LAB_UNOFFICIAL','LAB_USER_ID'}
    lines = [line for line in ENV.read_text().splitlines() if line.partition('=')[0].strip() not in retired]
    ENV.write_text('\n'.join(lines + ['LAB_UNOFFICIAL=1','LAB_USER_ID=1']) + '\n')
    ENV.chmod(0o600)
    for part in PARTS:
        source, target = SRC / part, APP / part
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
    shutil.copy2(SRC / 'deploy/paygate.service', UNIT)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', 'paygate.service')
    health()
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as after:
        assert after.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert credential_hashes(after) == original_credentials, 'Non-Mock credentials changed'
        assert {t: after.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in original_rows} == original_rows
        assert after.execute('SELECT * FROM merchant_login_limits ORDER BY user_id,provider').fetchall() == original_limits, 'Login cooldown state changed'
        statuses = after.execute('SELECT provider,status FROM payment_accounts').fetchall()
    for folder in ['src','public','views']:
        for source in (SRC / folder).rglob('*'):
            if source.is_file():
                assert source.read_bytes() == (APP / source.relative_to(SRC)).read_bytes(), source
    print(json.dumps({'deployed':str(APP),'backup':str(backup),'service':run('systemctl','is-active','paygate.service'),'health':True,'db_integrity':'ok','rows_preserved':original_rows,'non_mock_credentials_unchanged':True,'login_cooldowns_unchanged':True,'account_statuses':statuses,'owner_id':1,'lab_enabled':True,'upstream_login_requests':0}))
except Exception:
    run('systemctl', 'stop', 'paygate.service')
    shutil.copy2(backup / 'paygate.env', ENV)
    shutil.copy2(backup / 'paygate.service', UNIT)
    with tarfile.open(backup / 'runtime.tgz') as tar:
        tar.extractall(APP, filter='data')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', 'paygate.service')
    health()
    print('Update failed; original app/env/unit restored. Additive DB migration retained. Backup:', backup)
    raise
