#!/usr/bin/env python3
"""Preserve locally installed Companion modules and snapshot settings before startup.

Missing/incomplete known modules are restored; existing valid modules and the live
SQLite databases are never rolled back. No module code is executed as root.
"""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.chmod(0o600)
    os.replace(temp, path)


def tree_hash(root):
    digest = hashlib.sha256()
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        digest.update(json.dumps([str(path.relative_to(root)), stat.S_IMODE(info.st_mode),
                                 info.st_uid, info.st_gid]).encode())
        if path.is_symlink():
            digest.update(b'link:' + os.readlink(path).encode())
        elif path.is_file():
            digest.update(b'file:')
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
        elif not path.is_dir():
            raise RuntimeError('Unsupported module file: ' + str(path))
    return digest.hexdigest()


def copy_tree(source, target):
    if os.uname().sysname == 'Linux':
        target.mkdir()
        subprocess.run(['cp', '-a', '--reflink=auto', str(source) + '/.', str(target) + '/'], check=True)
    else:
        shutil.copytree(source, target, symlinks=True)


def valid_module(path):
    try:
        if path.is_symlink():
            return False
        manifest_file = path / 'companion/manifest.json'
        manifest = json.loads(manifest_file.read_text())
        entry = (manifest_file.parent / manifest['runtime']['entrypoint']).resolve()
        return bool(manifest['id']) and entry.is_relative_to(path.resolve()) and entry.is_file() and (path / 'package.json').is_file()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def ensure(roots, data, state):
    manifest_file = state / 'modules.json'
    old = json.loads(manifest_file.read_text()) if manifest_file.exists() else {}
    objects = state / 'objects'
    objects.mkdir(exist_ok=True, mode=0o700)
    current, restored = {}, []
    # Only known modules under the explicitly configured roots can be restored.
    for filename, saved in old.items():
        target = Path(filename)
        if target.parent not in roots or not target.name or target.is_symlink():
            raise RuntimeError('Unsafe saved module path: ' + filename)
        if valid_module(target):
            continue
        sha = saved['sha256']
        if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise RuntimeError('Invalid snapshot reference')
        backup = objects / sha
        if not valid_module(backup) or tree_hash(backup) != sha:
            raise RuntimeError('Module backup failed verification: ' + filename)
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix='.jms-restore-', dir=target.parent))
        try:
            copy_tree(backup, staging / 'module')
            if tree_hash(staging / 'module') != sha:
                raise RuntimeError('Module restore failed verification')
            if target.exists():
                rejected = state / 'incomplete'
                rejected.mkdir(exist_ok=True, mode=0o700)
                shutil.move(str(target), str(rejected / (str(time.time_ns()) + '-' + target.name)))
            os.replace(staging / 'module', target)
        finally:
            shutil.rmtree(staging)
        restored.append(filename)
    for root in roots:
        if not root.is_dir():
            continue
        for module in sorted(root.iterdir()):
            if not module.is_dir() or module.name.startswith('.'):
                continue
            if not valid_module(module):
                raise RuntimeError('Incomplete module; not overwriting backups: ' + str(module))
            sha = tree_hash(module)
            snapshot = objects / sha
            if not snapshot.exists():
                staging = Path(tempfile.mkdtemp(prefix='.snapshot-', dir=state))
                try:
                    copy_tree(module, staging / 'module')
                    if tree_hash(staging / 'module') != sha:
                        raise RuntimeError('Module changed during backup: ' + str(module))
                    os.replace(staging / 'module', snapshot)
                finally:
                    shutil.rmtree(staging)
            elif tree_hash(snapshot) != sha:
                raise RuntimeError('Existing snapshot is damaged: ' + str(module))
            manifest = json.loads((module / 'companion/manifest.json').read_text())
            current[str(module)] = {'sha256': sha, 'id': manifest['id'], 'version': manifest.get('version')}
    # SQLite's backup API includes committed WAL data without writing the source.
    databases = []
    settings = state / 'settings'
    settings.mkdir(exist_ok=True, mode=0o700)
    for database in sorted(data.glob('v*/db.sqlite')):
        destination = settings / (database.parent.name + '-' + str(time.time_ns()) + '.sqlite')
        try:
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10)) as source:
                with closing(sqlite3.connect(destination)) as backup:
                    source.backup(backup)
                    backup.execute('PRAGMA journal_mode=DELETE').fetchall()
                    if backup.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                        raise RuntimeError('Settings snapshot failed integrity check')
            destination.chmod(0o600)
            sha = hashlib.sha256(destination.read_bytes()).hexdigest()
            saved = settings / (database.parent.name + '-' + sha + '.sqlite')
            if saved.exists():
                if hashlib.sha256(saved.read_bytes()).hexdigest() != sha:
                    raise RuntimeError('Existing settings snapshot is damaged')
                destination.unlink()
            else:
                os.replace(destination, saved)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        finally:
            # Some SQLite builds retain a temporary shared-memory sidecar even
            # after switching this private backup to DELETE journaling.
            for suffix in ['-wal', '-shm']:
                Path(str(destination) + suffix).unlink(missing_ok=True)
        databases.append(str(saved))
    atomic_json(manifest_file, current)
    atomic_json(state / 'status.json', {'state': 'ready', 'at': time.time(), 'module_count': len(current),
                                       'restored': restored, 'settings_snapshots': databases})
    print(f'Module protection: {len(current)} installations secured; {len(restored)} restored; {len(databases)} settings snapshots')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dev-dir', type=Path, default=Path('/opt/companion-module-dev'))
    parser.add_argument('--data-dir', type=Path, default=Path('/home/companion/.config/companion-nodejs'))
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/jms-companion-modules'))
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state_dir / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            ensure([args.dev_dir, args.data_dir / 'modules'], args.data_dir, args.state_dir)
        except Exception as error:
            atomic_json(args.state_dir / 'status.json', {'state': 'blocked', 'error': str(error), 'at': time.time()})
            raise
