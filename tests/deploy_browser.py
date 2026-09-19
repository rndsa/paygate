"""Isolated deploy regression tests: python3 tests/deploy_browser.py.

Execute the real update_terms.py AST, removing only imports. All absolute paths
are redirected to a TemporaryDirectory; process/network/clock boundaries are
strict fakes, while copies, atomic replacements and SQLite backups are real.
No application, systemctl command, auth or payment request is executed.
"""
import ast
import contextlib
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE_TREE = ast.parse((ROOT / 'deploy/update_terms.py').read_text())
CANDIDATE = (ROOT / 'deploy/browser.conf').read_bytes()
PREVIOUS = b'# prior config, preserve exact bytes\r\n[Service]\r\nTasksMax=128\r\n'
TABLES = ('users', 'orders', 'seen_transactions', 'payment_accounts',
          'api_keys', 'merchant_login_limits')
SOURCE_SECRET = b'SYNTHETIC_SOURCE_SECRET_NOT_FOR_RELEASE'
ENV_SECRET = b'SYNTHETIC_RUNTIME_ENV_SECRET'
KEY_SECRET = b'SYNTHETIC_RUNTIME_KEY_SECRET'
DB_SECRET = b'SYNTHETIC_DATABASE_CREDENTIAL'


def executable_tree():
    """Keep production control flow/functions intact; fail closed on new imports."""
    expected = {
        'from pathlib import Path', 'from datetime import datetime, timezone',
        'import hashlib', 'import json', 'import os', 'import shutil',
        'import sqlite3', 'import subprocess', 'import time', 'import urllib.request',
    }
    tree = copy.deepcopy(SOURCE_TREE)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if node not in tree.body or ast.unparse(node) not in expected:
                raise AssertionError('Unexpected deploy import: ' + ast.unparse(node))
    tree.body = [node for node in tree.body
                 if not isinstance(node, (ast.Import, ast.ImportFrom))]
    return compile(ast.fix_missing_locations(tree), str(ROOT / 'deploy/update_terms.py'), 'exec')


def files(directory):
    return {str(path.relative_to(directory)): path.read_bytes()
            for path in directory.rglob('*') if path.is_file()}


class Fixture:
    def __init__(self, root, previous=PREVIOUS, fail_health=False,
                 fail_copy=False, mutate=None):
        self.root = root
        self.src, self.app = root / 'source', root / 'app'
        self.db = root / 'state/paygate.db'
        self.env, self.key = root / 'etc/paygate.env', root / 'state/secret.key'
        self.unit = root / 'systemd/browser.conf'
        self.backups = root / 'backups'
        self.previous = previous
        self.fail_health, self.fail_copy, self.mutate = fail_health, fail_copy, mutate
        self.starts = 0
        self.clock = 0.0
        self.calls, self.http_calls = [], []
        self.failure = None
        self.output = ''
        self.namespace = {}
        release = {
            'package.json': b'{"name":"synthetic-release","version":"2"}\n',
            'package-lock.json': b'{"lockfileVersion":3}\n',
            'LICENSE': b'fixture license\n',
            'README.md': b'new release readme\n',
            'src/server.js': b'// synthetic candidate, never executed\n',
            'src/services/browser_worker.py': b'# synthetic worker, never executed\n',
            'public/site.css': b'body { color: black; }\n',
            'views/index.ejs': b'<main>fixture</main>\n',
            'docs/browser.md': b'fixture browser documentation\n',
        }
        for name, data in release.items():
            self.put(self.src / name, data)
            if name != 'src/services/browser_worker.py':
                self.put(self.app / name, data if name == 'LICENSE' else b'previous ' + data)
        self.release = release
        self.put(self.app / 'public/unchanged.css', b'keep runtime-only file\n')
        self.put(self.src / 'deploy/browser.conf', CANDIDATE)
        for name in ('.env', 'secret.key', 'src/.env', 'src/secret.key',
                     'public/private.db', 'tests/not-a-release.js',
                     'node_modules/fixture/index.js', '.git/config'):
            self.put(self.src / name, SOURCE_SECRET)
        self.put(self.env, b'FIXTURE_TOKEN=' + ENV_SECRET + b'\n', 0o600)
        self.put(self.key, KEY_SECRET, 0o600)
        self.backups.mkdir()
        if previous is not None:
            self.put(self.unit, previous, 0o640)
        self.unit_stat = self.unit.stat() if self.unit.exists() else None
        with sqlite3.connect(self.db) as conn:
            for table in TABLES:
                if table == 'payment_accounts':
                    conn.execute('CREATE TABLE payment_accounts(id INTEGER PRIMARY KEY, '
                                 'status TEXT, last_error TEXT, credential_source TEXT, '
                                 'updated_at INTEGER, credential TEXT, next_poll_at INTEGER)')
                    conn.executemany('INSERT INTO payment_accounts VALUES(?,?,?,?,?,?,?)', [
                        (1, 'paused', 'ENV_INCOMPLETE', 'env', 10, DB_SECRET.decode(), 0),
                        (2, 'active', None, 'dashboard', 20, 'synthetic-dashboard', 7),
                    ])
                else:
                    conn.execute('CREATE TABLE ' + table +
                                 '(id INTEGER PRIMARY KEY, updated_at INTEGER, payload TEXT)')
                    conn.executemany('INSERT INTO ' + table + ' VALUES(?,?,?)',
                                     [(1, 10, 'first-' + table), (2, 20, 'second-' + table)])
        self.db_before = self.database_rows(self.db)
        self.app_before, self.source_before = files(self.app), files(self.src)
        self.secrets_before = {path: (path.read_bytes(), path.stat().st_mode)
                               for path in (self.env, self.key)}
        self.path_map = {
            '/root/paygate': self.src, '/opt/paygate': self.app,
            '/var/lib/paygate/paygate.db': self.db,
            '/etc/paygate/paygate.env': self.env,
            '/etc/systemd/system/paygate.service.d/browser.conf': self.unit,
            '/root/paygate-backups': self.backups,
        }

    @staticmethod
    def put(path, data, mode=0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    @staticmethod
    def database_rows(path):
        with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as conn:
            return {table: conn.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall()
                    for table in TABLES}

    def confined(self, path):
        if not Path(path).resolve().is_relative_to(self.root.resolve()):
            raise AssertionError('Attempted filesystem escape: ' + str(path))
        return path

    def path(self, value):
        if value not in self.path_map:
            raise AssertionError('Unmapped production path: ' + str(value))
        return self.path_map[value]

    def connect(self, database, **kwargs):
        text = str(database)
        self.confined(text[5:].split('?', 1)[0] if text.startswith('file:') else text)
        return sqlite3.connect(database, **kwargs)

    def copy2(self, source, destination):
        self.confined(source)
        self.confined(destination)
        result = shutil.copy2(source, destination)
        if self.fail_copy and source == self.src / 'deploy/browser.conf':
            # Fail after a real stage write, proving replace() cleans it up.
            raise OSError('injected drop-in stage copy failure')
        return result

    def process(self, command, **kwargs):
        allowed = [['systemctl', 'is-active', 'paygate.service'],
                   ['systemctl', 'stop', 'paygate.service'],
                   ['systemctl', 'start', 'paygate.service'],
                   ['systemctl', 'daemon-reload']]
        if command not in allowed:
            raise AssertionError('Unexpected subprocess: ' + repr(command))
        self.calls.append(list(command))
        if command[1] == 'is-active':
            return 'active\n'
        if command[1] == 'start':
            self.starts += 1
            if self.starts == 1 and self.mutate:
                with self.connect(self.db) as conn:
                    self.mutate(conn)
        return subprocess.CompletedProcess(command, 0)

    def urlopen(self, url, timeout):
        if url != 'http://127.0.0.1:3000/healthz' or timeout != 2:
            raise AssertionError('Unexpected network request: ' + str(url))
        self.http_calls.append(url)
        if self.fail_health and self.starts == 1:
            raise OSError('injected readiness failure')
        response = io.BytesIO(b'{"ok":true}')
        response.status = 200
        return response

    def sleep(self, seconds):
        self.clock += seconds

    @staticmethod
    def restricted_import(name, *args, **kwargs):
        # datetime.strftime imports time internally even when datetime was injected.
        if name != 'time':
            raise AssertionError('Unexpected runtime import: ' + name)
        return __import__(name, *args, **kwargs)

    def run(self):
        # Compile before entering the try: isolation failures must not be mistaken
        # for an expected production rollback exception.
        code = executable_tree()
        self.namespace = {
            '__builtins__': {name: value for name, value in vars(__import__('builtins')).items()
                             if name not in ('__import__', 'open')},
            'Path': self.path, 'datetime': datetime, 'timezone': timezone,
            'hashlib': hashlib, 'json': json, 'os': SimpleNamespace(umask=os.umask),
            'shutil': SimpleNamespace(copy2=self.copy2),
            'sqlite3': SimpleNamespace(connect=self.connect),
            'subprocess': SimpleNamespace(run=self.process, check_output=self.process),
            'time': SimpleNamespace(monotonic=lambda: self.clock, sleep=self.sleep),
            'urllib': SimpleNamespace(request=SimpleNamespace(urlopen=self.urlopen)),
        }
        self.namespace['__builtins__']['__import__'] = self.restricted_import
        output = io.StringIO()
        original_umask = os.umask(0o022)
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                exec(code, self.namespace)
        except Exception as error:
            self.failure = error
        finally:
            os.umask(original_umask)
            self.output = output.getvalue()
        backup_dirs = list(self.backups.iterdir())
        if len(backup_dirs) != 1:
            raise AssertionError('Expected one real backup, got ' + repr(backup_dirs) +
                                 '; deploy failed with ' + repr(self.failure)) from self.failure
        self.backup = backup_dirs[0]
        self.manifest = json.loads((self.backup / 'manifest.json').read_text())
        return self


class BrowserDeployTests(unittest.TestCase):
    def fixture(self, **kwargs):
        temporary = tempfile.TemporaryDirectory(prefix='paygate-deploy-browser-')
        self.addCleanup(temporary.cleanup)
        return Fixture(Path(temporary.name), **kwargs).run()

    def assert_isolated(self, fixture):
        self.assertEqual(files(fixture.src), fixture.source_before, 'source tree was modified')
        for path, (data, mode) in fixture.secrets_before.items():
            self.assertEqual(path.read_bytes(), data, 'runtime secret changed')
            self.assertEqual(path.stat().st_mode, mode)
        self.assertEqual(Fixture.database_rows(fixture.backup / 'paygate.db'), fixture.db_before)
        self.assertEqual(stat.S_IMODE(fixture.backup.stat().st_mode), 0o700)
        for name, original in [('paygate.env', fixture.env), ('secret.key', fixture.key)]:
            self.assertEqual((fixture.backup / name).read_bytes(), original.read_bytes())
            self.assertEqual(stat.S_IMODE((fixture.backup / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((fixture.backup / 'paygate.db').stat().st_mode), 0o600)
        for name, data in files(fixture.app).items():
            for secret in (SOURCE_SECRET, ENV_SECRET, KEY_SECRET, DB_SECRET):
                self.assertNotIn(secret, data, 'secret leaked to app/' + name)
        for secret in (SOURCE_SECRET, ENV_SECRET, KEY_SECRET, DB_SECRET):
            self.assertNotIn(secret.decode(), fixture.output)
            self.assertNotIn(secret, (fixture.backup / 'manifest.json').read_bytes())
        self.assertFalse(list(fixture.root.rglob('*.terms-new')), 'staging files leaked')
        expected_parts = {name for name, data in fixture.release.items()
                          if fixture.app_before.get(name) != data}
        self.assertEqual(set(fixture.manifest['parts']), expected_parts)
        self.assertEqual(set(fixture.manifest['existing']), expected_parts & fixture.app_before.keys())
        self.assertEqual(fixture.manifest['unit_changed'], fixture.previous != CANDIDATE)
        self.assertEqual(fixture.manifest['unit_previous_exists'], fixture.previous is not None)
        if fixture.previous is None:
            self.assertFalse((fixture.backup / 'browser.conf').exists())
        else:
            self.assertEqual((fixture.backup / 'browser.conf').read_bytes(), fixture.previous)
        for name in fixture.manifest['existing']:
            self.assertEqual((fixture.backup / name).read_bytes(), fixture.app_before[name])
        self.assertTrue(fixture.http_calls)
        self.assertEqual(fixture.calls[0], ['systemctl', 'is-active', 'paygate.service'])
        self.assertEqual(fixture.calls[-1], ['systemctl', 'start', 'paygate.service'])

    def assert_promoted(self, fixture):
        self.assertIsNone(fixture.failure, repr(fixture.failure))
        expected = dict(fixture.app_before)
        expected.update(fixture.release)
        self.assertEqual(files(fixture.app), expected)
        self.assertEqual(fixture.unit.read_bytes(), CANDIDATE)
        report = json.loads(fixture.output)
        self.assertTrue(report['health'])
        self.assertTrue(report['business_data_unchanged'])
        self.assertTrue(report['env_unchanged'])
        self.assertEqual(report['browser_unit_changed'], fixture.previous != CANDIDATE)
        self.assertEqual(report['provider_requests'], 0)
        self.assertEqual(fixture.starts, 1)
        self.assertEqual(fixture.calls.count(['systemctl', 'daemon-reload']),
                         int(fixture.previous != CANDIDATE))
        self.assert_isolated(fixture)

    def assert_rolled_back(self, fixture, error_type, message):
        self.assertIsInstance(fixture.failure, error_type)
        self.assertEqual(str(fixture.failure), message)
        self.assertEqual(files(fixture.app), fixture.app_before)
        if fixture.previous is None:
            self.assertFalse(fixture.unit.exists(), 'previously absent drop-in must be removed')
        else:
            self.assertEqual(fixture.unit.read_bytes(), fixture.previous,
                             'rollback must restore exact previous drop-in bytes')
        self.assertEqual(fixture.output, '', 'failed deployment must not print success')
        self.assert_isolated(fixture)

    def assert_unit_untouched(self, fixture):
        after = fixture.unit.stat()
        self.assertEqual((after.st_ino, after.st_mtime_ns, after.st_mode),
                         (fixture.unit_stat.st_ino, fixture.unit_stat.st_mtime_ns,
                          fixture.unit_stat.st_mode))
        self.assertNotIn(['systemctl', 'daemon-reload'], fixture.calls)

    def test_promote_changed_dropin_backs_up_exact_previous_bytes(self):
        fixture = self.fixture()
        self.assert_promoted(fixture)
        self.assertEqual(Fixture.database_rows(fixture.db), fixture.db_before)
        self.assertEqual(stat.S_IMODE(fixture.unit.stat().st_mode), 0o644)
        self.assertIn('src/services/browser_worker.py', fixture.manifest['parts'])

    def test_promote_previously_missing_dropin(self):
        self.assert_promoted(self.fixture(previous=None))

    def test_promote_unchanged_dropin_does_not_replace_or_reload(self):
        fixture = self.fixture(previous=CANDIDATE)
        self.assert_promoted(fixture)
        self.assert_unit_untouched(fixture)

    def test_failed_health_restores_previous_dropin(self):
        fixture = self.fixture(fail_health=True)
        self.assert_rolled_back(fixture, RuntimeError, 'PayGate readiness failed')
        self.assertEqual(fixture.starts, 2)
        self.assertEqual(fixture.calls.count(['systemctl', 'daemon-reload']), 2)

    def test_failed_health_removes_previously_missing_dropin(self):
        fixture = self.fixture(previous=None, fail_health=True)
        self.assert_rolled_back(fixture, RuntimeError, 'PayGate readiness failed')
        self.assertEqual(fixture.starts, 2)
        self.assertEqual(fixture.calls.count(['systemctl', 'daemon-reload']), 2)

    def test_failed_health_preserves_unchanged_dropin(self):
        fixture = self.fixture(previous=CANDIDATE, fail_health=True)
        self.assert_rolled_back(fixture, RuntimeError, 'PayGate readiness failed')
        self.assert_unit_untouched(fixture)

    def test_partial_dropin_copy_failure_cleans_stage_and_restores_files(self):
        for previous in (PREVIOUS, None):
            with self.subTest(previous_exists=previous is not None):
                fixture = self.fixture(previous=previous, fail_copy=True)
                self.assert_rolled_back(fixture, OSError, 'injected drop-in stage copy failure')
                self.assertEqual(fixture.starts, 1)
                self.assertEqual(fixture.calls.count(['systemctl', 'daemon-reload']), 1)

    def test_every_business_table_change_triggers_real_file_rollback(self):
        for table in TABLES:
            with self.subTest(table=table):
                column = 'credential' if table == 'payment_accounts' else 'payload'
                fixture = self.fixture(mutate=lambda conn, t=table, c=column:
                                       conn.execute('UPDATE ' + t + ' SET ' + c + '=? WHERE id=2',
                                                    ('changed-fixture-value',)))
                self.assert_rolled_back(fixture, AssertionError, 'Business data changed unexpectedly')
                self.assertNotEqual(Fixture.database_rows(fixture.db), fixture.db_before)
                self.assertEqual(fixture.starts, 2)

    def test_only_incomplete_env_startup_timestamp_is_ignored(self):
        fixture = self.fixture(mutate=lambda conn:
                               conn.execute('UPDATE payment_accounts SET updated_at=99 WHERE id=1'))
        self.assert_promoted(fixture)
        self.assertNotEqual(Fixture.database_rows(fixture.db), fixture.db_before)

    def test_dashboard_timestamp_still_triggers_rollback(self):
        fixture = self.fixture(mutate=lambda conn:
                               conn.execute('UPDATE payment_accounts SET updated_at=99 WHERE id=2'))
        self.assert_rolled_back(fixture, AssertionError, 'Business data changed unexpectedly')


if __name__ == '__main__':
    unittest.main(verbosity=2)
