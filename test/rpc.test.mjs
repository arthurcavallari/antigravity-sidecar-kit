import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callLsRpc,
  getLsConfig,
  persistSidecarRuntime,
  killSidecarProcessByPortOrPid,
  getSidecars,
  manageSidecar,
  getAllTrajectories,
  getUserStatus,
} from '../lib/rpc.mjs';

// Fakes the PowerShell / lsof / ps lookups used by findListeningPids and isNodeProcess
function fakeExec({ owners = {}, names = {} }) {
  return (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    const port = line.match(/LocalPort (\d+)|tcp:(\d+)/);
    if (port) return (owners[port[1] || port[2]] || []).join('\n') + '\n';
    const pid = line.match(/-Id (\d+)|-p (\d+)/);
    if (pid) return `${names[pid[1] || pid[2]] || ''}\n`;
    throw new Error(`unexpected command: ${line}`);
  };
}

describe('antigravity-sidecar-kit/rpc client, credential cache, and process restarter', () => {
  it('persists and reads runtime.json credentials when env vars are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-rpc-cache-'));
    try {
      const saved = persistSidecarRuntime('hangar', {
        sidecarDataRoot: dir,
        env: {
          ANTIGRAVITY_SIDECAR_WEB_PORT: '51234',
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:59999',
          ANTIGRAVITY_CSRF_TOKEN: 'cached-token-abc',
        },
      });
      assert.equal(saved, true);

      const cfg = getLsConfig({ sidecarDataRoot: dir, env: {} });
      assert.equal(cfg.lsAddress, '127.0.0.1:59999');
      assert.equal(cfg.csrfToken, 'cached-token-abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('killSidecarProcessByPortOrPid only kills a runtime.json PID that still owns the sidecar port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-rpc-kill-'));
    try {
      const dataDir = join(dir, 'demo-sc', 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({ pid: 4242, webPort: 51234 }), 'utf8');

      // Stale PID: nothing listens on the recorded port, so the PID may belong to anything
      const killed = [];
      const stale = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        execFn: fakeExec({ owners: {} }),
        killFn: (pid) => killed.push(pid),
      });
      assert.deepEqual(stale, { restarted: false, reason: 'stale runtime.json' });
      assert.deepEqual(killed, []);

      // Port reused by another process: still not the sidecar
      const reused = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        execFn: fakeExec({ owners: { 51234: [7777] } }),
        killFn: (pid) => killed.push(pid),
      });
      assert.equal(reused.restarted, false);
      assert.deepEqual(killed, []);

      // Recorded PID still owns the port: safe to restart
      const live = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        execFn: fakeExec({ owners: { 51234: [4242] } }),
        killFn: (pid, sig) => killed.push({ pid, sig }),
      });
      assert.deepEqual(live, { restarted: true, method: 'pid:4242' });
      assert.deepEqual(killed, [{ pid: 4242, sig: 'SIGTERM' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('killSidecarProcessByPortOrPid falls back to the logged port but only kills node processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-rpc-kill-log-'));
    try {
      const logsDir = join(dir, 'demo-sc', 'logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        join(logsDir, 'sidecar.log'),
        '[sidecar] listening on 127.0.0.1:61111\n[sidecar] listening on 127.0.0.1:62222\n',
        'utf8'
      );

      const notNode = [];
      const resNotNode = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        execFn: fakeExec({ owners: { 62222: [888888] }, names: { 888888: 'chrome' } }),
        killFn: (pid) => notNode.push(pid),
      });
      assert.equal(resNotNode.restarted, false);
      assert.deepEqual(notNode, []);

      const portKilled = [];
      const res = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        execFn: fakeExec({ owners: { 62222: [888888] }, names: { 888888: '/usr/local/bin/node' } }),
        killFn: (pid) => portKilled.push(pid),
      });
      assert.deepEqual(res, { restarted: true, method: 'port:62222->pid:888888' });
      assert.deepEqual(portKilled, [888888]);

      // No runtime.json and no log: never kill anything
      const none = killSidecarProcessByPortOrPid('missing-sc', {
        sidecarDataRoot: dir,
        execFn: () => assert.fail('should not query processes'),
        killFn: () => assert.fail('should not kill'),
      });
      assert.deepEqual(none, { restarted: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists runtime.json owner-only and never pairs an address with a token cached for another server', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-rpc-perm-'));
    try {
      persistSidecarRuntime('a', {
        sidecarDataRoot: dir,
        env: {
          ANTIGRAVITY_SIDECAR_WEB_PORT: '1',
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1111',
          ANTIGRAVITY_CSRF_TOKEN: 'token-for-1111',
        },
      });
      persistSidecarRuntime('b', {
        sidecarDataRoot: dir,
        env: {
          ANTIGRAVITY_SIDECAR_WEB_PORT: '2',
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:2222',
          ANTIGRAVITY_CSRF_TOKEN: 'token-for-2222',
        },
      });

      const cfg = getLsConfig({ sidecarDataRoot: dir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:2222' } });
      assert.deepEqual(cfg, { lsAddress: '127.0.0.1:2222', csrfToken: 'token-for-2222' });
      const unknown = getLsConfig({ sidecarDataRoot: dir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:3333' } });
      assert.equal(unknown.csrfToken, '');

      if (process.platform === 'win32') {
        t.diagnostic('POSIX file modes not applicable on Windows');
        return;
      }
      assert.equal(statSync(join(dir, 'a', 'data', 'runtime.json')).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('callLsRpc and convenience wrappers send CSRF header and handle HTTP errors', async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };
    const opts = { lsAddress: '127.0.0.1:50000', csrfToken: 'tok-1', fetchFn: mockFetch };

    await getSidecars(opts);
    await manageSidecar('context-monitor', 'SIDECAR_ACTION_RESTART', opts);
    await getAllTrajectories(opts);
    await getUserStatus(opts);

    assert.equal(calls.length, 4);
    assert.ok(calls[0].url.endsWith('/GetSidecars'));
    assert.ok(calls[1].url.endsWith('/ManageSidecar'));
    assert.equal(calls[1].init.headers['x-codeium-csrf-token'], 'tok-1');
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      action: 'SIDECAR_ACTION_RESTART',
      sidecarId: 'context-monitor',
    });

    await assert.rejects(
      () =>
        callLsRpc(
          'GetSidecars',
          {},
          {
            lsAddress: '127.0.0.1:50000',
            csrfToken: 'tok-1',
            fetchFn: async () => ({
              ok: false,
              status: 500,
              text: async () => JSON.stringify({ message: 'internal failure' }),
            }),
          }
        ),
      /LanguageServerService\/GetSidecars failed: internal failure/
    );
  });
});
