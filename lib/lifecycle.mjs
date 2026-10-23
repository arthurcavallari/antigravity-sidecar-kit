/**
 * @fileoverview Ends a sidecar once the Antigravity language server that started it is gone.
 *
 * On Windows, quitting the desktop app force-kills the language server, which therefore never
 * stops its sidecars: they keep running as orphans, holding their ports, until killed by hand.
 * The language server's own job object lets its children break away, so nothing else cleans
 * them up. This watchdog is a stopgap until the language server ties sidecars to its lifetime.
 */

import { connect } from 'node:net';

export const DEFAULT_INTERVAL_MS = 5000;
export const DEFAULT_MAX_FAILURES = 2;
const PROBE_TIMEOUT_MS = 2000;
const CLOSE_GRACE_MS = 1000;

// ANTIGRAVITY_LS_ADDRESS is "host:port" (e.g. "localhost:52908"); a scheme prefix is tolerated.
export function parseLsAddress(address) {
  const text = String(address ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sep = text.lastIndexOf(':');
  if (sep <= 0) return null;
  const port = Number(text.slice(sep + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = text.slice(0, sep).replace(/^\[(.*)\]$/, '$1');
  return { host, port };
}

// Resolves true if a TCP connection to the language server opens within timeoutMs.
export function probeLanguageServer({ host, port }, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (alive) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Polls the language server and exits the process after `maxFailures` failed probes in a row.
 * Before exiting it runs `onExit` (e.g. to delete server_info.json) and gives `app.close()`
 * a short grace period, since open SSE streams would otherwise keep close() waiting.
 * Does nothing when ANTIGRAVITY_LS_ADDRESS is unset (a sidecar run by hand, or a unit test).
 */
export function exitWithLanguageServer({
  app,
  onExit,
  address = process.env.ANTIGRAVITY_LS_ADDRESS,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  probe = probeLanguageServer,
  exit = (code) => process.exit(code),
  log = (message) => console.warn(message),
} = {}) {
  const target = parseLsAddress(address);
  if (!target) return { active: false, stop() {} };

  let failures = 0;
  let checking = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      if (await probe(target)) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < maxFailures || stopped) return;
      stopped = true;
      clearInterval(timer);
      log(`[antigravity-sidecar-kit] Language server at ${address} is gone; exiting.`);
      try {
        await onExit?.();
      } catch (err) {
        log(`[antigravity-sidecar-kit] onExit failed: ${err?.message || err}`);
      }
      if (typeof app?.close === 'function') {
        await Promise.race([
          Promise.resolve(app.close()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
        ]);
      }
      exit(0);
    } finally {
      checking = false;
    }
  }, intervalMs);
  timer.unref();

  return {
    active: true,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
