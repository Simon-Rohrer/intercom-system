#!/usr/bin/env python3
"""Isolated updater simulations; never touches /opt/companion or real settings."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('legacy_main', type=Path)
parser.add_argument('rebundled_main', type=Path)
args = parser.parse_args()
here = Path(__file__).resolve().parent
node = shutil.which('node')
with tempfile.TemporaryDirectory(prefix='jms-page-update-test-') as temp:
    root = Path(temp)
    app, state, user_data = root/'companion', root/'state', root/'user-data'
    app.mkdir(); user_data.mkdir()
    (user_data/'settings').write_text('must remain unchanged')
    (app/'main.js').write_bytes(args.legacy_main.read_bytes())
    (app/'BUILD').write_text('current-legacy-build')
    (app/'asset').write_text('current asset')
    def run():
        result = subprocess.run([sys.executable,str(here/'ensure.py'),'--app-dir',str(app),'--state-dir',str(state),'--node',node],capture_output=True,text=True)
        if result.returncode: raise AssertionError(result.stdout+'\n'+result.stderr)
        return json.loads((state/'status.json').read_text())
    first = run()
    assert first['state']=='ready' and first['tests']==7
    assert 'JMS_PAGE_LINKS_V2' in (app/'main.js').read_text()
    print('PASS initial legacy patch migrates automatically and creates last-good snapshot')
    before = (app/'main.js').stat().st_mtime_ns
    run()
    assert (app/'main.js').stat().st_mtime_ns==before
    print('PASS repeated startup is idempotent')
    shutil.rmtree(app); app.mkdir()
    (app/'main.js').write_bytes(args.rebundled_main.read_bytes())
    (app/'BUILD').write_text('simulated-update-new-identifiers')
    (app/'asset').write_text('updated asset')
    second = run()
    assert second['state']=='ready' and second['build']=='simulated-update-new-identifiers'
    assert 'JMS_PAGE_LINKS_V2' in (app/'main.js').read_text()
    assert (app/'asset').read_text()=='updated asset'
    print('PASS vendor-style directory replacement and changed minified identifiers are automatically patched and tested')
    working_hash = hashlib.sha256((app/'main.js').read_bytes()).hexdigest()
    shutil.rmtree(app); app.mkdir()
    (app/'main.js').write_text('console.log("incompatible application format")')
    (app/'BUILD').write_text('simulated-incompatible-update')
    (app/'asset').write_text('incompatible asset')
    fallback = run()
    assert fallback['state']=='fallback'
    assert hashlib.sha256((app/'main.js').read_bytes()).hexdigest()==working_hash
    assert (app/'asset').read_text()=='updated asset'
    assert (Path(fallback['rejected_application'])/'asset').read_text()=='incompatible asset'
    assert (user_data/'settings').read_text()=='must remain unchanged'
    run()
    assert json.loads((state/'status.json').read_text())['state']=='fallback'
    print('PASS incompatible update is quarantined; full last-good app is restored before launch; user data untouched')
    print('4 update guard simulations passed')
