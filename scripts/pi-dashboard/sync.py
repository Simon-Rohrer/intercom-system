#!/usr/bin/env python3
"""Keep Homepage Pi metrics aligned with authenticated Kesher heartbeats (read-only DB)."""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import tempfile
import time
import urllib.request
import yaml

ROOT = Path('/var/lib/jms-pi-dashboard')
DB = Path('/var/lib/docker/volumes/compose_intercom_data/_data/intercom.db')
SERVICES = Path('/opt/homelab/config/homepage/services.yaml')
MAPPING = Path('/etc/jms-pi-dashboard.json')
MAX_AGE_MS = 120_000


def field(node, name):
    if isinstance(node, yaml.MappingNode):
        return next((v for k, v in node.value if k.value == name), None)
    return None


def replacements(source, mappings, heartbeats, now_ms):
    """Only mapped Glances URL scalars change; comments, unrelated cards and formatting survive."""
    root = yaml.compose(source)
    if not isinstance(root, yaml.SequenceNode):
        raise ValueError('Expected Homepage services list')
    edits = []
    targets = set()
    for mapping in mappings:
        key = (mapping['group'], mapping['station'])
        if key in targets:
            raise ValueError('Duplicate dashboard mapping')
        targets.add(key)
        row = heartbeats.get(mapping['deviceId'])
        if not row or not 0 <= now_ms - row['last_seen'] <= MAX_AGE_MS:
            continue
        try:
            ip = ipaddress.IPv4Address(row['ip_address'])
        except ipaddress.AddressValueError:
            continue
        if not any(ip in ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
            continue
        matches = []
        for group in root.value:
            stations = field(group, mapping['group'])
            if not isinstance(stations, yaml.SequenceNode):
                continue
            for station in stations.value:
                cards = field(station, mapping['station'])
                if isinstance(cards, yaml.SequenceNode):
                    matches.append(cards)
        if len(matches) != 1:
            raise ValueError('Mapped dashboard station missing or ambiguous: ' + mapping['station'])
        for card in matches[0].value:
            if not isinstance(card, yaml.MappingNode):
                continue
            for _, details in card.value:
                widget = field(details, 'widget')
                kind, url = field(widget, 'type'), field(widget, 'url')
                if kind is None or kind.value != 'glances' or not isinstance(url, yaml.ScalarNode):
                    continue
                expected = f'http://{ip}:61208'
                if url.value != expected:
                    edits.append((url.start_mark.index, url.end_mark.index, expected))
    result = source
    for start, end, value in sorted(edits, reverse=True):
        result = result[:start] + value + result[end:]
    yaml.safe_load(result)
    return result, len(edits)


def read_heartbeats(path):
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)) as db:
        db.execute('PRAGMA query_only = ON')
        db.row_factory = sqlite3.Row
        return {r['device_id']: dict(r) for r in db.execute(
            'SELECT device_id, ip_address, last_seen FROM raspberry_pi_heartbeats')}


def install(path, before, after, state):
    if before == after:
        return False
    if path.is_symlink():
        raise ValueError('Refusing symlink configuration')
    meta = path.stat()
    backup = state / ('services.' + hashlib.sha256(before).hexdigest() + '.yaml')
    if not backup.exists():
        with backup.open('xb') as f:
            os.chmod(backup, 0o600)
            f.write(before)
    fd, name = tempfile.mkstemp(prefix='.jms-pi-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), meta.st_mode & 0o777)
            os.fchown(f.fileno(), meta.st_uid, meta.st_gid)
            f.write(after)
            f.flush()
            os.fsync(f.fileno())
        if path.read_bytes() != before:
            raise RuntimeError('Configuration changed concurrently; retry next run')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = SERVICES.read_bytes()
        after, count = replacements(before.decode(), json.loads(MAPPING.read_text()), read_heartbeats(DB), int(time.time() * 1000))
        if count:
            # Validate changed targets before persisting, without using environment HTTP proxies.
            old = yaml.safe_load(before)
            new = yaml.safe_load(after)
            def urls(v):
                if isinstance(v, dict):
                    if v.get('type') == 'glances' and 'url' in v:
                        yield v['url']
                    for x in v.values():
                        yield from urls(x)
                elif isinstance(v, list):
                    for x in v:
                        yield from urls(x)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for url in set(urls(new)) - set(urls(old)):
                with opener.open(url + '/api/4/cpu', timeout=4) as response:
                    payload = json.load(response)
                    if not isinstance(payload, dict) or 'total' not in payload or 'cpucore' not in payload:
                        raise ValueError('Unexpected Glances response')
            if not args.check:
                install(SERVICES, before, after.encode(), ROOT)
            print(f'Pi dashboard: {count} widget URLs ' + ('would be updated' if args.check else 'updated'), flush=True)
        else:
            print('Pi dashboard: no address changes', flush=True)


if __name__ == '__main__':
    main()
