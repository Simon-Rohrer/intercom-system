#!/usr/bin/python3
"""Run the installed Glances with one shared collection at a time.

Glances 4.3.1 REST handlers can enter their expired-cache refresh concurrently.
Seven dashboard cards then collect the same host seven times, corrupting rates
and wasting Pi CPU. Keep every plugin/API, but serialize the cache check+refresh.
The package itself is not modified, and updates without this hook run normally.
"""
from functools import wraps
import sys
import threading
import warnings


def serialize_updates(api_class):
    name = '_GlancesRestfulApi__update_stats'
    original = getattr(api_class, name, None)
    if not callable(original):
        warnings.warn('Glances collection hook changed; using installed default')
        return False
    lock = threading.RLock()
    @wraps(original)
    def update(self):
        with lock:
            return original(self)
    setattr(api_class, name, update)
    return True


if __name__ == '__main__':
    from glances.outputs.glances_restful_api import GlancesRestfulApi
    from glances import main
    serialize_updates(GlancesRestfulApi)
    sys.exit(main())
