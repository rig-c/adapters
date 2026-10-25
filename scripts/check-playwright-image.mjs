import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, webkit } from '@playwright/test';

const require = createRequire(import.meta.url);
const version = require('@playwright/test/package.json').version;
const image = process.env.PLAYWRIGHT_IMAGE;
const browsers = [chromium, webkit].map(browser => ({
  name: browser.name(), path: browser.executablePath(),
}));

function checkImage(reference, installedVersion, executables) {
  const match = /^mcr\.microsoft\.com\/playwright:v([^@]+)-noble@sha256:[a-f0-9]{64}$/.exec(reference ?? '');
  assert(match && match[1] === installedVersion,
    `CI_PLAYWRIGHT_IMAGE_VERSION: image ${reference}; installed ${installedVersion}`);
  for (const browser of executables) {
    try {
      accessSync(browser.path, constants.X_OK);
    } catch (error) {
      throw new Error(`CI_PLAYWRIGHT_IMAGE_BROWSER: ${browser.name} expected executable ${browser.path}; ${error.message}`);
    }
  }
}

checkImage(image, version, browsers);
console.log(`[ci:playwright-image] ${image}; installed=${version}`);
for (const browser of browsers) console.log(`[ci:playwright-image] ${browser.name}: ${browser.path}`);
assert.throws(() => checkImage(image, '0.0.0', browsers), /CI_PLAYWRIGHT_IMAGE_VERSION/);
for (const browser of browsers) {
  const planted = browsers.map(entry => entry.name === browser.name
    ? { ...entry, path: `${entry.path}.missing-browser-plant` } : entry);
  assert.throws(() => checkImage(image, version, planted), new RegExp(`CI_PLAYWRIGHT_IMAGE_BROWSER: ${browser.name}`));
}
console.log('[ci:playwright-image] bundled browsers executable; version and both missing-browser plants rejected; PASS');
