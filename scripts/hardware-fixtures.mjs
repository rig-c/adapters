/** The complete public workload, shared by the receiving client and receipt reader. */
const skeletons = ['spineboy', 'raptor'];
const roles = name => ({
  spineJson: `${name}-pro.json`, spineAtlas: `${name}.atlas`, atlasPng: `${name}.png`,
  license: 'license.txt', ingestedRig: 'rig.json', ingestedMotion: 'motion.json',
  builtModel: 'skeleton.model.json', builtSpineJson: 'skeleton.json', builtSpineAtlas: 'skeleton.atlas',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function fixtureEntries(assets, code = 'HARDWARE_FIXTURE_MANIFEST') {
  if (!sameKeys(assets?.skeletons, skeletons)) throw Error(`${code}: skeletons need exactly spineboy and raptor`);
  return skeletons.flatMap(name => {
    const files = assets.skeletons[name]?.files;
    const paths = roles(name);
    if (!sameKeys(files, Object.keys(paths))) throw Error(`${code}: ${name} needs every declared fixture role`);
    return Object.entries(paths).map(([role, file]) => {
      const expected = files[role];
      const path = `${name}/${file}`;
      if (!record(expected) || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) {
        throw Error(`${code}: ${path} needs SHA-256 and a positive byte length`);
      }
      return { path, sha256: expected.sha256, bytes: expected.bytes };
    });
  });
}

export function assertFixtureMeasurements(assets, measured, phase) {
  const code = 'HARDWARE_SUMMARY_FIXTURES';
  const entries = fixtureEntries(assets, code);
  for (const entry of entries) {
    const found = measured?.[entry.path];
    if (!record(found) || found.sha256 !== entry.sha256 || found.bytes !== entry.bytes) {
      throw Error(`${code}: ${phase} ${entry.path} found ${found?.sha256 ?? 'missing'}/${found?.bytes ?? 'missing'}; needed ${entry.sha256}/${entry.bytes}`);
    }
  }
  if (!sameKeys(measured, entries.map(entry => entry.path))) throw Error(`${code}: ${phase} needs exactly the measured fixture paths`);
}

/** Fetch once, digest the actual body, then keep immutable Blobs for every consumer. */
export async function verifyFixtureBytes(assets, measured) {
  const entries = fixtureEntries(assets);
  if (!globalThis.crypto?.subtle) throw Error('HARDWARE_FIXTURE_CRYPTO: SubtleCrypto SHA-256 required before loading fixtures');
  const blobs = new Map();
  const urls = new Map();
  for (const entry of entries) {
    const url = new URL(`/bench/${entry.path}`, location.href);
    let response;
    try { response = await fetch(url, { cache: 'no-store' }); }
    catch { throw Error(`HARDWARE_FIXTURE_FETCH: ${entry.path} network failure; needed ${entry.sha256}`); }
    if (!response.ok) throw Error(`HARDWARE_FIXTURE_FETCH: ${entry.path} HTTP ${response.status}; needed ${entry.sha256}`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    measured[entry.path] = { sha256, bytes: bytes.byteLength };
    if (sha256 !== entry.sha256 || bytes.byteLength !== entry.bytes) {
      throw Error(`HARDWARE_FIXTURE_MISMATCH: ${entry.path} found ${sha256}/${bytes.byteLength}; needed ${entry.sha256}/${entry.bytes}`);
    }
    blobs.set(url.href, new Blob([bytes], { type: entry.path.endsWith('.png') ? 'image/png' : 'text/plain' }));
  }
  const lookup = input => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    url.search = ''; url.hash = '';
    const blob = blobs.get(url.href);
    if (!blob) throw Error(`HARDWARE_FIXTURE_UNVERIFIED: ${url.pathname} has no verified bytes`);
    return { key: url.href, blob };
  };
  return {
    fetch: async (input, init) => {
      if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') throw Error('HARDWARE_FIXTURE_METHOD: verified fixtures require GET');
      return new Response(lookup(input).blob);
    },
    imageUrl: input => {
      const { key, blob } = lookup(input);
      if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
      return urls.get(key);
    },
    dispose: () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); blobs.clear(); },
  };
}
