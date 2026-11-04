import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../lib/config.mjs';
import { isRealDirectory, resolvePermanentLinkSource, runSidecarSetup } from '../lib/setup.mjs';
import {
  createAgyCssHandler,
  createAssetHandler,
  createShellClientHandler,
  createShellCssHandler,
} from '../lib/server.mjs';
import { sanitizeSidecarName, scaffoldSidecarProject } from '../lib/scaffolder.mjs';

describe('antigravity-sidecar-kit/setup, /server, and CLI scaffolder', () => {
  it('sanitizeSidecarName strips prefixes and stays fast on long runs of hyphens', () => {
    assert.equal(sanitizeSidecarName('antigravity-sidecar-my-tool'), 'my-tool');
    assert.equal(sanitizeSidecarName('antigravity-my-tool'), 'my-tool');
    assert.equal(sanitizeSidecarName('agy-my_tool--'), 'my_tool');
    const started = process.hrtime.bigint();
    assert.equal(sanitizeSidecarName(`${'-'.repeat(200_000)}a`), 'a');
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200, 'sanitizing took too long');
  });
  it('resolvePermanentLinkSource copies out of _npx and guarantees node_modules/antigravity-sidecar-kit in both nested and hoisted layouts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-npx-test-'));
    try {
      const packagesDir = join(dir, 'packages');

      // Case 1: Hoisted _npx layout (no nested node_modules inside repoRoot)
      const hoistedRepo = join(dir, '_npx', 'hash123', 'node_modules', 'antigravity-demo');
      mkdirSync(join(hoistedRepo, '.git'), { recursive: true });
      writeJsonNoBom(join(hoistedRepo, 'package.json'), {
        name: 'antigravity-demo',
        version: '1.2.3',
      });
      writeFileSync(join(hoistedRepo, 'server.mjs'), '// server', 'utf8');
      writeFileSync(join(hoistedRepo, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');

      const copiedHoisted = resolvePermanentLinkSource(hoistedRepo, {
        sidecarId: 'demo',
        packagesDir,
      });
      assert.ok(copiedHoisted.endsWith('demo@1.2.3'));
      assert.equal(existsSync(join(copiedHoisted, '.git')), false);
      assert.equal(existsSync(join(copiedHoisted, 'server.mjs')), true);
      assert.equal(
        existsSync(join(copiedHoisted, 'node_modules', 'antigravity-sidecar-kit', 'package.json')),
        true,
        'Should inject KIT_ROOT into destDir/node_modules/antigravity-sidecar-kit when hoisted'
      );

      // Case 2: Nested node_modules with both antigravity-sidecar-kit and an extraneous package
      const nestedRepo = join(dir, '_npx', 'hash456', 'node_modules', 'antigravity-nested');
      mkdirSync(join(nestedRepo, 'node_modules', 'antigravity-sidecar-kit', 'lib'), { recursive: true });
      mkdirSync(join(nestedRepo, 'node_modules', 'other-bloat-pkg'), { recursive: true });
      writeJsonNoBom(join(nestedRepo, 'package.json'), {
        name: 'antigravity-nested',
        version: '2.0.0',
        dependencies: { 'antigravity-sidecar-kit': '^1.0.0', 'other-bloat-pkg': '^1.0.0' },
      });
      writeJsonNoBom(join(nestedRepo, 'node_modules', 'antigravity-sidecar-kit', 'package.json'), {
        name: 'antigravity-sidecar-kit',
        version: '1.0.0',
      });
      writeFileSync(join(nestedRepo, 'node_modules', 'other-bloat-pkg', 'index.js'), '', 'utf8');

      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (msg) => warnings.push(String(msg));
      let copiedNested;
      try {
        copiedNested = resolvePermanentLinkSource(nestedRepo, {
          sidecarId: 'nested',
          packagesDir,
        });
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /missing at runtime: other-bloat-pkg$/);
      assert.equal(
        existsSync(join(copiedNested, 'node_modules', 'antigravity-sidecar-kit', 'package.json')),
        true
      );
      assert.equal(existsSync(join(copiedNested, 'node_modules', 'other-bloat-pkg')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runSidecarSetup links sidecar, preserves projectId on enable/uninstall, and scaffolds projects cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-setup-flow-'));
    try {
      const scaffoldDir = join(dir, 'my-custom-tool');
      const sc = scaffoldSidecarProject({ name: 'my-custom-tool', targetDir: scaffoldDir });
      assert.equal(sc.id, 'my-custom-tool');
      assert.equal(existsSync(join(scaffoldDir, 'sidecar.json')), true);
      assert.equal(existsSync(join(scaffoldDir, 'hub-manifest.json')), true);

      const globalSidecarsDir = join(dir, 'sidecars');
      const configJsonPath = join(dir, 'config.json');
      const packagesDir = join(dir, 'packages');
      // Keep the restart fallback away from the real ~/.gemini
      const rpcOptions = { lsAddress: '', csrfToken: '', sidecarDataRoot: join(dir, 'sidecar_data') };
      writeJsonNoBom(configJsonPath, {
        sidecars: {
          'my-custom-tool': {
            enabled: false,
            projectId: 'keep-this-project-id',
          },
        },
      });

      const setupRes = await runSidecarSetup({
        sidecarId: 'my-custom-tool',
        repoRoot: scaffoldDir,
        args: ['--skip-tests'],
        globalSidecarsDir,
        configJsonPath,
        packagesDir,
        rpcOptions,
        restartDelayMs: 0,
      });
      assert.equal(setupRes.uninstalled, false);
      assert.equal(existsSync(join(globalSidecarsDir, 'my-custom-tool', 'sidecar.json')), true);

      const cfgAfterSetup = readJsonSafe(configJsonPath, {});
      assert.equal(cfgAfterSetup.sidecars['my-custom-tool'].enabled, true);
      assert.equal(cfgAfterSetup.sidecars['my-custom-tool'].projectId, 'keep-this-project-id');

      // Leftover permanent copies from earlier npx installs are pruned on uninstall
      mkdirSync(join(packagesDir, 'my-custom-tool@0.9.0'), { recursive: true });
      mkdirSync(join(packagesDir, 'other-tool@1.0.0'), { recursive: true });

      const uninstRes = await runSidecarSetup({
        sidecarId: 'my-custom-tool',
        repoRoot: scaffoldDir,
        args: ['--uninstall'],
        globalSidecarsDir,
        configJsonPath,
        packagesDir,
        rpcOptions,
      });
      assert.equal(uninstRes.uninstalled, true);
      assert.equal(existsSync(join(globalSidecarsDir, 'my-custom-tool')), false);
      assert.equal(existsSync(join(packagesDir, 'my-custom-tool@0.9.0')), false);
      assert.equal(existsSync(join(packagesDir, 'other-tool@1.0.0')), true);
      assert.equal(existsSync(join(scaffoldDir, 'sidecar.json')), true);
      const cfgAfterUninst = readJsonSafe(configJsonPath, {});
      assert.equal(cfgAfterUninst.sidecars['my-custom-tool'].enabled, false);
      assert.equal(cfgAfterUninst.sidecars['my-custom-tool'].projectId, 'keep-this-project-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runSidecarSetup refuses to replace an in-place checkout unless --force is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-inplace-'));
    try {
      const globalSidecarsDir = join(dir, 'sidecars');
      const inPlace = join(globalSidecarsDir, 'foo');
      mkdirSync(join(inPlace, '.git'), { recursive: true });
      writeFileSync(join(inPlace, 'sidecar.json'), '{}', 'utf8');
      writeFileSync(join(inPlace, 'server.mjs'), '', 'utf8');
      writeFileSync(join(inPlace, 'UNCOMMITTED.txt'), 'precious', 'utf8');

      const npxRepo = join(dir, '_npx', 'abc', 'node_modules', 'antigravity-foo');
      mkdirSync(npxRepo, { recursive: true });
      writeJsonNoBom(join(npxRepo, 'package.json'), { name: 'antigravity-foo', version: '1.0.0' });
      writeFileSync(join(npxRepo, 'sidecar.json'), '{}', 'utf8');
      writeFileSync(join(npxRepo, 'server.mjs'), '', 'utf8');

      let hookRan = false;
      const common = {
        sidecarId: 'foo',
        globalSidecarsDir,
        configJsonPath: join(dir, 'config.json'),
        packagesDir: join(dir, 'packages'),
        rpcOptions: { lsAddress: '', csrfToken: '', sidecarDataRoot: join(dir, 'sidecar_data') },
        restartDelayMs: 0,
        onBeforeSetup: () => {
          hookRan = true;
        },
      };

      await assert.rejects(
        () => runSidecarSetup({ ...common, repoRoot: npxRepo, args: ['--skip-tests'] }),
        (err) => err.code === 'EINPLACECHECKOUT'
      );
      assert.equal(hookRan, false, 'nothing should run before the refusal');
      assert.equal(existsSync(join(dir, 'packages')), false, 'no npx copy before the refusal');
      assert.equal(readFileSync(join(inPlace, 'UNCOMMITTED.txt'), 'utf8'), 'precious');
      assert.equal(existsSync(join(inPlace, '.git')), true);

      // Running setup from inside the in-place checkout keeps it as-is
      const inside = await runSidecarSetup({ ...common, repoRoot: inPlace, args: ['--skip-tests'] });
      assert.equal(inside.uninstalled, false);
      assert.equal(isRealDirectory(inPlace), true);
      assert.equal(existsSync(join(inPlace, 'UNCOMMITTED.txt')), true);

      // Uninstalling from elsewhere does not delete it either
      await runSidecarSetup({ ...common, repoRoot: npxRepo, args: ['--uninstall'] });
      assert.equal(existsSync(join(inPlace, 'UNCOMMITTED.txt')), true);

      // --force replaces it with a link to the permanent copy
      const forced = await runSidecarSetup({ ...common, repoRoot: npxRepo, args: ['--skip-tests', '--force'] });
      assert.equal(isRealDirectory(inPlace), false);
      assert.equal(realpathSync(inPlace), forced.linkedTo);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createAssetHandler injects UI token into local HTML asset links and createAgyCssHandler serves CSS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-server-test-'));
    try {
      writeFileSync(
        join(dir, 'index.html'),
        '<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>' +
          '<script src="//cdn.example.com/lib.js"></script><a href="/docs#intro">docs</a>' +
          '<a href="https://example.com/x">ext</a><img data-src="/lazy.png">',
        'utf8'
      );
      const handler = createAssetHandler(dir, 'index.html', 'text/html; charset=utf-8', {
        uiToken: 'sec-123',
        bootTs: 999,
      });
      const res = handler();
      assert.equal(res.contentType, 'text/html; charset=utf-8');
      assert.match(res.body, /href="\/styles\.css\?token=sec-123&v=999"/);
      assert.match(res.body, /src="\/app\.js\?token=sec-123&v=999"/);
      // The token must never reach another origin
      assert.match(res.body, /src="\/\/cdn\.example\.com\/lib\.js"/);
      assert.match(res.body, /href="https:\/\/example\.com\/x"/);
      // Query goes before the fragment so the token is actually sent
      assert.match(res.body, /href="\/docs\?token=sec-123&v=999#intro"/);
      assert.match(res.body, /data-src="\/lazy\.png"/);

      const cssHandler = createAgyCssHandler({ lsAddress: '' });
      const cssRes = await cssHandler();
      assert.equal(cssRes.contentType, 'text/css; charset=utf-8');

      // Conversation ID injection + AGY shell handlers
      const convRes = handler({ conversationId: 'conv-xyz' });
      assert.match(convRes.body, /href="\/styles\.css\?token=sec-123&v=999&conversationId=conv-xyz"/);

      const shellRes = createShellCssHandler()();
      assert.equal(shellRes.contentType, 'text/css; charset=utf-8');
      assert.match(shellRes.body, /--agy-ink-soft/);
      assert.match(shellRes.body, /@media \(forced-colors: active\)/);

      const clientRes = createShellClientHandler()();
      assert.equal(clientRes.contentType, 'text/javascript; charset=utf-8');
      assert.match(clientRes.body, /agy\.theme\.v1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createAssetHandler blocks symlink escapes, hardlinks, and traversal outside uiDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-asset-sec-'));
    try {
      const uiDir = join(dir, 'ui');
      mkdirSync(uiDir, { recursive: true });
      const outsidePath = join(dir, 'outside.js');
      writeFileSync(outsidePath, 'secret()', 'utf8');
      writeFileSync(join(uiDir, 'ok.js'), 'ok()', 'utf8');

      const handlers = createAssetHandler(uiDir, {
        '/escape.js': ['../outside.js', 'text/javascript'],
        '/ok.js': ['ok.js', 'text/javascript'],
      });
      const resEscape = handlers['/escape.js']();
      assert.equal(resEscape.status, 403);

      const resOk = handlers['/ok.js']();
      assert.equal(resOk.status, 200);

      // Hardlink check (nlink > 1)
      const hardlinkPath = join(uiDir, 'hardlink.js');
      linkSync(outsidePath, hardlinkPath);
      const hardlinkHandler = createAssetHandler(uiDir, 'hardlink.js', 'text/javascript');
      assert.equal(hardlinkHandler().status, 403);

      // Symlink check (when OS allows creating file symlinks)
      const symlinkPath = join(uiDir, 'symlink.js');
      let symlinkCreated = false;
      try {
        symlinkSync(outsidePath, symlinkPath);
        symlinkCreated = true;
      } catch {
        // Unprivileged Windows without Developer Mode may disallow file symlinks
      }
      if (symlinkCreated) {
        const symlinkHandler = createAssetHandler(uiDir, 'symlink.js', 'text/javascript');
        assert.equal(symlinkHandler().status, 403);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setupSidecarServer wires asset routes, shell/ui routes, StateSync, and forwards server options (F-08, XREPO-02)', async () => {
    const srvMod = await import('../lib/server.mjs');
    assert.equal(typeof srvMod.setupSidecarServer, 'function');
    const dir = mkdtempSync(join(tmpdir(), 'kit-turnkey-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html><body>ok</body></html>', 'utf8');
      const pages = new Map();
      const apis = new Map();
      const fakeApp = {
        page(p, h) { pages.set(p, h); },
        api(p, h) { apis.set(p, h); },
      };
      const { app, sync } = srvMod.setupSidecarServer(fakeApp, {
        uiDir: dir,
        corsOrigins: ['http://127.0.0.1'],
        host: '127.0.0.1',
        bodyLimitBytes: 65536,
        stateSyncOptions: { sidecarId: 'turnkey-test', dataRoot: dir },
      });
      assert.equal(app, fakeApp);
      assert.deepEqual(app.corsOrigins, ['http://127.0.0.1']);
      assert.equal(app.host, '127.0.0.1');
      assert.equal(app.bodyLimitBytes, 65536);
      assert.equal(pages.has('/'), true);
      assert.equal(pages.has('/ui.html'), true);
      assert.equal(pages.has('/agy.css'), true);
      assert.equal(pages.has('/compiled_tailwind.css'), true);
      assert.equal(pages.has('/shell.css'), true);
      assert.equal(pages.has('/shell.js'), true);
      assert.equal(pages.has('/ui.css'), true);
      assert.equal(pages.has('/ui.js'), true);
      assert.equal(apis.has('/api/events'), true);
      assert.equal(apis.has('/api/mutate'), true);
      sync?.dispose?.();

      // ASK-06: enableUiRoutes: false, uiModules, and enableStateSync: true/false forwarding
      const pages2 = new Map();
      const apis2 = new Map();
      const fakeApp2 = {
        page(p, h) { pages2.set(p, h); },
        api(p, h) { apis2.set(p, h); },
      };
      const res2 = srvMod.setupSidecarServer(fakeApp2, {
        uiDir: dir,
        enableUiRoutes: false,
        enableStateSync: true,
        stateSyncOptions: { sidecarId: 'turnkey-2', dataRoot: dir },
      });
      assert.equal(pages2.has('/ui.css'), false, 'enableUiRoutes: false must skip /ui.css');
      assert.equal(apis2.has('/api/mutate'), true, 'enableStateSync: true must register /api/mutate');
      res2.sync?.dispose?.();

      const pages3 = new Map();
      const apis3 = new Map();
      const fakeApp3 = {
        page(p, h) { pages3.set(p, h); },
        api(p, h) { apis3.set(p, h); },
      };
      srvMod.setupSidecarServer(fakeApp3, {
        uiDir: dir,
        uiModules: ['controls'],
        enableStateSync: false,
        stateSyncOptions: { sidecarId: 'turnkey-3', dataRoot: dir },
      });
      assert.equal(pages3.has('/ui.css'), true);
      const controlsOnlyCss = pages3.get('/ui.css')().body;
      assert.equal(controlsOnlyCss.includes('.agy-btn'), true);
      assert.equal(controlsOnlyCss.includes('.agy-tab-strip'), false, 'uiModules subset must be respected');
      assert.equal(apis3.has('/api/mutate'), false, 'enableStateSync: false must skip StateSync routes');

      // ASK-12: createAssetHandler injects token into single-quoted src/href and URLs with existing query strings
      writeFileSync(
        join(dir, 'quotes.html'),
        `<html><head><link rel="stylesheet" href="/agy.css?v=1"><script src='/shell.js#init'></script></head></html>`,
        'utf8'
      );
      const quoteHandler = srvMod.createAssetHandler(dir, 'quotes.html', 'text/html', {
        uiToken: 'tok-q12',
        bootTs: 99,
      });
      const renderedHtml = quoteHandler().body;
      assert.match(renderedHtml, /href="\/agy\.css\?v=1&token=tok-q12&v=99"/);
      assert.match(renderedHtml, /src='\/shell\.js\?token=tok-q12&v=99#init'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
