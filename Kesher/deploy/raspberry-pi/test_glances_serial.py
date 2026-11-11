import importlib.util
from pathlib import Path
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
spec=importlib.util.spec_from_file_location('serial',Path(__file__).with_name('glances-serial.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SerialTests(unittest.TestCase):
 def test_parallel_cards_share_one_collection_and_expired_cache_refreshes(self):
  class FakeAPI:
   def __init__(self):self.expired=True;self.calls=0
   def _GlancesRestfulApi__update_stats(self):
    if self.expired:
     self.calls+=1;time.sleep(.02);self.expired=False
  self.assertTrue(m.serialize_updates(FakeAPI));api=FakeAPI()
  def batch():
   gate=threading.Barrier(7)
   def call(_):gate.wait();api._GlancesRestfulApi__update_stats()
   with ThreadPoolExecutor(max_workers=7) as pool:list(pool.map(call,range(7)))
  batch();self.assertEqual(api.calls,1)
  batch();self.assertEqual(api.calls,1)
  api.expired=True;batch();self.assertEqual(api.calls,2)
 def test_changed_upstream_hook_does_not_break_service(self):
  with self.assertWarns(UserWarning):self.assertFalse(m.serialize_updates(type('NewAPI',(),{})))
if __name__=='__main__':unittest.main()
