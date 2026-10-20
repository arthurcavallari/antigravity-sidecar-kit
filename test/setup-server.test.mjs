import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../lib/config.mjs';
import { resolvePermanentLinkSource, runSidecarSetup } from '../lib/setup.mjs';
import { createAssetHandler, createAgyCssHandler } from '../lib/server.mjs';
import { scaffoldSidecarProject } from '../lib/scaffolder.mjs';

describe('antigravity-sidecar-kit/setup, /server, and CLI scaffolder', () => {
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
      writeJsonNoBom(join(nestedRepo, 'package.json'), { name: 'antigravity-nested', version: '2.0.0' });
      writeJsonNoBom(join(nestedRepo, 'node_modules', 'antigravity-sidecar-kit', 'package.json'), {
        name: 'antigravity-sidecar-kit',
        version: '1.0.0',
      });
      writeFileSync(join(nestedRepo, 'node_modules', 'other-bloat-pkg', 'index.js'), '', 'utf8');

      const copiedNested = resolvePermanentLinkSource(nestedRepo, {
        sidecarId: 'nested',
        packagesDir,
      });
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
        rpcOptions: { lsAddress: '', csrfToken: '' },
        restartDelayMs: 0,
      });
      assert.equal(setupRes.uninstalled, false);
      assert.equal(existsSync(join(globalSidecarsDir, 'my-custom-tool', 'sidecar.json')), true);

      const cfgAfterSetup = readJsonSafe(configJsonPath, {});
      assert.equal(cfgAfterSetup.sidecars['my-custom-tool'].enabled, true);
      assert.equal(cfgAfterSetup.sidecars['my-custom-tool'].projectId, 'keep-this-project-id');

      const uninstRes = await runSidecarSetup({
        sidecarId: 'my-custom-tool',
        repoRoot: scaffoldDir,
        args: ['--uninstall'],
        globalSidecarsDir,
        configJsonPath,
        rpcOptions: { lsAddress: '', csrfToken: '' },
      });
      assert.equal(uninstRes.uninstalled, true);
      assert.equal(existsSync(join(globalSidecarsDir, 'my-custom-tool')), false);
      const cfgAfterUninst = readJsonSafe(configJsonPath, {});
      assert.equal(cfgAfterUninst.sidecars['my-custom-tool'].enabled, false);
      assert.equal(cfgAfterUninst.sidecars['my-custom-tool'].projectId, 'keep-this-project-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createAssetHandler injects UI token into local HTML asset links and createAgyCssHandler serves CSS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-server-test-'));
    try {
      writeFileSync(
        join(dir, 'index.html'),
        '<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>',
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

      const cssHandler = createAgyCssHandler({ lsAddress: '' });
      const cssRes = await cssHandler();
      assert.equal(cssRes.contentType, 'text/css; charset=utf-8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
