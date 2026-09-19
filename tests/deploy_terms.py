"""Run python3 tests/deploy_terms.py. Extract only pure comparator; never deploy."""
import ast
import hashlib
from pathlib import Path
import sqlite3

source = ast.parse((Path(__file__).parents[1]/'deploy/update_terms.py').read_text())
assert any(isinstance(n,ast.Constant) and n.value=='.py' for n in ast.walk(source)), 'Browser worker Python must be included in production deployment'
text=(Path(__file__).parents[1]/'deploy/update_terms.py').read_text()
assert 'browser.conf' in text and 'daemon-reload' in text and 'unit_previous' in text, 'Browser resource drop-in requires backup and rollback'
function = next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='snapshot')
namespace={'hashlib':hashlib}
exec(compile(ast.Module(body=[function],type_ignores=[]),'snapshot-only','exec'),namespace)
snapshot=namespace['snapshot']
db=sqlite3.connect(':memory:')
for table in ['users','orders','seen_transactions','api_keys','merchant_login_limits']:
    db.execute('CREATE TABLE '+table+'(id INTEGER, updated_at INTEGER)')
    db.execute('INSERT INTO '+table+' VALUES(1,10)')
db.execute('CREATE TABLE payment_accounts(id INTEGER,status TEXT,last_error TEXT,credential_source TEXT,updated_at INTEGER,credential TEXT,next_poll_at INTEGER)')
db.execute("INSERT INTO payment_accounts VALUES(1,'paused','ENV_INCOMPLETE','env',10,'synthetic',0)")
before=snapshot(db)
db.execute('UPDATE payment_accounts SET updated_at=20')
assert snapshot(db)==before, 'Startup-only incomplete-env timestamp must not trigger code rollback'
for field,value in [('credential','changed'),('next_poll_at',50),('status','active'),('credential_source','dashboard')]:
    db.execute('SAVEPOINT probe')
    db.execute('UPDATE payment_accounts SET '+field+'=?',(value,))
    assert snapshot(db)!=before, field
    db.execute('ROLLBACK TO probe');db.execute('RELEASE probe')
db.execute('UPDATE users SET updated_at=20')
assert snapshot(db)!=before, 'User revision must remain compared'
db.execute('UPDATE users SET updated_at=10')
db.execute("UPDATE payment_accounts SET credential_source='dashboard'")
before=snapshot(db)
db.execute('UPDATE payment_accounts SET updated_at=30')
assert snapshot(db)!=before, 'Dashboard session revision must remain compared'
print('PASS deploy comparator: only incomplete-env startup timestamp ignored; credentials/status/cooldown/source/user/dashboard revisions protected')
