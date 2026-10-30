#!/usr/bin/env python3
"""Persistent pre-start guard; validates patches before Companion can migrate data.

No network downloads, database writes, service restarts or Telegram messages.
--app-dir/--state-dir/--node support an isolated update simulation.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def atomic_json(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.chmod(0o600)
    os.replace(temp, path)

def copy_tree(source, target):
    # Preserve the vendor's executable bits, symlinks and ownership. Never link
    # mutable files to the live installation; use reflinks only when supported.
    if os.uname().sysname == 'Linux':
        target.mkdir()
        subprocess.run(['cp', '-a', '--reflink=auto', str(source) + '/.', str(target) + '/'], check=True)
    else:
        shutil.copytree(source, target, symlinks=True)

def runtime(app, override):
    if override:
        return Path(override)
    for rel in ['node-runtimes/main/bin/node', 'node-runtime/bin/node']:
        if (app / rel).is_file():
            return app / rel
    raise RuntimeError('No supported Companion Node runtime')

def command(node, *args):
    cmd = [str(node), *map(str, args)]
    # Treat installed application code as service-user code, never run extracted
    # Companion constructors with root privileges during behavioral tests.
    if os.geteuid() == 0:
        cmd = ['setpriv', '--reuid=companion', '--regid=companion', '--init-groups', '--no-new-privs', *cmd]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-4000:])
    return result.stdout

def ensure(app, state, node_override):
    main = app / 'main.js'
    status_path = state / 'status.json'
    good = state / 'last-good'
    manifest_path = state / 'last-good.json'
    engine_hash = hashlib.sha256(b''.join((HERE / p).read_bytes() for p in
        ['engine.cjs', 'selftest.cjs', 'legacy-v1.json', 'package-lock.json'])).hexdigest()
    old_status = json.loads(status_path.read_text()) if status_path.exists() else {}
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    current_hash = digest(main) if main.is_file() else None
    if (current_hash and current_hash == manifest.get('sha256') and
        manifest.get('engine_sha256') == engine_hash and (good / 'main.js').is_file() and
        digest(good / 'main.js') == current_hash):
        print('Page links: checked installation already active; no changes')
        return
    candidate_build = (app / 'BUILD').read_text().strip() if (app / 'BUILD').exists() else 'unknown'
    work = Path(tempfile.mkdtemp(prefix='jms-companion-page-links-'))
    # The transformer runs as the unprivileged application account.
    if os.geteuid() == 0:
        account = pwd.getpwnam('companion')
        os.chown(work, account.pw_uid, account.pw_gid)
    try:
        node = runtime(app, node_override)
        original = work / 'original.js'
        patched = work / 'patched.js'
        shutil.copyfile(main, original)
        original.chmod(0o644)
        print(command(node, HERE / 'engine.cjs', original, patched).strip())
        # Freeze the candidate before checking or installing it.
        if os.geteuid() == 0:
            os.chown(work, 0, 0)
            os.chown(patched, 0, 0)
        work.chmod(0o755)
        patched.chmod(0o644)
        command(node, '--check', patched)
        print(command(node, HERE / 'selftest.cjs', patched).strip())
        new_hash = digest(patched)
        originals = state / 'originals'
        originals.mkdir(exist_ok=True)
        saved_original = originals / (current_hash + '.js')
        if not saved_original.exists():
            shutil.copy2(main, saved_original)
        info = main.stat()
        temp_main = app / 'main.js.jms-new'
        shutil.copyfile(patched, temp_main)
        os.chmod(temp_main, info.st_mode & 0o777)
        if os.geteuid() == 0:
            os.chown(temp_main, info.st_uid, info.st_gid)
        os.replace(temp_main, main)
        assert digest(main) == new_hash
        snapshot = state / 'next-good'
        if snapshot.exists():
            shutil.rmtree(snapshot)
        copy_tree(app, snapshot)
        assert digest(snapshot / 'main.js') == new_hash
        previous = state / 'previous-good'
        if previous.exists():
            shutil.rmtree(previous)
        if good.exists():
            os.replace(good, previous)
        os.replace(snapshot, good)
        manifest = {'build': candidate_build, 'sha256': new_hash, 'engine_sha256': engine_hash}
        atomic_json(manifest_path, manifest)
        atomic_json(status_path, {**manifest, 'state': 'ready', 'validated_at': time.time(),
                                 'tests': 7, 'original_sha256': current_hash})
        print('Page links: automatically prepared ' + candidate_build)
    except Exception as error:
        # The new executable has NOT started and cannot have migrated the user's
        # configuration. Restore the whole last-good app, never its database.
        if not good.is_dir() or not manifest or digest(good / 'main.js') != manifest.get('sha256'):
            atomic_json(status_path, {'state': 'blocked', 'candidate': candidate_build, 'error': str(error), 'at': time.time()})
            raise RuntimeError('No verified fallback available; refusing unprotected startup: ' + str(error)) from error
        restore = app.with_name(app.name + '.jms-restore')
        if restore.exists():
            shutil.rmtree(restore)
        copy_tree(good, restore)
        assert digest(restore / 'main.js') == manifest['sha256']
        rejected = state / 'rejected'
        rejected.mkdir(exist_ok=True)
        quarantine = rejected / (str(time.time_ns()) + '-' + (current_hash or 'missing')[:12])
        if app.exists():
            os.replace(app, quarantine)
        os.replace(restore, app)
        atomic_json(status_path, {'state': 'fallback', 'active_build': manifest['build'],
                                 'candidate': candidate_build, 'error': str(error), 'at': time.time(),
                                 'rejected_application': str(quarantine)})
        print('Page links: incompatible update held back; continuing verified ' + manifest['build'])
        print('Reason: ' + str(error))
    finally:
        shutil.rmtree(work)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', type=Path, default=Path('/opt/companion'))
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/jms-companion-page-links'))
    parser.add_argument('--node')
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state_dir / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ensure(args.app_dir, args.state_dir, args.node)
