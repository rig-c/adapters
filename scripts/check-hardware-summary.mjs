/** Run copied-receipt negative controls without modifying captured evidence. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(process.argv[2] ?? 'test-results/hardware-bench/mac');
const output = resolve(process.argv[3] ?? 'test-results/hardware-bench/summary-controls');
const phases = ['AA1', 'AA2', 'AB1', 'AB2'];
if (phases.some(phase => !existsSync(resolve(source, `${phase}.json`)))) {
  console.log('SKIP: hardware summary controls need all four captured receipts');
  process.exit(77);
}
if (existsSync(output)) throw Error('HARDWARE_CONTROL_OUTPUT_EXISTS: choose a fresh output directory');
mkdirSync(output, { recursive: true });
const controls = [
  { name: 'failed-half', code: 'HARDWARE_SUMMARY_ROW', mutate: report => { report.rows[0].halves[0].pass = false; } },
  { name: 'empty-correctness', code: 'HARDWARE_SUMMARY_CONTROLS', mutate: report => { report.checks.spineboy = []; } },
];
const results = [];
for (const control of controls) {
  const directory = resolve(output, control.name);
  mkdirSync(directory);
  for (const phase of phases) copyFileSync(resolve(source, `${phase}.json`), resolve(directory, `${phase}.json`));
  const file = resolve(directory, 'AB2.json');
  const report = JSON.parse(readFileSync(file, 'utf8'));
  control.mutate(report);
  writeFileSync(file, JSON.stringify(report));
  const command = ['scripts/summarize-hardware-bench.mjs', directory];
  const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
  const record = { name: control.name, command: ['bun', ...command], exitCode: result.status, expectedCode: control.code, stdout: result.stdout, stderr: result.stderr };
  results.push(record);
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  if (result.status !== 1 || !result.stderr.includes(control.code)) throw Error(`HARDWARE_CONTROL_SURVIVED: ${control.name}`);
  console.log('HARDWARE_SUMMARY_MUTANT', control.name, 'exit', result.status, control.code);
}
