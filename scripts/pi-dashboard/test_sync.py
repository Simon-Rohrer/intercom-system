import copy
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import tempfile
import unittest
import yaml
import sync

SOURCE = (Path(__file__).parent / 'services.before.yaml').read_text()
MAP = [{'group':'Raspberry Pis','station':'Kamera-1','deviceId':'kamera-1-pi'}]
NOW = 1_800_000_000_000
ROWS = {'kamera-1-pi': {'ip_address':'192.168.0.234','last_seen':NOW-1000}}

class SyncTests(unittest.TestCase):
    def test_only_seven_urls_change(self):
        changed, count = sync.replacements(SOURCE, MAP, ROWS, NOW)
        self.assertEqual(count, 7)
        self.assertEqual(changed, SOURCE.replace('http://192.168.0.161:61208', 'http://192.168.0.234:61208'))
        self.assertEqual(sync.replacements(changed, MAP, ROWS, NOW), (changed, 0))

    def test_next_ip_from_same_identity(self):
        first, _ = sync.replacements(SOURCE, MAP, ROWS, NOW)
        rows = copy.deepcopy(ROWS)
        rows['kamera-1-pi']['ip_address'] = '192.168.0.235'
        second, count = sync.replacements(first, MAP, rows, NOW)
        self.assertEqual(count, 7)
        self.assertEqual(second, first.replace('192.168.0.234', '192.168.0.235'))

    def test_stale_unknown_invalid_and_future_do_not_change(self):
        cases = [{}, {'other-device': ROWS['kamera-1-pi']}]
        for ip in ['127.0.0.1', '8.8.8.8', '::1', 'example.com', '192.168.0.1/path']:
            cases.append({'kamera-1-pi': {'ip_address':ip,'last_seen':NOW}})
        for age in [120001, -1000]:
            cases.append({'kamera-1-pi': {'ip_address':'192.168.0.235','last_seen':NOW-age}})
        for rows in cases:
            with self.subTest(rows=rows):
                self.assertEqual(sync.replacements(SOURCE, MAP, rows, NOW), (SOURCE,0))

    def test_ambiguous_mapping_rejected(self):
        with self.assertRaises(ValueError):
            sync.replacements(SOURCE, MAP * 2, ROWS, NOW)
        with self.assertRaises(ValueError):
            sync.replacements(SOURCE, [{**MAP[0], 'station':'missing'}], ROWS, NOW)

    def test_atomic_backup_and_idempotency(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'services.yaml'
            p.write_bytes(b'before')
            os.chmod(p,0o640)
            self.assertTrue(sync.install(p,b'before',b'after',Path(td)))
            self.assertEqual(p.read_bytes(),b'after')
            self.assertEqual(p.stat().st_mode & 0o777, 0o640)
            self.assertEqual(next(Path(td).glob('services.*.yaml')).read_bytes(),b'before')
            mtime = p.stat().st_mtime_ns
            self.assertFalse(sync.install(p,b'after',b'after',Path(td)))
            self.assertEqual(p.stat().st_mtime_ns,mtime)
            with self.assertRaises(RuntimeError):
                sync.install(p,b'outdated',b'wrong',Path(td))
            self.assertEqual(p.read_bytes(),b'after')

    def test_read_live_wal_database(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'test.db'
            with closing(sqlite3.connect(p)) as writer:
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute('CREATE TABLE raspberry_pi_heartbeats (device_id TEXT, ip_address TEXT, last_seen INTEGER)')
                writer.execute('INSERT INTO raspberry_pi_heartbeats VALUES (?,?,?)',('kamera-1-pi','192.168.0.234',NOW))
                writer.commit()
                self.assertEqual(sync.read_heartbeats(p)['kamera-1-pi']['ip_address'],'192.168.0.234')

if __name__ == '__main__': unittest.main()
