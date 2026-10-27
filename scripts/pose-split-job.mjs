// Admitted initial-premise job. Keep receipts outside the worktree.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './workspaces.mjs';

const packet = resolve(process.env.BENCH_PACKET_DIR ?? resolve(root, '../evidence/pose-split'));
if (packet === root || packet.startsWith(`${root}/`)) throw new Error('BENCH_PACKET_DIR must be outside the repository');
for (const directory of ['tmp', 'bun-cache', 'npm-cache', 'job-logs']) mkdirSync(resolve(packet, directory), { recursive: true });
const env = { ...process.env, TMPDIR: resolve(packet, 'tmp'), BUN_INSTALL_CACHE_DIR: resolve(packet, 'bun-cache'),
  npm_config_cache: resolve(packet, 'npm-cache'), npm_config_update_notifier: 'false',
  NODE_OPTIONS: '--max-old-space-size=4096' };
const steps = [
  ['install', 'bun', ['install', '--frozen-lockfile', '--ignore-scripts', '--backend', 'copyfile', '--network-concurrency', '4']],
  ['oracle', 'bun', ['scripts/prepare-oracle.mjs']],
  ['fixtures', 'bash', ['scripts/fetch-assets.sh']],
  ['disk-reader', 'bun', ['-e', "import {verifyBenchDiskAssets} from './scripts/bench.mjs'; console.log(JSON.stringify(verifyBenchDiskAssets('public/bench', ['spineboy','raptor'])));" ]],
  ['controls', 'bun', ['test', 'bench/pose-split.test.mjs']],
  ['measurement', 'bun', ['run', 'bench', '--pose-split', '--json', '--instances', '100', '--skeletons', 'spineboy,raptor', '--runs', '7']],
];
for (const [name, command, args] of steps) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(resolve(packet, 'job-logs', `${name}.stdout`), stdout);
  writeFileSync(resolve(packet, 'job-logs', `${name}.stderr`), stderr);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const receipt = { name, command: [command, ...args], startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: digest(stdout), stderrBytes: Buffer.byteLength(stderr), stderrSha256: digest(stderr) };
  appendFileSync(resolve(packet, 'steps.jsonl'), `${JSON.stringify(receipt)}\n`);
  console.log(`${name}: exit ${result.status}; stdout ${receipt.stdoutBytes} bytes; stderr ${receipt.stderrBytes} bytes`);
  if (result.status !== 0 || result.error) {
    console.error(stderr.slice(-6000));
    process.exit(result.status ?? 1);
  }
}
const report = JSON.parse(readFileSync(resolve(packet, 'job-logs/measurement.stdout'), 'utf8'));
const summary = report.rows.map(row => ({ skeleton: row.skeleton, run: row.run, poserCounts: row.poserCounts,
  totals: row.totals, snapshotShare: row.snapshotShare, shareAfterWholeClockControl: row.shareAfterWholeClockControl, verdict: row.verdict }));
console.log(JSON.stringify({ mode: report.mode, playVersion: report.playVersion, rows: summary }, null, 2));
