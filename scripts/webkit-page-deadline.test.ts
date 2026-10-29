import { expect, test } from 'bun:test';
import { webkitPageDeadline } from './webkit-page-deadline.ts';
import { requireWebKitRevision } from './probe-webkit-newpage.ts';

test('the provenance check rejects a mismatched or absent browser record', () => {
  const metadata = { name: 'webkit', revision: '2336', browserVersion: '26.5' };
  expect(() => requireWebKitRevision('browsers/webkit-2336/pw_run.sh', metadata)).not.toThrow();
  expect(() => requireWebKitRevision('browsers/webkit-0/pw_run.sh', metadata)).toThrow('POOL_WEBKIT_PROVENANCE');
  expect(() => requireWebKitRevision('browsers/webkit-2336/pw_run.sh', undefined)).toThrow('POOL_WEBKIT_PROVENANCE');
});

test('a stalled page is refused by name before the enclosing test timeout', async () => {
  await expect(webkitPageDeadline(new Promise<never>(() => {}), 20))
    .rejects.toThrow('POOL_WEBKIT_NEWPAGE: newPage did not resolve within 20 ms');
});

test('a browser rejection retains its cause under the same diagnostic', async () => {
  await expect(webkitPageDeadline(Promise.reject(new Error('planted browser disconnect')), 100))
    .rejects.toThrow('POOL_WEBKIT_NEWPAGE: planted browser disconnect');
});

test('a delayed success inside the deadline is accepted without a later rejection', async () => {
  const page = { url: 'about:blank' };
  const result = await webkitPageDeadline(new Promise<typeof page>(resolve => setTimeout(() => resolve(page), 10)), 100);
  expect(result).toBe(page);
  await new Promise(resolve => setTimeout(resolve, 110));
});
