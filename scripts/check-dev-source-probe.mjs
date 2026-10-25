import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { closeDevServer, withinDeadline } from './dev-source-probe.mjs';

if (process.argv[2] === '--held-child') {
  const fixture = process.argv[3];
  const unbounded = process.argv.includes('--plant-unbounded-close');
  let started;
  const optimizerStarted = new Promise((resolve) => { started = resolve; });
  const heldBuild = new Promise(() => {});
  try {
    const server = await createServer({
      root: fixture,
      configFile: false,
      cacheDir: join(fixture, '.cache'),
      logLevel: 'silent',
      optimizeDeps: {
        noDiscovery: true,
        include: ['held-dep'],
        esbuildOptions: {
          plugins: [{
            name: 'held-optimizer-plant',
            setup(build) {
              build.onStart(() => {
                started();
                return heldBuild;
              });
            },
          }],
        },
      },
      // Keep the real pending optimizer promise in the close lifecycle too.
      // This makes the adverse case deterministic rather than racing cancellation.
      plugins: [{ name: 'optimizer-held-across-close', closeBundle: () => heldBuild }],
      server: { host: '127.0.0.1', port: 0 },
    });
    const listening = server.listen();
    listening.catch((error) => console.error(`DEV_OPTIMIZER_PLANT_LISTEN: ${error.message}`));
    await withinDeadline(optimizerStarted, 10000, 'DEV_OPTIMIZER_PLANT_NOT_STARTED');
    console.log('DEV_OPTIMIZER_PLANT_STARTED: real esbuild optimizer held across close');
    if (unbounded) await server.close();
    else await closeDevServer(server, 1000);
    console.error('DEV_OPTIMIZER_PLANT_SURVIVED: held build unexpectedly closed');
    process.exit(2);
  } catch (error) {
    console.error(error.message);
    // This is an intentionally failed isolated child with a held native build.
    // The parent also reaps its entire process group before removing its fixture.
    process.exit(error.message.startsWith('DEV_OPTIMIZER_CLOSE_TIMEOUT:') ? 1 : 2);
  }
} else {
  const fixture = mkdtempSync(join(tmpdir(), 'adapters-held-optimizer-'));
  let result;
  try {
    const dependency = join(fixture, 'node_modules/held-dep');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'held-dep', version: '1.0.0', type: 'module', main: 'index.js' }));
    writeFileSync(join(dependency, 'index.js'), 'export const held = true;\n');
    writeFileSync(join(fixture, 'index.html'), '<script type="module">import { held } from "held-dep"; console.log(held);</script>');
    const args = [fileURLToPath(import.meta.url), '--held-child', fixture];
    if (process.argv.includes('--plant-unbounded-close')) args.push('--plant-unbounded-close');
    result = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', detached: true,
    });
    assert(!result.error, `DEV_OPTIMIZER_PLANT_HUNG: outer child limit is not the named close failure (${result.error?.code})`);
    assert.equal(result.status, 1, `DEV_OPTIMIZER_PLANT_EXIT: expected named failure, got ${result.status}; ${result.stderr}`);
    assert(result.stdout.includes('DEV_OPTIMIZER_PLANT_STARTED:'), 'DEV_OPTIMIZER_PLANT_ABSENT: actual optimizer never entered the held state');
    assert(result.stderr.includes('DEV_OPTIMIZER_CLOSE_TIMEOUT:'), `DEV_OPTIMIZER_PLANT_WRONG_FAILURE: ${result.stderr}`);
    console.log('[development:optimizer-plant] real held optimizer rejected by DEV_OPTIMIZER_CLOSE_TIMEOUT; child exit 1; PASS');
  } finally {
    if (result?.pid) {
      try { process.kill(-result.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(fixture, { recursive: true, force: true });
  }
}
