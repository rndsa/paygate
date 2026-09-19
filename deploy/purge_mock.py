"""Remove only Mock history. Runtime must be stopped; --apply is explicit."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone


def real_digest(db):
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    data = {}
    for table in tables:
        suffix = " WHERE provider <> 'mock'" if table in ('orders', 'seen_transactions') else ''
        rows = db.execute('SELECT * FROM "' + table.replace('"', '""') + '"' + suffix).fetchall()
        data[table] = sorted(map(repr, rows))
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def purge(db):
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('BEGIN IMMEDIATE')
    try:
        before = real_digest(db)
        cross = db.execute("SELECT 1 FROM seen_transactions s JOIN orders o ON o.id=s.consumed_by WHERE (s.provider='mock') <> (o.provider='mock') LIMIT 1").fetchone()
        if cross:
            raise RuntimeError('Cross-provider reference; stop for manual review')
        transactions = db.execute("DELETE FROM seen_transactions WHERE provider='mock'").rowcount
        orders = db.execute("DELETE FROM orders WHERE provider='mock'").rowcount
        assert real_digest(db) == before, 'Non-Mock data changed'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        db.commit()
        return {'deleted_mock_orders': orders, 'deleted_mock_transactions': transactions, 'non_mock_unchanged': True}
    except BaseException:
        db.rollback()
        raise


def self_test():
    db = sqlite3.connect(':memory:')
    db.executescript("CREATE TABLE orders(id TEXT PRIMARY KEY,provider TEXT); CREATE TABLE seen_transactions(provider TEXT,consumed_by TEXT REFERENCES orders(id)); INSERT INTO orders VALUES('m','mock'),('g','gopay'); INSERT INTO seen_transactions VALUES('mock','m'),('gopay','g');")
    assert purge(db) == {'deleted_mock_orders': 1, 'deleted_mock_transactions': 1, 'non_mock_unchanged': True}
    assert db.execute('SELECT * FROM orders').fetchall() == [('g', 'gopay')]
    db.executescript("INSERT INTO orders VALUES('m','mock'); INSERT INTO seen_transactions VALUES('gopay','m');")
    try:
        purge(db)
    except RuntimeError:
        assert db.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 2
    else:
        raise AssertionError('Cross-provider deletion must fail')
    print('PASS purge removes only mock; cross-provider reference aborts')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        self_test()
    elif sys.argv[1:] == ['--apply']:
        assert subprocess.run(['systemctl', 'is-active', '--quiet', 'paygate.service']).returncode == 3, 'Stop paygate.service first'
        os.umask(0o077)
        backup = Path('/root/paygate-backups') / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-pre-purge-mock')
        backup.mkdir(mode=0o700)
        env_path = Path('/etc/paygate/paygate.env')
        shutil.copy2(env_path, backup / 'paygate.env')
        db = sqlite3.connect('/var/lib/paygate/paygate.db')
        with sqlite3.connect(backup / 'paygate.db') as saved:
            db.backup(saved)
            assert saved.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert real_digest(saved) == real_digest(db)
        # Before deletion, require the next service boot to disable all simulation.
        lines = env_path.read_text().splitlines()
        lines = [line for line in lines if line.split('=', 1)[0].strip() not in ('ENABLE_MOCK_PAY', 'MOCK_AUTOPAY_PROBABILITY')]
        lines += ['ENABLE_MOCK_PAY=0', 'MOCK_AUTOPAY_PROBABILITY=0']
        env_path.write_text('\n'.join(lines) + '\n')
        result = purge(db)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        result['remaining_mock_orders'] = db.execute("SELECT count(*) FROM orders WHERE provider='mock'").fetchone()[0]
        result['remaining_mock_transactions'] = db.execute("SELECT count(*) FROM seen_transactions WHERE provider='mock'").fetchone()[0]
        result['backup'] = str(backup)
        db.close()
        print(json.dumps(result))
    else:
        raise SystemExit('Use --self-test or --apply')
