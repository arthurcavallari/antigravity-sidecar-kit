import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as kitBarrel from '../lib/index.mjs';
import { lintPluginOrSidecar } from '../lib/manifest-validator.mjs';
import { bundleSidecarKit } from '../lib/setup.mjs';
import { scaffoldProject, scaffoldSidecarProject } from '../lib/scaffolder.mjs';

function createLineReader(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });
  const buffered = [];
  const waiters = [];
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else buffered.push(parsed);
  });
  return {
    next() {
      if (buffered.length > 0) return Promise.resolve(buffered.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

describe('scaffoldProject archetypes (Task 3)', () => {
  it('1. sidecar-ui: scaffolds clean files, sandbox & permissions, passes strict lint, and boots server.mjs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-arch-ui-'));
    try {
      const outDir = join(tmp, 'antigravity-notes-ui');
      const res = scaffoldProject({
        name: 'notes-ui',
        archetype: 'sidecar-ui',
        targetDir: outDir,
        author: 'Jane Doe',
      });

      assert.equal(res.id, 'notes-ui');
      assert.equal(res.archetype, 'sidecar-ui');
      assert.equal(res.pkgName, 'antigravity-notes-ui');
      assert.equal(res.displayName, 'Notes Ui');
      assert.equal(res.outDir, outDir);

      const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(Array.isArray(pkg.files), true);
      assert.equal(pkg.files.includes('test'), false, 'package.json#files must exclude test');
      assert.equal(pkg.files.includes('mcp.mjs'), false);
      assert.deepEqual(pkg.bin, {
        'antigravity-notes-ui': './setup.mjs',
        'agy-notes-ui': './setup.mjs',
      });

      const sidecar = JSON.parse(readFileSync(join(outDir, 'sidecar.json'), 'utf8'));
      assert.deepEqual(sidecar.sandbox, { disable_sandbox: true });
      assert.deepEqual(sidecar.agent_permissions, { workspace_uris: [] });
      assert.equal('allows_user_interactions' in sidecar.agent_permissions, false);

      const hub = JSON.parse(readFileSync(join(outDir, 'hub-manifest.json'), 'utf8'));
      assert.equal(hub.capabilityTier, 'TIER_1_TELEMETRY');

      const lint = lintPluginOrSidecar(outDir, { strict: true });
      assert.equal(lint.valid, true, JSON.stringify(lint));
      assert.equal(lint.errors.length, 0);
      assert.equal(lint.warnings.length, 0);

      bundleSidecarKit(outDir);
      execFileSync(process.execPath, ['--test', join(outDir, 'test', 'smoke.test.mjs')], {
        cwd: outDir,
        stdio: 'pipe',
      });

      const { createServer } = await import(pathToFileURL(join(outDir, 'server.mjs')).href);
      const srv = await createServer({ port: 0, uiToken: 'tok' });
      try {
        assert.ok(srv.port > 0);
        const healthRes = await fetch(`http://127.0.0.1:${srv.port}/_sidecar/health`);
        assert.equal(healthRes.status, 200);
        const healthJson = await healthRes.json();
        assert.equal(healthJson.ok, true);

        const htmlRes = await fetch(`http://127.0.0.1:${srv.port}/index.html?token=tok`);
        assert.equal(htmlRes.status, 200);
        const htmlBody = await htmlRes.text();
        assert.match(htmlBody, /Notes Ui/);

        const unauthApi = await fetch(`http://127.0.0.1:${srv.port}/api/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(unauthApi.status, 401);

        const authApi = await fetch(`http://127.0.0.1:${srv.port}/api/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'tok' },
          body: '{}',
        });
        assert.equal(authApi.status, 200);
        const statusJson = await authApi.json();
        assert.equal(statusJson.ok, true);
        assert.equal(statusJson.sidecarId, 'notes-ui');
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('2. sidecar-mcp: sets TIER_2_LOCAL_TOOLING, includes mcp.mjs, mutates state via startMcpStdio, and syncs mcp_config in setup.mjs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-arch-mcp-'));
    try {
      const outDir = join(tmp, 'antigravity-stash');
      const res = scaffoldProject({
        name: 'stash',
        archetype: 'sidecar-mcp',
        targetDir: outDir,
        author: 'Jane Doe',
        github: 'octocat',
      });

      assert.equal(res.id, 'stash');
      assert.equal(res.archetype, 'sidecar-mcp');

      const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(pkg.files.includes('mcp.mjs'), true);
      assert.equal(pkg.files.includes('test'), false);
      assert.equal(pkg.repository.url, 'git+https://github.com/octocat/antigravity-stash.git');

      const hub = JSON.parse(readFileSync(join(outDir, 'hub-manifest.json'), 'utf8'));
      assert.equal(hub.capabilityTier, 'TIER_2_LOCAL_TOOLING');

      const lint = lintPluginOrSidecar(outDir, { strict: true });
      assert.equal(lint.valid, true, JSON.stringify(lint));

      bundleSidecarKit(outDir);
      execFileSync(process.execPath, ['--test', join(outDir, 'test', 'smoke.test.mjs')], {
        cwd: outDir,
        stdio: 'pipe',
      });

      const { startMcpStdio } = await import(pathToFileURL(join(outDir, 'mcp.mjs')).href);
      const { createServer } = await import(pathToFileURL(join(outDir, 'server.mjs')).href);

      const dataDir = join(tmp, 'mcp-data');
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = createLineReader(output);
      const bridge = startMcpStdio({ dataDir, input, output });

      try {
        input.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18' },
          })}\n`
        );
        const initReply = await reader.next();
        assert.equal(initReply.id, 1);
        assert.equal(initReply.result.serverInfo.name, 'stash');

        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        const listReply = await reader.next();
        const toolNames = listReply.result.tools.map((t) => t.name);
        assert.ok(toolNames.includes('status'), `expected status in ${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes('add_item'), `expected add_item in ${JSON.stringify(toolNames)}`);

        input.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add_item', arguments: { text: 'ship archetype scaffolder' } },
          })}\n`
        );
        const callReply = await reader.next();
        assert.equal(callReply.id, 3);
        assert.equal(callReply.error, undefined);
        const payload = JSON.parse(callReply.result.content[0].text);
        assert.equal(payload.ok, true);
        assert.equal(payload.items.length, 1);
        assert.equal(payload.items[0].text, 'ship archetype scaffolder');

        const persisted = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
        assert.equal(persisted.items.length, 1);
        assert.equal(persisted.items[0].text, 'ship archetype scaffolder');
        assert.equal(typeof persisted.updatedAt, 'string');

        input.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'status', arguments: {} },
          })}\n`
        );
        const statusReply = await reader.next();
        const statusPayload = JSON.parse(statusReply.result.content[0].text);
        assert.equal(statusPayload.count, 1);
      } finally {
        reader.close();
        input.end();
        bridge.close();
        await bridge.closed;
      }

      // Verify live HTTP forwarding over /api/mcp when server.mjs is running
      const liveDataDir = join(tmp, 'mcp-live-data');
      const liveSrv = await createServer({ port: 0, uiToken: 'live-tok', dataDir: liveDataDir });
      const liveIn = new PassThrough();
      const liveOut = new PassThrough();
      const liveReader = createLineReader(liveOut);
      const liveBridge = startMcpStdio({ dataDir: liveDataDir, input: liveIn, output: liveOut });
      try {
        liveIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'add_item', arguments: { text: 'forwarded live' } },
          })}\n`
        );
        const liveReply = await liveReader.next();
        assert.equal(liveReply.id, 10);
        assert.equal(liveSrv.stateSync.getState().items.length, 1);
        assert.equal(liveSrv.stateSync.getState().items[0].text, 'forwarded live');
      } finally {
        liveReader.close();
        liveIn.end();
        liveBridge.close();
        await liveBridge.closed;
        await liveSrv.close();
      }

      // Regression: server.mjs (with ANTIGRAVITY_EXECUTABLE_DATA_DIR=.../sidecar_data/stash/data)
      // and mcp.mjs (without ANTIGRAVITY_EXECUTABLE_DATA_DIR) resolve the exact same state.json path
      const fakeHome = join(tmp, 'fake-home');
      const expectedStateFile = join(
        fakeHome,
        '.gemini',
        'antigravity',
        'sidecar_data',
        'stash',
        'state.json'
      );
      const offlineEnvIn = new PassThrough();
      const offlineEnvOut = new PassThrough();
      const offlineEnvReader = createLineReader(offlineEnvOut);
      const offlineEnvBridge = startMcpStdio({
        env: { HOME: fakeHome, USERPROFILE: fakeHome },
        input: offlineEnvIn,
        output: offlineEnvOut,
      });
      try {
        offlineEnvIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 20,
            method: 'tools/call',
            params: { name: 'add_item', arguments: { text: 'persisted-offline' } },
          })}\n`
        );
        const offlineEnvReply = await offlineEnvReader.next();
        assert.equal(offlineEnvReply.id, 20);
      } finally {
        offlineEnvReader.close();
        offlineEnvIn.end();
        offlineEnvBridge.close();
        await offlineEnvBridge.closed;
      }
      assert.equal(existsSync(expectedStateFile), true);

      const execDataDir = join(fakeHome, '.gemini', 'antigravity', 'sidecar_data', 'stash', 'data');
      const envSrv = await createServer({
        port: 0,
        uiToken: 'env-tok',
        env: {
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: execDataDir,
        },
      });
      try {
        assert.equal(envSrv.stateSync.globalState.statePath, expectedStateFile);
        assert.equal(envSrv.stateSync.getState().items.length, 1);
        assert.equal(envSrv.stateSync.getState().items[0].text, 'persisted-offline');
        assert.equal(existsSync(join(execDataDir, 'state.json')), false);
      } finally {
        await envSrv.close();
      }

      // Verify generated setup.mjs --with-mcp (default), --no-mcp, and --uninstall
      const { runSetup } = await import(pathToFileURL(join(outDir, 'setup.mjs')).href);
      const sandboxDir = join(tmp, 'sandbox');
      const configJsonPath = join(sandboxDir, 'config.json');
      const mcpConfigPath = join(sandboxDir, 'mcp_config.json');
      const globalSidecarsDir = join(sandboxDir, 'sidecars');
      const packagesDir = join(sandboxDir, 'packages');

      await runSetup(['--skip-tests', '--no-mcp'], {
        configJsonPath,
        mcpConfigPath,
        globalSidecarsDir,
        packagesDir,
        rpcOptions: { lsAddress: '', csrfToken: '' },
        restartDelayMs: 0,
      });
      assert.equal(existsSync(mcpConfigPath), false, '--no-mcp must skip mcp_config.json creation');

      await runSetup(['--skip-tests'], {
        configJsonPath,
        mcpConfigPath,
        globalSidecarsDir,
        packagesDir,
        rpcOptions: { lsAddress: '', csrfToken: '' },
        restartDelayMs: 0,
      });
      const mcpCfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal(mcpCfg.mcpServers.stash.disabled, false);

      await runSetup(['--uninstall'], {
        configJsonPath,
        mcpConfigPath,
        globalSidecarsDir,
        packagesDir,
        rpcOptions: { lsAddress: '', csrfToken: '' },
      });
      const mcpCfgAfter = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      assert.equal('stash' in (mcpCfgAfter.mcpServers || {}), false);

      // Regression (I4): setupOpts.callLsRpcFn receives 'RefreshMcpServers' on install & uninstall,
      // and no live RPC fires against ambient LS when sandboxed without setupOpts.callLsRpcFn
      const refreshCalls = [];
      await runSetup(['--skip-tests'], {
        configJsonPath,
        mcpConfigPath,
        globalSidecarsDir,
        packagesDir,
        callLsRpcFn: async (method, body, opts) => {
          refreshCalls.push({ phase: 'install', method, body, opts });
          return { ok: true };
        },
        restartDelayMs: 0,
      });
      assert.equal(refreshCalls.length, 1);
      assert.equal(refreshCalls[0].method, 'RefreshMcpServers');
      assert.equal(refreshCalls[0].opts.sidecarId, 'stash');

      await runSetup(['--uninstall'], {
        configJsonPath,
        mcpConfigPath,
        globalSidecarsDir,
        packagesDir,
        callLsRpcFn: async (method, body, opts) => {
          refreshCalls.push({ phase: 'uninstall', method, body, opts });
          return { ok: true };
        },
      });
      assert.equal(refreshCalls.length, 2);
      assert.equal(refreshCalls[1].method, 'RefreshMcpServers');

      const ambientRequests = [];
      const dummyLs = createHttpServer((req, res) => {
        ambientRequests.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      await new Promise((resolve) => dummyLs.listen(0, '127.0.0.1', resolve));
      const prevLs = process.env.ANTIGRAVITY_LS_ADDRESS;
      const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
      try {
        process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${dummyLs.address().port}`;
        process.env.ANTIGRAVITY_CSRF_TOKEN = 'ambient-mcp-csrf';
        await runSetup(['--skip-tests'], {
          configJsonPath,
          mcpConfigPath,
          globalSidecarsDir,
          packagesDir,
          restartDelayMs: 0,
        });
        await runSetup(['--uninstall'], {
          configJsonPath,
          mcpConfigPath,
          globalSidecarsDir,
          packagesDir,
        });
        assert.deepEqual(
          ambientRequests,
          [],
          'sandboxed sidecar-mcp setup without callLsRpcFn must not fire live RPCs'
        );
      } finally {
        if (prevLs === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
        else process.env.ANTIGRAVITY_LS_ADDRESS = prevLs;
        if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
        else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
        await new Promise((resolve) => dummyLs.close(resolve));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('3. plugin: scaffolds all 5 components on a 28-char name with 0 MCP-NAME-01/VAR-HOOK-01 warnings and rejects empty components on pure plugin', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-arch-plugin-'));
    try {
      const longName = 'enterprise-observability-pack';
      assert.ok(longName.length >= 28);
      const outDir = join(tmp, 'agy-enterprise-observability-pack');
      const res = scaffoldProject({
        name: longName,
        archetype: 'plugin',
        targetDir: outDir,
        components: ['skills', 'mcp', 'rules', 'hooks', 'agents'],
        author: 'Octo Cat',
        github: 'octocat',
      });

      assert.equal(res.id, longName);
      assert.equal(res.archetype, 'plugin');
      assert.equal(res.pkgName, `agy-${longName}`);
      assert.equal(res.pluginName, `agy-${longName}`);

      const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(pkg.private, true);
      assert.deepEqual(pkg.agyPlugin, {
        pluginDir: 'plugin',
        outDir: 'dist/plugin',
        copy: ['LICENSE'],
        bundleKit: true,
      });

      const pluginManifest = JSON.parse(readFileSync(join(outDir, 'plugin', 'plugin.json'), 'utf8'));
      assert.equal(pluginManifest.name, res.pluginName);
      assert.equal(pluginManifest.version, '1.0.0');

      const hooksJson = JSON.parse(readFileSync(join(outDir, 'plugin', 'hooks.json'), 'utf8'));
      assert.deepEqual(hooksJson, {
        [res.pluginName]: {
          SessionStart: [
            {
              type: 'command',
              command: 'node scripts/session-start.mjs',
              timeout: 10,
            },
          ],
        },
      });

      const mcpJson = JSON.parse(readFileSync(join(outDir, 'plugin', 'mcp_config.json'), 'utf8'));
      assert.deepEqual(mcpJson, {
        mcpServers: {
          mcp: {
            command: 'node',
            args: ['${PLUGIN_ROOT}/mcp/server.mjs'],
          },
        },
      });

      assert.equal(existsSync(join(outDir, 'plugin', 'skills', longName, 'SKILL.md')), true);
      assert.equal(existsSync(join(outDir, 'plugin', 'rules', 'AGENTS.md')), true);
      assert.equal(existsSync(join(outDir, 'plugin', 'agents', `${longName}.md`)), true);
      assert.equal(existsSync(join(outDir, 'plugin', 'scripts', 'session-start.mjs')), true);
      assert.equal(existsSync(join(outDir, 'plugin', 'mcp', 'server.mjs')), true);

      const rootLint = lintPluginOrSidecar(outDir, { strict: true });
      assert.equal(rootLint.valid, true, JSON.stringify(rootLint));
      assert.equal(rootLint.errors.length, 0);
      assert.equal(rootLint.warnings.length, 0);

      const pluginLint = lintPluginOrSidecar(join(outDir, 'plugin'), { strict: true });
      assert.equal(pluginLint.valid, true, JSON.stringify(pluginLint));
      assert.equal(pluginLint.errors.length, 0);
      assert.equal(
        pluginLint.warnings.filter((w) => w.ruleId === 'MCP-NAME-01' || w.ruleId === 'VAR-HOOK-01').length,
        0
      );
      assert.equal(pluginLint.warnings.length, 0);

      // Exercise generated smoke.test.mjs on the 5-component plugin
      bundleSidecarKit(outDir);
      execFileSync(process.execPath, ['--test', join(outDir, 'test', 'smoke.test.mjs')], {
        cwd: outDir,
        stdio: 'pipe',
      });

      // Exercise generated zero-dep plugin MCP server ('ping' tool)
      const { TOOLS, startPluginMcpStdio } = await import(
        pathToFileURL(join(outDir, 'plugin', 'mcp', 'server.mjs')).href
      );
      assert.equal(TOOLS.some((t) => t.name === 'ping'), true);
      const mcpIn = new PassThrough();
      const mcpOut = new PassThrough();
      const mcpReader = createLineReader(mcpOut);
      const mcpSrv = startPluginMcpStdio({ input: mcpIn, output: mcpOut });
      try {
        mcpIn.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'server/discover', params: {} })}\n`);
        const discoverRes = await mcpReader.next();
        assert.equal(discoverRes.result.protocolVersion, '2026-07-28');
        assert.equal(Array.isArray(discoverRes.result.supportedVersions), true);

        mcpIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 101,
            method: 'initialize',
            params: { protocolVersion: '' },
          })}\n`
        );
        const emptyInitRes = await mcpReader.next();
        assert.equal(emptyInitRes.result.protocolVersion, '2025-06-18');

        mcpIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 102,
            method: 'initialize',
            params: { protocolVersion: '1999-01-01' },
          })}\n`
        );
        const unsupportedInitRes = await mcpReader.next();
        assert.equal(unsupportedInitRes.result.protocolVersion, '2025-06-18');

        mcpIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 103,
            method: 'initialize',
            params: { protocolVersion: '2026-07-28' },
          })}\n`
        );
        const negotiatedInitRes = await mcpReader.next();
        assert.equal(negotiatedInitRes.result.protocolVersion, '2026-07-28');

        mcpIn.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
        const toolsRes = await mcpReader.next();
        assert.deepEqual(toolsRes.result.tools.map((t) => t.name), ['ping']);

        mcpIn.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'ping', arguments: { message: 'hi' } },
          })}\n`
        );
        const pingRes = await mcpReader.next();
        assert.match(pingRes.result.content[0].text, /hi/);
      } finally {
        mcpReader.close();
        mcpIn.end();
        mcpSrv.close();
      }

      // Pure plugin without hooks sets bundleKit: false
      const noHooksDir = join(tmp, 'agy-no-hooks');
      scaffoldProject({
        name: 'no-hooks',
        archetype: 'plugin',
        targetDir: noHooksDir,
        components: ['skills'],
      });
      const noHooksPkg = JSON.parse(readFileSync(join(noHooksDir, 'package.json'), 'utf8'));
      assert.equal(noHooksPkg.agyPlugin.bundleKit, false);
      assert.equal(existsSync(join(noHooksDir, 'plugin', 'hooks.json')), false);

      // Pure plugin with empty components throws validation error
      assert.throws(
        () =>
          scaffoldProject({
            name: 'empty-plug',
            archetype: 'plugin',
            targetDir: join(tmp, 'empty-plug'),
            components: [],
          }),
        /component/i
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('4. plugin-sidecar: omits agent_permissions on embedded sidecar.json, sets copy: [lib, LICENSE] and bundleKit: true, supports components: [], and boots server.mjs', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-arch-plug-sc-'));
    try {
      const outDir = join(tmp, 'agy-cockpit');
      const res = scaffoldProject({
        name: 'cockpit',
        archetype: 'plugin-sidecar',
        targetDir: outDir,
        components: [],
        entrypoint: 'sidebar',
        hideTitleBar: true,
        author: 'Octo Cat',
      });

      assert.equal(res.id, 'cockpit');
      assert.equal(res.archetype, 'plugin-sidecar');
      assert.equal(res.pkgName, 'agy-cockpit');
      assert.equal(res.pluginName, 'agy-cockpit');

      const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(pkg.private, true);
      assert.deepEqual(pkg.agyPlugin, {
        pluginDir: 'plugin',
        outDir: 'dist/plugin',
        copy: ['lib', 'LICENSE'],
        bundleKit: true,
      });
      assert.equal(existsSync(join(outDir, 'lib', 'shared.mjs')), true);

      const embeddedSidecarPath = join(outDir, 'plugin', 'sidecars', 'cockpit', 'sidecar.json');
      assert.equal(existsSync(embeddedSidecarPath), true);
      const sidecar = JSON.parse(readFileSync(embeddedSidecarPath, 'utf8'));
      assert.equal('agent_permissions' in sidecar, false, 'plugin-sidecar must omit agent_permissions');
      assert.deepEqual(sidecar.sandbox, { disable_sandbox: true });
      assert.deepEqual(sidecar.ui_config.views, [
        {
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
          path: '/',
          title: 'Cockpit',
          title_bar_style: 'SIDECAR_UI_TITLE_BAR_STYLE_HIDDEN',
        },
      ]);

      const rootLint = lintPluginOrSidecar(outDir, { strict: true });
      assert.equal(rootLint.valid, true, JSON.stringify(rootLint));
      const pluginLint = lintPluginOrSidecar(join(outDir, 'plugin'), { strict: true });
      assert.equal(pluginLint.valid, true, JSON.stringify(pluginLint));
      assert.equal(pluginLint.errors.length, 0);
      assert.equal(pluginLint.warnings.length, 0);

      bundleSidecarKit(outDir);
      execFileSync(process.execPath, ['--test', join(outDir, 'test', 'smoke.test.mjs')], {
        cwd: outDir,
        stdio: 'pipe',
      });

      const { createServer } = await import(
        pathToFileURL(join(outDir, 'plugin', 'sidecars', 'cockpit', 'server.mjs')).href
      );
      const srv = await createServer({
        port: 0,
        uiToken: 'plug-tok',
        env: { HOME: join(tmp, 'plug-home'), USERPROFILE: join(tmp, 'plug-home') },
      });
      try {
        assert.equal(
          srv.stateSync.globalState.statePath,
          join(
            tmp,
            'plug-home',
            '.gemini',
            'antigravity',
            'sidecar_data',
            'agy-cockpit--cockpit',
            'state.json'
          )
        );
        const healthRes = await fetch(`http://127.0.0.1:${srv.port}/_sidecar/health`);
        assert.equal(healthRes.status, 200);
        const statusRes = await fetch(`http://127.0.0.1:${srv.port}/api/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'plug-tok' },
          body: '{}',
        });
        assert.equal(statusRes.status, 200);
        const statusBody = await statusRes.json();
        assert.equal(statusBody.pluginName, 'agy-cockpit');
        assert.equal(statusBody.sidecarId, 'cockpit');
      } finally {
        await srv.close();
      }

      // Backward compatibility check for scaffoldSidecarProject + barrel export + special-char title escaping
      assert.equal(kitBarrel.scaffoldProject, scaffoldProject);
      assert.equal(kitBarrel.scaffoldSidecarProject, scaffoldSidecarProject);
      const compatDir = join(tmp, 'compat-sidecar');
      const compatRes = scaffoldSidecarProject({
        name: 'compat-sidecar',
        targetDir: compatDir,
        title: 'Ops: Metrics & <Logs>',
      });
      assert.equal(compatRes.id, 'compat-sidecar');
      assert.equal(compatRes.archetype, 'sidecar-ui');
      const compatHtml = readFileSync(join(compatDir, 'ui', 'index.html'), 'utf8');
      assert.match(compatHtml, /Ops: Metrics &amp; &lt;Logs&gt;/);
      assert.equal(compatHtml.includes('<Logs>'), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
