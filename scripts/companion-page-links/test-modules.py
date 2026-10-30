#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('modules', Path(__file__).with_name('modules.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class ModuleProtectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.dev, self.data, self.state = root/'dev', root/'data', root/'state'
        self.state.mkdir(mode=0o700)
        self.module = self.dev/'companion-module-jms-control'
        self.led = self.data/'modules/librelight-0.2.0'
        for module, name in [(self.module,'jms-control'),(self.led,'librelight')]:
            (module/'companion').mkdir(parents=True)
            (module/'companion/manifest.json').write_text(json.dumps({'id':name,'version':'1.0.0','runtime':{'entrypoint':'../main.js'}}))
            (module/'main.js').write_text('module code')
            (module/'package.json').write_text('{}')
        (self.module/'jms-device.key').write_text('fixture credential only')
        (self.module/'jms-device.key').chmod(0o640)
        db = self.data/'v5.0/db.sqlite'
        db.parent.mkdir()
        self.connection = sqlite3.connect(db)
        self.addCleanup(self.connection.close)
        self.connection.execute('pragma journal_mode=WAL')
        self.connection.execute('create table controls(id text,value text)')
        self.connection.execute("insert into controls values ('button','original')")
        self.connection.commit()

    def run_guard(self):
        guard.ensure([self.dev,self.data/'modules'],self.data,self.state)
        return json.loads((self.state/'status.json').read_text())

    def test_complete_snapshot_and_wal(self):
        status = self.run_guard()
        self.assertEqual(status['module_count'],2)
        with sqlite3.connect(status['settings_snapshots'][0]) as backup:
            self.assertEqual(backup.execute('select value from controls').fetchone()[0],'original')
        self.assertEqual(self.state.stat().st_mode & 0o777,0o700)

    def test_missing_modules_restore_keys_modes_and_preserve_current_settings(self):
        self.run_guard()
        shutil.rmtree(self.module);shutil.rmtree(self.led)
        self.connection.execute("update controls set value='user changed button'");self.connection.commit()
        status = self.run_guard()
        self.assertEqual(len(status['restored']),2)
        self.assertEqual((self.module/'jms-device.key').read_text(),'fixture credential only')
        self.assertEqual((self.module/'jms-device.key').stat().st_mode & 0o777,0o640)
        self.assertEqual(self.connection.execute('select value from controls').fetchone()[0],'user changed button')

    def test_incomplete_module_is_retained_and_restored(self):
        self.run_guard();(self.led/'main.js').unlink()
        self.assertEqual(len(self.run_guard()['restored']),1)
        self.assertTrue(guard.valid_module(self.led))
        self.assertEqual(len(list((self.state/'incomplete').iterdir())),1)

    def test_legitimate_module_updates_are_kept_and_previous_snapshot_retained(self):
        self.run_guard()
        old=json.loads((self.state/'modules.json').read_text())[str(self.led)]['sha256']
        (self.led/'main.js').write_text('new user module')
        self.run_guard()
        self.assertEqual((self.led/'main.js').read_text(),'new user module')
        self.assertTrue((self.state/'objects'/old/'main.js').is_file())

    def test_restarts_deduplicate_snapshots_and_do_not_modify_live_modules(self):
        self.run_guard()
        before=(self.module/'main.js').stat().st_mtime_ns
        self.run_guard()
        self.assertEqual((self.module/'main.js').stat().st_mtime_ns,before)
        self.assertEqual(len(list((self.state/'objects').iterdir())),2)
        self.assertEqual(len(list((self.state/'settings').iterdir())),1)

    def test_corrupt_snapshot_cannot_replace_missing_module(self):
        self.run_guard()
        entry=json.loads((self.state/'modules.json').read_text())[str(self.module)]
        (self.state/'objects'/entry['sha256']/'main.js').write_text('corrupt')
        shutil.rmtree(self.module)
        with self.assertRaisesRegex(RuntimeError,'verification'):
            self.run_guard()
        self.assertFalse(self.module.exists())

if __name__=='__main__':unittest.main()
