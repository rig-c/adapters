#!/usr/bin/env python3
"""Run workspace verification on Nova with inherited CPU affinity and RSS rejection."""
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request

root = pathlib.Path.cwd()
out = root.parent / 'evidence' / 'adapters-verification'
out.mkdir(parents=True, exist_ok=True)
budget = {'rssLimitBytes': 4 * 1024 ** 3, 'sampleSeconds': 0.05, 'peakTreeRssBytes': 0, 'commands': []}
active = None


def persist():
    (out / 'budget.json').write_text(json.dumps(budget, indent=2))


def rss(group):
    table = {}
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            table[int(path.name)] = (int(fields[1]), int(fields[2]), int(fields[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
            pass
    chosen = {pid for pid, (_, pgid, _) in table.items() if pgid == group} | {os.getpid()}
    while True:
        more = {pid for pid, (parent, _, _) in table.items() if parent in chosen}
        if more <= chosen:
            break
        chosen |= more
    return sum(table[pid][2] for pid in chosen if pid in table)


def stop(signum, frame):
    if active is not None and active.poll() is None:
        os.killpg(active.pid, signal.SIGKILL)
        active.wait()
    raise RuntimeError(f'Verification interrupted: {signum}')


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def run(args, name):
    global active
    print('RUN', name, json.dumps(args), flush=True)
    peak = 0
    rejected = False
    with (out / (name + '.stdout')).open('wb') as stdout, (out / (name + '.stderr')).open('wb') as stderr:
        active = subprocess.Popen(args, cwd=root, stdout=stdout, stderr=stderr, start_new_session=True)
        while active.poll() is None:
            peak = max(peak, rss(active.pid))
            if peak > budget['rssLimitBytes']:
                rejected = True
                os.killpg(active.pid, signal.SIGKILL)
                break
            time.sleep(budget['sampleSeconds'])
        code = active.wait()
        active = None
    budget['commands'].append({'argv': args, 'exitCode': code, 'peakTreeRssBytes': peak, 'guardRejected': rejected, 'log': name})
    budget['peakTreeRssBytes'] = max(peak, budget['peakTreeRssBytes'])
    persist()
    if rejected or code != 0:
        if (root / 'test-results').is_dir():
            shutil.copytree(root / 'test-results', out / 'test-results', dirs_exist_ok=True)
        print((out / (name + '.stdout')).read_text()[-5000:], flush=True)
        print((out / (name + '.stderr')).read_text()[-5000:], flush=True)
        raise RuntimeError(f'{name}: exit {code}, guard rejected={rejected}')
    print(f'PASS {name}: exit 0, peak RSS {peak}', flush=True)


if not hasattr(os, 'sched_setaffinity') or not pathlib.Path('/proc').is_dir():
    raise RuntimeError('NOVA_BUDGET: Linux process-tree/affinity measurement required')
cpus = sorted(os.sched_getaffinity(0))[:4]
os.sched_setaffinity(0, set(cpus))
budget['cpuAffinity'] = cpus
os.environ.update(UV_THREADPOOL_SIZE='4', GOMAXPROCS='4', BUN_CONFIG_MAX_HTTP_REQUESTS='4', NODE_OPTIONS='--max-old-space-size=2048')
# Real Node/npm, not a Bun node alias. Pin the official distribution for installed-package checks.
node_version = '22.16.0'
tools = out / 'toolchain'
tools.mkdir(exist_ok=True)
archive = tools / 'node.tar.xz'
url = f'https://nodejs.org/dist/v{node_version}/node-v{node_version}-linux-x64.tar.xz'
with urllib.request.urlopen(url) as response, archive.open('wb') as target:
    shutil.copyfileobj(response, target)
checksums = urllib.request.urlopen(f'https://nodejs.org/dist/v{node_version}/SHASUMS256.txt').read().decode()
expected = next(line.split()[0] for line in checksums.splitlines() if line.endswith(archive.name.replace('node.tar.xz', f'node-v{node_version}-linux-x64.tar.xz')))
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected, 'NODE_CHECKSUM: official tarball hash differs'
with tarfile.open(archive) as bundle:
    bundle.extractall(tools, filter='data')
node_bin = tools / f'node-v{node_version}-linux-x64' / 'bin'
os.environ['PATH'] = str(node_bin) + os.pathsep + os.environ['PATH']
run(['node', '-e', "if(process.release.name!=='node'||process.versions.bun)throw Error('NODE_IDENTITY');console.log(JSON.stringify({execPath:process.execPath,versions:process.versions,options:process.env.NODE_OPTIONS}))"], 'node-runtime')
run(['npm', '--version'], 'npm-runtime')
original = root / 'bun.lock'
if original.exists():
    shutil.copyfile(original, out / 'bun.lock.before')
run(['bun', 'install', '--frozen-lockfile'] if '--update-lock' not in os.sys.argv else ['bun', 'install'], 'install')
shutil.copyfile(root / 'bun.lock', out / 'bun.lock')
if '--update-oracle-lock' in os.sys.argv:
    run(['bun', 'scripts/prepare-oracle.mjs', '--update-lock'], 'oracle-lock')
    shutil.copyfile(root / 'tests/oracle/package-lock.json', out / 'oracle-package-lock.json')
if '--prepare' not in os.sys.argv:
    focused = '--phaser-only' in os.sys.argv
    for script in ['build:libraries', 'typecheck', 'lint'] + ([] if focused else ['check:packages']):
        run(['bun', 'run', script], script.replace(':', '-'))
    run(['bunx', '--no-install', 'playwright', 'install', 'chromium', 'webkit'], 'browser-install')
    if not focused:
        run(['bun', 'run', 'check:release'], 'check-release')
        run(['bun', 'run', 'smoke'], 'installed-smoke')
    run(['bun', 'run', 'test'] + (['packages/phaser/tests'] if '--phaser-only' in os.sys.argv else []), 'parity-suite')
    if (root / 'test-results').is_dir():
        shutil.copytree(root / 'test-results', out / 'test-results', dirs_exist_ok=True)
    # Preserve the gated library artifacts for review; none are published.
    with tarfile.open(out / 'library-artifacts.tar.gz', 'w:gz') as bundle:
        for package in sorted((root / 'packages').iterdir()):
            if (package / 'dist').is_dir():
                bundle.add(package / 'dist', arcname=f'{package.name}/dist')
print('VERIFICATION: all requested commands exited 0; no npm publish executed', flush=True)
