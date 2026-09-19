"""Deploy only changed UI files. Protected runtime backup; rollback on health failure."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import shutil
import subprocess
import time
import urllib.request

src, app = Path('/root/paygate'), Path('/opt/paygate')
parts = ['public/css/app.css', 'public/js/pages.js'] + [str(p.relative_to(src)) for p in (src/'views').rglob('*.ejs')]
parts = [n for n in parts if (src/n).read_bytes() != (app/n).read_bytes()]
assert parts, 'No UI diff to deploy'
assert all(n.startswith(('public/', 'views/')) for n in parts)
backend = {str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (app/'src').rglob('*.js')}
backup = Path('/root/paygate-backups') / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-pre-clean-runtime')
backup.mkdir(mode=0o700)
for n in parts:
    (backup/n).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(app/n, backup/n)
(backup/'manifest.json').write_text(json.dumps({'parts':parts, 'backend_sha256':backend}, indent=2))

def health():
    end = time.monotonic()+20
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=2) as response:
                if response.status == 200 and json.load(response)['ok']:
                    return
        except OSError:
            pass
        time.sleep(.2)
    raise RuntimeError('PayGate health failed')

def replace(source, target):
    staging = target.with_name(target.name+'.ui-new')
    try:
        shutil.copy2(source, staging)
        staging.replace(target)
    finally:
        staging.unlink(missing_ok=True)

try:
    for n in parts:
        replace(src/n, app/n)
    subprocess.run(['systemctl','restart','paygate.service'],check=True)
    health()
    assert all((src/n).read_bytes() == (app/n).read_bytes() for n in parts)
    assert all(hashlib.sha256((app/n).read_bytes()).hexdigest() == h for n,h in backend.items())
except Exception:
    for n in parts:
        replace(backup/n, app/n)
    subprocess.run(['systemctl','restart','paygate.service'],check=True)
    health()
    raise
print(json.dumps({'deployed':parts, 'backup':str(backup), 'health':True, 'backend_unchanged':True, 'db_env_unit_untouched':True}))
