import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('policy_sync',Path(__file__).with_name('sync.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Policies(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        base=Path(self.temp.name);self.source=base/'source';self.source.mkdir();self.snap=base/'snap';self.snap.mkdir();self.state=base/'state';self.state.mkdir()
        self.device={'AutoSelectCertificateForUrls':[json.dumps({'pattern':'https://192.168.0.230:8090','filter':{'ISSUER':{'CN':'JMS Device CA'}}})]}
        (self.source/'jms-device.json').write_text(json.dumps(self.device));(self.source/'kesher-chat-kiosk.json').write_text(json.dumps({'CACertificates':['test-public-ca']}))
        (self.snap/'100').mkdir();(self.snap/'current').symlink_to('100');(self.snap/'common').mkdir()
    def run_sync(self):return module.sync(self.source,self.snap,self.state)
    def test_revision_upgrade_and_rollback(self):
        self.assertEqual(len(self.run_sync()),2)
        original=(self.snap/'100/policies/managed/jms-device.json').stat().st_mtime_ns
        self.assertEqual(self.run_sync(),[]);self.assertEqual(original,(self.snap/'100/policies/managed/jms-device.json').stat().st_mtime_ns)
        (self.snap/'200').mkdir();(self.snap/'current').unlink();(self.snap/'current').symlink_to('200')
        self.assertEqual(len(self.run_sync()),2)
        self.assertEqual((self.snap/'200/policies/managed/jms-device.json').read_bytes(),(self.source/'jms-device.json').read_bytes())
        self.assertEqual(list((self.snap/'common').iterdir()),[])
        (self.snap/'current').unlink();(self.snap/'current').symlink_to('100');self.assertEqual(self.run_sync(),[])
    def test_source_change_and_backup(self):
        self.run_sync();old=(self.snap/'100/policies/managed/jms-device.json').read_bytes()
        self.device['AutoSelectCertificateForUrls'][0]=self.device['AutoSelectCertificateForUrls'][0].replace('.230:', '.231:');(self.source/'jms-device.json').write_text(json.dumps(self.device))
        self.assertEqual(len(self.run_sync()),1);self.assertEqual(next((self.state/'backups/100').iterdir()).read_bytes(),old)
    def test_invalid_source_does_not_overwrite(self):
        self.run_sync();old=(self.snap/'100/policies/managed/jms-device.json').read_bytes();(self.source/'jms-device.json').write_text('{}')
        with self.assertRaises(ValueError):self.run_sync()
        self.assertEqual((self.snap/'100/policies/managed/jms-device.json').read_bytes(),old)
    def test_reject_outside_target(self):
        outside=Path(self.temp.name)/'outside';outside.mkdir();(self.snap/'100/policies').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(ValueError):self.run_sync()
        self.assertEqual(list(outside.iterdir()),[])
    def test_partial_new_revision_is_prepared(self):
        (self.snap/'201').mkdir();self.assertEqual(len(self.run_sync()),4)
        (self.snap/'current').unlink();(self.snap/'current').symlink_to('201');self.assertEqual(self.run_sync(),[])
if __name__=='__main__':unittest.main()
