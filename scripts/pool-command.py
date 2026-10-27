#!/usr/bin/env python3
"""Four-CPU command admission with a 6 GiB process-tree RSS ceiling."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if sys.argv[1:] == ['--help']:
    print('python3 scripts/pool-command.py COMMAND [ARG ...]')
    raise SystemExit(0)
if not sys.argv[1:]:
    raise SystemExit('POOL_COMMAND: command required')
cpus = sorted(os.sched_getaffinity(0))[:4]
os.sched_setaffinity(0, cpus)
scratch = Path.cwd().parent / 'scratch'
scratch.mkdir(exist_ok=True)
os.environ.update(TMPDIR=str(scratch), UV_THREADPOOL_SIZE='4', GOMAXPROCS='4',
                  NODE_OPTIONS='--max-old-space-size=2048', BUN_CONFIG_MAX_HTTP_REQUESTS='4')
child = subprocess.Popen(sys.argv[1:], start_new_session=True)
peak = 0
try:
    while child.poll() is None:
        rows = {}
        for p in Path('/proc').glob('[0-9]*/stat'):
            try:
                f = p.read_text().rsplit(')', 1)[1].split()
                rows[int(p.parent.name)] = (int(f[1]), int(f[21]) * os.sysconf('SC_PAGE_SIZE'))
            except (OSError, IndexError, ValueError):
                pass
        chosen = {child.pid}
        while True:
            more = {pid for pid, (parent, _) in rows.items() if parent in chosen}
            if more <= chosen:
                break
            chosen |= more
        peak = max(peak, sum(rows[p][1] for p in chosen if p in rows))
        if peak > 6 * 1024 ** 3:
            os.killpg(child.pid, signal.SIGKILL)
            raise RuntimeError('POOL_RSS: 6 GiB process-tree budget exceeded')
        time.sleep(.1)
    code = child.wait()
    print('POOL_BUDGET', json.dumps({'cpus': cpus, 'peakRssBytes': peak, 'exitCode': code}), flush=True)
    raise SystemExit(code)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait()
