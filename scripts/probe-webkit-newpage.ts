import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, type FullConfig } from '@playwright/test';
import { webkitPageDeadline } from './webkit-page-deadline.ts';

interface PackageRecord { name: string; version: string }
interface BrowserRecord { name: string; revision: string; browserVersion: string; revisionOverrides?: Record<string, string> }

export function requireWebKitRevision(executable: string, metadata: BrowserRecord | undefined): void {
  if (!metadata || ![metadata.revision, ...Object.values(metadata.revisionOverrides ?? {})]
    .some(revision => basename(dirname(executable)) === `webkit-${revision}`)) {
    throw new Error('POOL_WEBKIT_PROVENANCE: executable revision absent from resolved package metadata');
  }
}

function recordProvenance(): void {
  const require = createRequire(import.meta.url);
  const testPath = require.resolve('@playwright/test/package.json');
  const playwrightPath = createRequire(testPath).resolve('playwright/package.json');
  const corePath = createRequire(playwrightPath).resolve('playwright-core/package.json');
  const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  const packages = [testPath, playwrightPath, corePath].map(path => ({
    ...JSON.parse(readFileSync(path, 'utf8')) as PackageRecord,
    path: realpathSync(path), sha256: sha256(path),
  })).map(({ name, version, path, sha256 }) => ({ name, version, path, sha256 }));
  const metadataPath = join(dirname(corePath), 'browsers.json');
  const metadata = (JSON.parse(readFileSync(metadataPath, 'utf8')) as { browsers: BrowserRecord[] })
    .browsers.find(browser => browser.name === 'webkit');
  const executable = webkit.executablePath();
  console.log('[webkit-provenance]', JSON.stringify({ packages, metadata, metadataSha256: sha256(metadataPath),
    executable, executableSha256: sha256(executable),
    wpeBinarySha256: process.platform === 'linux'
      ? sha256(join(dirname(executable), 'minibrowser-wpe/bin/MiniBrowser')) : null }));
  // Print the resolved chain, rather than assuming a hoisted node_modules layout.
  // Revision metadata is reported separately from the browser's runtime version.
  requireWebKitRevision(executable, metadata);
}

// Also used as the pool configuration's global setup, before test fixtures run.
export default async function checkWebKitPage(config?: FullConfig): Promise<void> {
  recordProvenance();
  const options = config?.projects.find(project => project.name === 'webkit')?.use.launchOptions;
  const software = process.argv.includes('--software');
  const browser = await webkit.launch({
    ...options, headless: true, timeout: 10_000,
    ...(software ? { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' } } : {}),
  });
  console.log('[webkit-probe] launched', JSON.stringify({ runtimeBrowserVersion: browser.version() }));
  try {
    const context = await browser.newContext();
    let requests = 0;
    context.on('request', () => { requests++; });
    const start = performance.now();
    try {
      const page = await webkitPageDeadline(context.newPage());
      console.log('[webkit-probe]', JSON.stringify({ stage: 'newPage', elapsedMs: performance.now() - start,
        requests, url: page.url(), verdict: 'PASS' }));
    } catch (error) {
      console.error('[webkit-probe]', JSON.stringify({ stage: 'newPage', elapsedMs: performance.now() - start,
        requests, error: String(error), verdict: 'FAIL' }));
      throw error;
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWebKitPage().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
