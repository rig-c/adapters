import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { root, run } from './workspaces.mjs';

const sidecar = resolve(root, 'tests/oracle');
const installedWebgl = resolve(sidecar, 'node_modules/@esotericsoftware/spine-webgl/package.json');
const installedPixi = resolve(sidecar, 'node_modules/@esotericsoftware/spine-pixi-v8/package.json');
const lock = resolve(sidecar, 'package-lock.json');
const marker = resolve(sidecar, 'node_modules/.oracle-lock-sha256');
const digest = () => createHash('sha256').update(readFileSync(lock)).digest('hex');
if (process.argv.includes('--update-lock')) {
  console.log(run('npm', ['install', '--prefix', sidecar, '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund']));
} else {
  if (!existsSync(lock)) throw new Error('ORACLE_LOCK: tests/oracle/package-lock.json missing; generate through the guarded development runner --update-oracle-lock');
  if (!existsSync(installedWebgl) || !existsSync(installedPixi) || !existsSync(marker) || readFileSync(marker, 'utf8') !== digest()) {
    console.log(run('npm', ['ci', '--prefix', sidecar, '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund']));
  }
}
if (JSON.parse(readFileSync(installedWebgl, 'utf8')).version !== '4.3.13') throw new Error('ORACLE_VERSION: expected isolated spine-webgl 4.3.13');
if (JSON.parse(readFileSync(installedPixi, 'utf8')).version !== '4.3.13') throw new Error('ORACLE_VERSION: expected isolated spine-pixi-v8 4.3.13');
writeFileSync(marker, digest());
console.log('ORACLE_ISOLATION: frozen private non-workspace spine-webgl & spine-pixi-v8 4.3.13; lifecycle scripts disabled; no host dependency');
