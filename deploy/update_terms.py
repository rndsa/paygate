"""Deploy PayGate + bounded browser resources; no env/auth/payment changes."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.request

src, app = Path('/root/paygate'), Path('/opt/paygate')
dbfile = Path('/var/lib/paygate/paygate.db')
parts = ['package.json', 'package-lock.json', 'LICENSE', 'README.md'] + [str(p.relative_to(src)) for d in ['src','public','views','docs'] for p in (src/d).rglob('*') if p.is_file() and p.suffix in ['.js','.py','.css','.ejs','.md']]
parts = [n for n in parts if not (app/n).exists() or (src/n).read_bytes() != (app/n).read_bytes()]
unit_path = Path('/etc/systemd/system/paygate.service.d/browser.conf')
unit_previous = unit_path.read_bytes() if unit_path.exists() else None
unit_source = src/'deploy/browser.conf'
unit_changed = unit_previous != unit_source.read_bytes()
assert parts, 'No diff to deploy'
assert subprocess.check_output(['systemctl','is-active','paygate.service'],text=True).strip() == 'active'
backup = Path('/root/paygate-backups') / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-pre-terms-shopee')
backup.mkdir(mode=0o700)
os.umask(0o077)
existing = [n for n in parts if (app/n).exists()]
for n in existing:
    (backup/n).parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(app/n,backup/n)
for secret in [Path('/etc/paygate/paygate.env'),dbfile.with_name('secret.key')]:
    if secret.exists():
        shutil.copy2(secret,backup/secret.name)
        (backup/secret.name).chmod(0o600)
if unit_previous is not None:
    (backup/'browser.conf').write_bytes(unit_previous)
(backup/'manifest.json').write_text(json.dumps({'parts':parts,'existing':existing,'unit_changed':unit_changed,'unit_previous_exists':unit_previous is not None},indent=2))

def health():
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/healthz',timeout=2) as r:
                if r.status==200 and json.load(r)['ok']:return
        except OSError:pass
        time.sleep(.2)
    raise RuntimeError('PayGate readiness failed')

def snapshot(conn):
    result = {}
    for table in ['users','orders','seen_transactions','payment_accounts','api_keys','merchant_login_limits']:
        cursor = conn.execute('SELECT * FROM '+table+' ORDER BY rowid')
        columns = [c[0] for c in cursor.description]
        rows = [dict(zip(columns,row)) for row in cursor.fetchall()]
        for row in rows:
            # Existing syncLabAccounts refreshes only this timestamp at every startup.
            if table == 'payment_accounts' and row['credential_source'] != 'dashboard' and row['status'] == 'paused' and row['last_error'] == 'ENV_INCOMPLETE':
                row['updated_at'] = 0
        result[table] = hashlib.sha256(repr(rows).encode()).hexdigest()
    return result

def replace(source,target):
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
    stage=target.with_name(target.name+'.terms-new')
    try:
        shutil.copy2(source,stage)
        stage.chmod(0o644)
        stage.replace(target)
    finally:stage.unlink(missing_ok=True)

subprocess.run(['systemctl','stop','paygate.service'],check=True)
try:
    with sqlite3.connect(dbfile) as before, sqlite3.connect(backup/'paygate.db') as saved:
        before.backup(saved)
        assert saved.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        original=snapshot(before)
    for n in parts:replace(src/n,app/n)
    if unit_changed:
        replace(unit_source,unit_path)
        subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','start','paygate.service'],check=True)
    health()
    with sqlite3.connect('file:'+str(dbfile)+'?mode=ro',uri=True) as after:
        assert after.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert snapshot(after)==original,'Business data changed unexpectedly'
    assert all((src/n).read_bytes()==(app/n).read_bytes() for n in parts)
except Exception:
    subprocess.run(['systemctl','stop','paygate.service'],check=True)
    for n in parts:
        if n in existing:replace(backup/n,app/n)
        else:(app/n).unlink(missing_ok=True)
    if unit_changed:
        if unit_previous is None:unit_path.unlink(missing_ok=True)
        else:replace(backup/'browser.conf',unit_path)
        subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','start','paygate.service'],check=True)
    health()
    raise
print(json.dumps({'deployed_files':len(parts),'parts':parts,'backup':str(backup),'health':True,'db_integrity':'ok','business_data_unchanged':True,'env_unchanged':True,'browser_unit_changed':unit_changed,'provider_requests':0}))
