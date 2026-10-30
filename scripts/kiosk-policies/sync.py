#!/usr/bin/env python3
"""Keep Chromium snap kiosk policies aligned with the root-owned system policy.
No browser restart, certificate import, network request or credential access.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

NAMES = ('jms-device.json', 'kesher-chat-kiosk.json')

def atomic_write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def validated_sources(source):
    data = {}
    for name in NAMES:
        content = (source / name).read_bytes()
        value = json.loads(content)
        if not isinstance(value, dict):
            raise ValueError('Policy must be an object: ' + name)
        if name == 'jms-device.json':
            rules = value.get('AutoSelectCertificateForUrls')
            if not isinstance(rules, list) or not rules:
                raise ValueError('Missing certificate-selection rules')
            for raw in rules:
                rule = json.loads(raw)
                if not isinstance(rule, dict) or not isinstance(rule.get('pattern'), str) or not rule['pattern'].startswith('https://') or not isinstance(rule.get('filter'), dict) or not rule['filter']:
                    raise ValueError('Invalid certificate-selection rule')
        if name == 'kesher-chat-kiosk.json':
            if not isinstance(value.get('CACertificates'), list) or not value['CACertificates']:
                raise ValueError('Missing kiosk CA policy')
        data[name] = content
    return data

def sync(source, snap, state):
    policies = validated_sources(source)  # Validate everything before any changes.
    snap = snap.resolve(strict=True)
    current = (snap / 'current').resolve(strict=True)
    if current.parent != snap or not re.fullmatch(r'[0-9]+', current.name) or not current.is_dir():
        raise ValueError('Unexpected Chromium current revision')
    revisions = sorted(p for p in snap.iterdir() if re.fullmatch(r'[0-9]+', p.name) and p.is_dir() and not p.is_symlink())
    targets = []
    for revision in revisions:
        folder = revision / 'policies' / 'managed'
        if not folder.resolve().is_relative_to(revision):
            raise ValueError('Policy directory points outside snap revision')
        for name, content in policies.items():
            target = folder / name
            if target.is_symlink():
                raise ValueError('Refusing symlink policy target')
            targets.append((target, content, revision.name))
    changed = []
    for target, content, revision in targets:
        previous = target.read_bytes() if target.exists() else None
        if previous == content:
            continue
        if previous is not None:
            digest = hashlib.sha256(previous).hexdigest()
            backup = state / 'backups' / revision / (target.name + '.' + digest)
            if not backup.exists():
                atomic_write(backup, previous, 0o600)
        atomic_write(target, content)
        changed.append(str(target))
    status = {'current_revision': current.name, 'revisions': [p.name for p in revisions],
              'source_sha256': {n: hashlib.sha256(d).hexdigest() for n,d in policies.items()}}
    status_bytes = (json.dumps(status, indent=2) + '\n').encode()
    status_path = state / 'status.json'
    if not status_path.exists() or status_path.read_bytes() != status_bytes:
        atomic_write(status_path, status_bytes, 0o600)
    return changed

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/etc/chromium/policies/managed'))
    parser.add_argument('--snap', type=Path, default=Path('/var/snap/chromium'))
    parser.add_argument('--state', type=Path, default=Path('/var/lib/jms-kiosk-policies'))
    args = parser.parse_args()
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        changed = sync(args.source, args.snap, args.state)
    if changed:
        print('Kiosk policies synchronized: ' + ', '.join(changed))

if __name__ == '__main__':
    main()
