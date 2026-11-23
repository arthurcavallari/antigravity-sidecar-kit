import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MCP_CONFIG_PATH,
  readJsonSafe,
  readJsonFile,
  writeJsonNoBom,
  updateAgySidecarConfig,
  syncMcpServerConfig,
} from '../lib/config.mjs';

describe('antigravity-sidecar-kit/config BOM-safe JSON helpers and config.json updater', () => {
  it('strips UTF-8 BOM on read, writes without BOM, and supports strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-config-test-'));
    try {
      const p = join(dir, 'bom.json');
      writeFileSync(p, '\uFEFF{"hello":"world"}\n', 'utf8');
      assert.deepEqual(readJsonSafe(p, {}), { hello: 'world' });

      const outPath = join(dir, 'nested', 'out.json');
      writeJsonNoBom(outPath, { a: 1 });
      const rawBytes = readFileSync(outPath);
      assert.notEqual(rawBytes[0], 0xef);
      assert.deepEqual(readJsonFile(outPath), { a: 1 });

      // Atomic rewrite: overwrites in place and leaves no temp files behind
      writeJsonNoBom(outPath, { a: 2, nested: { b: [1, 2] } });
      assert.deepEqual(readJsonFile(outPath), { a: 2, nested: { b: [1, 2] } });
      assert.deepEqual(readdirSync(join(dir, 'nested')), ['out.json']);

      const badPath = join(dir, 'bad.json');
      writeFileSync(badPath, '{ truncated', 'utf8');
      assert.deepEqual(readJsonSafe(badPath, { fallback: true }), { fallback: true });
      assert.throws(() => readJsonFile(badPath, { strict: true }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateAgySidecarConfig preserves projectId and never clobbers malformed config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-agy-cfg-test-'));
    try {
      const cfgPath = join(dir, 'config.json');
      writeJsonNoBom(cfgPath, {
        userSettings: { themeMode: 'THEME_MODE_DARK' },
        sidecars: {
          hangar: {
            enabled: false,
            projectId: 'preserve-uuid-999',
          },
        },
      });

      const ok = updateAgySidecarConfig('hangar', true, cfgPath);
      assert.equal(ok, true);
      const updated = readJsonSafe(cfgPath, {});
      assert.equal(updated.sidecars.hangar.enabled, true);
      assert.equal(updated.sidecars.hangar.projectId, 'preserve-uuid-999');

      // Malformed config.json must never be overwritten
      const corruptContent = '{ "sidecars": { "hangar": ';
      writeFileSync(cfgPath, corruptContent, 'utf8');
      const okCorrupt = updateAgySidecarConfig('hangar', false, cfgPath);
      assert.equal(okCorrupt, false);
      assert.equal(readFileSync(cfgPath, 'utf8'), corruptContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('syncMcpServerConfig writes BOM-free mcp_config.json, preserves env, supports uninstall, and throws on malformed JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-mcp-cfg-test-'));
    try {
      assert.equal(typeof DEFAULT_MCP_CONFIG_PATH, 'string');
      assert.ok(DEFAULT_MCP_CONFIG_PATH.endsWith('mcp_config.json'));
      const barrel = await import('../lib/index.mjs');
      assert.equal(barrel.syncMcpServerConfig, syncMcpServerConfig);
      assert.equal(barrel.DEFAULT_MCP_CONFIG_PATH, DEFAULT_MCP_CONFIG_PATH);

      const mcpPath = join(dir, 'mcp_config.json');
      const rpcCalls = [];
      const callLsRpcFn = async (method, body, opts) => {
        rpcCalls.push({ method, body, opts });
        return { ok: true };
      };

      // 1. Creates mcp_config.json without BOM, writes entry, and invokes RefreshMcpServers
      const created = await syncMcpServerConfig({
        serverName: 'notes-mcp',
        command: '/usr/bin/node',
        args: ['/srv/notes/mcp.mjs'],
        enabled: true,
        mcpConfigPath: mcpPath,
        callLsRpcFn,
        sidecarId: 'notes',
      });
      assert.deepEqual(created, { registered: true, enabled: true });
      const rawBytes = readFileSync(mcpPath);
      assert.notEqual(rawBytes[0], 0xef);
      assert.deepEqual(readJsonSafe(mcpPath, {}), {
        mcpServers: {
          'notes-mcp': {
            command: '/usr/bin/node',
            args: ['/srv/notes/mcp.mjs'],
            disabled: false,
          },
        },
      });
      assert.deepEqual(rpcCalls, [
        { method: 'RefreshMcpServers', body: {}, opts: { sidecarId: 'notes' } },
      ]);

      // Seed env on notes-mcp + a sibling server, and verify callLsRpcFn rejections are swallowed
      await syncMcpServerConfig({
        serverName: 'notes-mcp',
        command: '/usr/bin/node',
        args: ['/srv/notes/mcp.mjs'],
        env: { NOTES_TOKEN: 'keep-secret' },
        enabled: true,
        mcpConfigPath: mcpPath,
        callLsRpcFn: async () => {
          throw new Error('Language Server offline');
        },
        sidecarId: 'notes',
      });
      await syncMcpServerConfig({
        serverName: 'sibling-mcp',
        command: 'npx',
        args: ['sibling-server'],
        mcpConfigPath: mcpPath,
      });

      // 2. Preserves existing env when env is omitted, and deletes only target server on uninstall
      const updated = await syncMcpServerConfig({
        serverName: 'notes-mcp',
        command: '/opt/node22/bin/node',
        args: ['/srv/notes-v2/mcp.mjs'],
        enabled: false,
        mcpConfigPath: mcpPath,
      });
      assert.deepEqual(updated, { registered: true, enabled: false });
      assert.deepEqual(readJsonSafe(mcpPath, {}), {
        mcpServers: {
          'notes-mcp': {
            command: '/opt/node22/bin/node',
            args: ['/srv/notes-v2/mcp.mjs'],
            disabled: true,
            env: { NOTES_TOKEN: 'keep-secret' },
          },
          'sibling-mcp': {
            command: 'npx',
            args: ['sibling-server'],
            disabled: false,
          },
        },
      });

      const uninstalled = await syncMcpServerConfig({
        serverName: 'notes-mcp',
        uninstall: true,
        mcpConfigPath: mcpPath,
        callLsRpcFn,
        sidecarId: 'notes',
      });
      assert.deepEqual(uninstalled, { registered: false, enabled: false });
      assert.deepEqual(readJsonSafe(mcpPath, {}), {
        mcpServers: {
          'sibling-mcp': {
            command: 'npx',
            args: ['sibling-server'],
            disabled: false,
          },
        },
      });

      // 3. Throws without modifying disk when existing mcp_config.json contains malformed JSON
      const corruptMcp = '{ "mcpServers": { "broken": ';
      writeFileSync(mcpPath, corruptMcp, 'utf8');
      await assert.rejects(
        () =>
          syncMcpServerConfig({
            serverName: 'notes-mcp',
            mcpConfigPath: mcpPath,
          }),
        SyntaxError
      );
      assert.equal(readFileSync(mcpPath, 'utf8'), corruptMcp);

      await assert.rejects(
        () =>
          syncMcpServerConfig({
            serverName: 'sibling-mcp',
            uninstall: true,
            mcpConfigPath: mcpPath,
          }),
        SyntaxError
      );
      assert.equal(readFileSync(mcpPath, 'utf8'), corruptMcp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
