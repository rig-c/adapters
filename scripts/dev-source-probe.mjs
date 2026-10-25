import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

export async function withinDeadline(operation, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${code}: exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function closeDevServer(server, milliseconds = 5000) {
  return withinDeadline(server.close(), milliseconds, 'DEV_OPTIMIZER_CLOSE_TIMEOUT');
}

async function readModule(url) {
  const controller = new AbortController();
  try {
    return await withinDeadline((async () => {
      const response = await fetch(url, { signal: controller.signal });
      assert(response.ok, `DEV_SOURCE_HTTP: module returned ${response.status}`);
      // Drain even the warm-up response: an unread body can retain its connection.
      return response.text();
    })(), 10000, 'DEV_SOURCE_READ_TIMEOUT');
  } finally {
    controller.abort();
  }
}

export async function checkDevSource(fixture) {
  const previousCwd = process.cwd();
  let dev;
  try {
    process.chdir(fixture);
    dev = await withinDeadline(createServer({
      root: fixture,
      configFile: join(fixture, 'vite.config.ts'),
      logLevel: 'error',
      // This probe reads transformed source; it does not render dependency bundles.
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 },
    }), 10000, 'DEV_SOURCE_START_TIMEOUT');
    assert(dev.config.optimizeDeps.noDiscovery && dev.config.optimizeDeps.include.length === 0, 'DEV_SOURCE_OPTIMIZER: source-only probe must not prebundle dependencies');
    await withinDeadline(dev.listen(), 10000, 'DEV_SOURCE_START_TIMEOUT');
    const port = dev.httpServer.address().port;
    const main = await readModule(`http://127.0.0.1:${port}/src/main.ts`);
    assert(main.includes('/packages/pixi/src/index.ts'), 'DEV_SOURCE: demo must resolve the live Pixi source entry');
    const source = join(fixture, 'packages/pixi/src/pixi.ts');
    await readModule(`http://127.0.0.1:${port}/packages/pixi/src/pixi.ts`);
    writeFileSync(source, readFileSync(source, 'utf8') + '\nexport const DEV_REFRESH_PROBE = "fresh-source";\n');
    let refreshed = false;
    for (let attempt = 0; attempt < 20 && !refreshed; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      const text = await readModule(`http://127.0.0.1:${port}/packages/pixi/src/pixi.ts`);
      refreshed = text.includes('DEV_REFRESH_PROBE');
    }
    assert(refreshed, 'DEV_REFRESH: source edit was not reflected without library rebuild');
    console.log('[development:source] clean dev resolves source entry and source edit refreshes transformed module without package rebuild; PASS');
  } finally {
    try {
      if (dev) await closeDevServer(dev);
    } finally {
      process.chdir(previousCwd);
    }
  }
}
