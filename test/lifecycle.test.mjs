import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  exitWithLanguageServer,
  parseLsAddress,
  probeLanguageServer,
} from '../lib/lifecycle.mjs';

const listen = () =>
  new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

// Runs the watchdog with a scripted probe and waits until it exits (or the test times out).
function runWatchdog(results, extra = {}) {
  const calls = [];
  return new Promise((resolve) => {
    const handle = exitWithLanguageServer({
      address: 'localhost:52908',
      intervalMs: 5,
      probe: async () => (results.length ? results.shift() : false),
      onExit: () => calls.push('onExit'),
      app: { close: () => calls.push('close') },
      exit: (code) => {
        calls.push(`exit:${code}`);
        resolve({ calls, handle });
      },
      log: () => {},
      ...extra,
    });
  });
}

describe('antigravity-sidecar-kit/lifecycle', () => {
  it('parseLsAddress reads host:port, tolerates a scheme, and rejects bad input', () => {
    assert.deepEqual(parseLsAddress('localhost:52908'), { host: 'localhost', port: 52908 });
    assert.deepEqual(parseLsAddress('http://127.0.0.1:1234/'), { host: '127.0.0.1', port: 1234 });
    assert.deepEqual(parseLsAddress('[::1]:8080'), { host: '::1', port: 8080 });
    for (const bad of ['', undefined, 'localhost', ':80', 'localhost:0', 'localhost:70000', 'localhost:abc']) {
      assert.equal(parseLsAddress(bad), null, String(bad));
    }
  });

  it('probeLanguageServer is true for a listening port and false once it closes', async () => {
    const server = await listen();
    const { port } = server.address();
    assert.equal(await probeLanguageServer({ host: '127.0.0.1', port }, 1000), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await probeLanguageServer({ host: '127.0.0.1', port }, 1000), false);
  });

  it('does nothing without ANTIGRAVITY_LS_ADDRESS', () => {
    const handle = exitWithLanguageServer({ address: '', exit: () => assert.fail('must not exit') });
    assert.equal(handle.active, false);
  });

  it('exits after maxFailures failed probes in a row, running onExit and app.close first', async () => {
    const { calls } = await runWatchdog([true, false, false]);
    assert.deepEqual(calls, ['onExit', 'close', 'exit:0']);
  });

  it('resets the failure count when the language server answers again', async () => {
    const seen = [];
    const results = [false, true, false, true, false, false];
    await runWatchdog(results, {
      probe: async () => {
        const alive = results.shift() ?? false;
        seen.push(alive);
        return alive;
      },
    });
    assert.deepEqual(seen, [false, true, false, true, false, false]);
  });

  it('still exits when app.close() never settles, as with an open SSE stream', async () => {
    const { calls } = await runWatchdog([false, false], { app: { close: () => new Promise(() => {}) } });
    assert.deepEqual(calls, ['onExit', 'exit:0']);
  });

  it('stop() cancels the watchdog', async () => {
    const handle = exitWithLanguageServer({
      address: 'localhost:52908',
      intervalMs: 5,
      probe: async () => false,
      exit: () => assert.fail('must not exit after stop()'),
      log: () => {},
    });
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
