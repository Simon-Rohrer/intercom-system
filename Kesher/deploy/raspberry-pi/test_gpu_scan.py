import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('launcher',Path(__file__).with_name('kesher-pi-launcher.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class GPUScanTests(unittest.TestCase):
 def test_filters_non_drm_and_retains_units_and_keys(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);(root/'123/fd').mkdir(parents=True);(root/'123/fdinfo').mkdir()
   for n,target,data in [('1','socket:[123]','drm-engine-wrong: 3 ns'),('2','/dev/dri/renderD128','drm-client-id: 7\ndrm-engine-render: 2 ms\n'),('3','/dev/dri/card0','drm-client-id: 8\ndrm-engine-compute: 3 us\n')]:
    (root/'123/fd'/n).symlink_to(target);(root/'123/fdinfo'/n).write_text(data)
   scan=os.scandir
   def redirect(path):return scan(root if path=='/proc' else path)
   with patch.object(m.os,'scandir',side_effect=redirect):
    self.assertEqual(m.read_gpu_engine_times(),{'123:7:render':2000000,'123:8:compute':3000})
 def test_unreadable_link_keeps_original_fallback(self):
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);(root/'1/fd').mkdir(parents=True);(root/'1/fdinfo').mkdir()
   (root/'1/fd/9').touch();(root/'1/fdinfo/9').write_text('drm-engine-render: 99 ns')
   scan=os.scandir
   with patch.object(m.os,'scandir',side_effect=lambda p:scan(root if p=='/proc' else p)),patch.object(m.os,'readlink',side_effect=PermissionError):
    self.assertEqual(m.read_gpu_engine_times(),{'1:9:render':99})
 def test_process_disappearing_does_not_abort(self):
  with patch.object(m.os,'scandir',side_effect=FileNotFoundError):
   self.assertEqual(m.read_gpu_engine_times(),{})
class SamplerCacheTests(unittest.TestCase):
 def test_samples_only_every_15_seconds_and_returns_independent_results(self):
  with patch.object(m,'read_cpu_times',return_value=(100,20)),patch.object(m,'read_gpu_engine_times',return_value={}),patch.object(m.time,'monotonic',return_value=100):
   sampler=m.SystemMetricsSampler()
  with patch.object(sampler,'cpu_percent',return_value=25) as cpu,patch.object(sampler,'gpu_percent',return_value=None),patch.object(m,'read_memory_percent',return_value=60),patch.object(m,'read_temperature_c',return_value=65),patch.object(m.time,'monotonic',side_effect=[100,104,114,115]):
   first=sampler.sample();first['cpuPercent']=999
   self.assertEqual(sampler.sample()['cpuPercent'],25)
   self.assertEqual(sampler.sample()['cpuPercent'],25)
   self.assertEqual(cpu.call_count,1)
   self.assertEqual(sampler.sample()['cpuPercent'],25)
   self.assertEqual(cpu.call_count,2)

if __name__=='__main__':unittest.main()
