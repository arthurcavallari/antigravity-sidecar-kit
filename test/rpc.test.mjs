import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('killSidecarProcessByPortOrPid terminates by runtime.json PID first, then falls back to log port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-rpc-kill-'));
    try {
      const dataDir = join(dir, 'demo-sc', 'data');
      const logsDir = join(dir, 'demo-sc', 'logs');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({ pid: 999999, webPort: 0 }), 'utf8');

      const killedPids = [];
      const res1 = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        killFn: (pid, sig) => killedPids.push({ pid, sig }),
      });
      assert.equal(res1.restarted, true);
      assert.equal(res1.method, 'pid:999999');
      assert.deepEqual(killedPids, [{ pid: 999999, sig: 'SIGTERM' }]);

      // Fallback when runtime.json PID is dead and port is parsed from sidecar.log
      writeFileSync(
        join(logsDir, 'sidecar.log'),
        '[sidecar] listening on 127.0.0.1:61111\n[sidecar] listening on 127.0.0.1:62222\n',
        'utf8'
      );
      const portKilled = [];
      const res2 = killSidecarProcessByPortOrPid('demo-sc', {
        sidecarDataRoot: dir,
        killFn: (pid) => {
          if (pid === 999999) throw new Error('ESRCH');
          portKilled.push(pid);
        },
        execFn: () => '888888\n',
      });
      assert.equal(res2.restarted, true);
      assert.equal(res2.method, 'port:62222->pid:888888');
      assert.deepEqual(portKilled, [888888]);
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
