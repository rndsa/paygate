"""Regression: deploying must preserve nonempty merchant cooldown rows, not clear them.
Extract only the snapshot and guard statements; never execute the real deploy script.
"""
import ast
import sqlite3
import unittest
from pathlib import Path


class CooldownDeployTest(unittest.TestCase):
    def test_preserves_existing_rows_and_detects_mutations(self):
        tree = ast.parse((Path(__file__).parents[1] / 'deploy/update_login.py').read_text())
        snapshots = [n for n in ast.walk(tree) if isinstance(n, ast.Assign) and
                     any(isinstance(t, ast.Name) and t.id == 'original_limits' for t in n.targets)]
        guards = [n for n in ast.walk(tree) if isinstance(n, ast.Assert) and
                  any(isinstance(x, ast.Name) and x.id == 'original_limits' for x in ast.walk(n))]
        self.assertEqual(len(snapshots), 1, 'snapshot live cooldowns before deployment')
        self.assertEqual(len(guards), 1, 'verify unchanged cooldowns, not an empty table')
        with sqlite3.connect(':memory:') as conn:
            conn.executescript('CREATE TABLE merchant_login_limits(user_id,provider,device_id,next_at,window_at,attempts);'
                               "INSERT INTO merchant_login_limits VALUES(1,'gopay','local-test',12345,100,4);")
            scope = {'before': conn, 'after': conn}
            snapshot = compile(ast.Module(body=snapshots, type_ignores=[]), '<snapshot>', 'exec')
            guard = compile(ast.Module(body=guards, type_ignores=[]), '<guard>', 'exec')
            exec(snapshot, scope)
            exec(guard, scope)
            conn.execute('UPDATE merchant_login_limits SET next_at=0')
            with self.assertRaises(AssertionError):
                exec(guard, scope)
            conn.execute('DELETE FROM merchant_login_limits')
            with self.assertRaises(AssertionError):
                exec(guard, scope)


if __name__ == '__main__':
    unittest.main()
