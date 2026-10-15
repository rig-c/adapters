import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { publishable, root, run } from './workspaces.mjs';

run('bun', ['run', 'fetch-assets']);
for (const pkg of publishable()) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'adapters-install-smoke-')));
  let server;
  let browser;
  try {
    const packDir = join(temp, 'tarballs'); mkdirSync(packDir);
    const listing = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], { cwd: pkg.dir }))[0];
    const consumer = join(temp, 'consumer'); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'adapter-installed-smoke', private: true, type: 'module' }));
    const peers = Object.entries(pkg.peerDependencies).map(([name, version]) => `${name}@${version}`);
    console.log(run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(packDir, listing.filename), ...peers], { cwd: consumer }));
    const graph = run('npm', ['ls', '--all', '--json'], { cwd: consumer });
    assert(!/@esotericsoftware|spine-core/.test(graph), `INSTALL_RUNTIME: ${pkg.name} dependency tree contains prohibited runtime`);
    console.log(`[bar4:installed-tree] ${pkg.name}: prohibited runtime (empty); PASS`);
    mkdirSync(join(consumer, 'public/rigs'), { recursive: true });
    cpSync(join(root, 'public/rigs/walk'), join(consumer, 'public/rigs/walk'), { recursive: true });
    cpSync(join(pkg.dir, 'smoke.ts'), join(consumer, 'smoke.ts'));
    const runtimeKeys = Object.keys(pkg.exports).filter((key) => !key.includes('*'));
    const namespaces = runtimeKeys.map((key, i) => `import * as api${i} from ${JSON.stringify(key === '.' ? pkg.name : pkg.name + key.slice(1))};`).join('\n');
    // Compare every runtime name with the built entry, not a second hand-kept list.
    writeFileSync(join(consumer, 'main.ts'), `${namespaces}\nimport { loadModel } from '@rig-c/play';\nimport { smoke } from './smoke.ts';\nconst namespaces = [${runtimeKeys.map((_, i) => `api${i}`).join(',')}];\nwindow.smokeResult = (async () => { const exported = namespaces.map((api) => Object.keys(api).sort()); if (exported.some((names) => names.length === 0)) throw new Error('INSTALL_EXPORTS: empty public entry'); const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' }); const pixels = await smoke(assets); return { exported, pixels }; })().catch((error) => ({ error: String(error) }));\n`);
    writeFileSync(join(consumer, 'index.html'), '<!doctype html><script type="module" src="/main.ts"></script>');
    // Type-only import all declared names: use the shipped declaration's own AST.
    const ts = await import('typescript');
    const declaration = readFileSync(join(pkg.dir, 'dist/index.d.ts'), 'utf8');
    const ast = ts.createSourceFile('index.d.ts', declaration, ts.ScriptTarget.Latest, true);
    const names = [];
    for (const statement of ast.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) names.push(element.name.text);
    }
    assert(names.length > 0, `INSTALL_TYPES: ${pkg.name} declarations expose no names`);
    // Referencing all imports is sufficient to force their resolution, including type-only exports.
    writeFileSync(join(consumer, 'type-smoke.ts'), `import type { ${names.join(', ')} } from '${pkg.name}';\n`);
    run('bun', [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', '--lib', 'ES2022,DOM', 'type-smoke.ts'], { cwd: consumer });
    server = await createServer({ configFile: false, root: consumer, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => window.smokeResult !== undefined);
    const result = await page.evaluate(() => window.smokeResult);
    assert(!result.error, result.error);
    assert(result.pixels > 0);
    console.log(`[bar3:installed-smoke] ${pkg.name}: entries=${runtimeKeys.join(',')}, runtime exports=${JSON.stringify(result.exported)}, declared names=${names.length}, walk@0.5s pixels=${result.pixels}; PASS`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
