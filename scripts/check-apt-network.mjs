import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Optional apt-config CLI options are for isolated comparator fixtures. CI uses
// no options, so it checks the actual configuration install-deps will consume.
const result = spawnSync('apt-config', [
  ...process.argv.slice(2),
  'shell',
  'CI_APT_RETRIES', 'Acquire::Retries',
  'CI_APT_HTTP_TIMEOUT', 'Acquire::http::Timeout',
  'CI_APT_HTTPS_TIMEOUT', 'Acquire::https::Timeout',
], { encoding: 'utf8' });
assert(!result.error && result.status === 0, `CI_APT_CONFIG_READ: ${result.error?.message ?? result.stderr}`);
console.log(result.stdout.trim());
const observed = new Set(result.stdout.trim().split(/\r?\n/));
for (const [key, expected] of [
  ['CI_APT_RETRIES', '3'],
  ['CI_APT_HTTP_TIMEOUT', '30'],
  ['CI_APT_HTTPS_TIMEOUT', '30'],
]) {
  assert(observed.has(`${key}='${expected}'`), `CI_APT_NETWORK_BOUNDS: ${key} expected ${expected}; found ${result.stdout.trim()}`);
}
console.log('[ci:apt-network] effective retries=3, HTTP timeout=30s, HTTPS timeout=30s; PASS');
