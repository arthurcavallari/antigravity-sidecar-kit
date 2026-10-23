/**
 * @fileoverview Connect RPC client, runtime credential cache, and process restarter
 * for the local Antigravity Language Server.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SIDECAR_DATA_ROOT, readJsonSafe } from './config.mjs';
import { parseLsAddress } from './lifecycle.mjs';

const DEFAULT_TIMEOUT_MS = 4000;
const EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };

function inferCurrentSidecarId() {
  if (process.env.ANTIGRAVITY_SIDECAR_ID) return String(process.env.ANTIGRAVITY_SIDECAR_ID).trim();
  try {
    const entryFile = process.argv[1] || '';
    if (/setup\.[mc]?js$|\.test\.[mc]?js$/i.test(entryFile) || process.execArgv.includes('--test')) return '';
    const entryDir = entryFile ? dirname(entryFile) : process.cwd();
    if (!existsSync(join(entryDir, 'sidecar.json'))) return '';
    const hubManifest = readJsonSafe(join(entryDir, 'hub-manifest.json'), null);
    if (hubManifest?.id) return String(hubManifest.id).trim();
    const pkgJson = readJsonSafe(join(entryDir, 'package.json'), null);
    if (pkgJson?.name) {
      return String(pkgJson.name)
        .replace(/^antigravity-sidecar-|^antigravity-|^agy-/i, '')
        .trim();
    }
    const folder = basename(entryDir).replace(/@.*$/, '');
    if (folder) return folder;
  } catch {
    // ignore
  }
  return '';
}

export function persistSidecarRuntime(
  sidecarId = inferCurrentSidecarId(),
  { sidecarDataRoot = SIDECAR_DATA_ROOT, env = process.env } = {}
) {
  if (!sidecarId || !env.ANTIGRAVITY_SIDECAR_WEB_PORT || !env.ANTIGRAVITY_LS_ADDRESS) {
    return false;
  }
  try {
    const dir = join(sidecarDataRoot, sidecarId, 'data');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runtimePath = join(dir, 'runtime.json');
    // runtime.json holds the Language Server CSRF token, so keep it owner-only
    writeFileSync(
      runtimePath,
      JSON.stringify({
        pid: process.pid,
        webPort: Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0,
        lsAddress: env.ANTIGRAVITY_LS_ADDRESS,
        csrfToken: env.ANTIGRAVITY_CSRF_TOKEN || '',
      }) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
    try {
      // mode only applies on creation; tighten files written by older versions
      chmodSync(runtimePath, 0o600);
    } catch {
      // ignore (e.g. Windows)
    }
    return true;
  } catch {
    return false;
  }
}

persistSidecarRuntime();

const TOKEN_ALPHABET =
  "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

function sanitizeLoopbackAddress(raw) {
  const parsed = parseLsAddress(raw);
  if (!parsed) return '';
  const host =
    parsed.host === '127.0.0.1'
      ? '127.0.0.1'
      : parsed.host === 'localhost'
        ? 'localhost'
        : parsed.host === '::1'
          ? '[::1]'
          : '';
  if (!host) return '';
  return `${host}:${parsed.port | 0}`;
}

function sanitizeCsrfToken(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return '';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const idx = TOKEN_ALPHABET.indexOf(raw[i]);
    if (idx === -1) return '';
    out += TOKEN_ALPHABET[idx];
  }
  return out;
}

export function readCachedLsCredentials(
  sidecarDataRoot = SIDECAR_DATA_ROOT,
  preferredId = '',
  { lsAddress: matchAddress = '' } = {}
) {
  const candidates = [preferredId, 'hangar', 'context-monitor'].filter(Boolean);
  try {
    if (existsSync(sidecarDataRoot)) {
      for (const entry of readdirSync(sidecarDataRoot)) {
        if (!candidates.includes(entry)) candidates.push(entry);
      }
    }
  } catch {
    // ignore
  }
  const normalizedMatch = matchAddress ? sanitizeLoopbackAddress(matchAddress) || matchAddress : '';
  for (const id of candidates) {
    try {
      const p = join(sidecarDataRoot, id, 'data', 'runtime.json');
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const lsAddress = sanitizeLoopbackAddress(data?.lsAddress);
      const csrfToken = sanitizeCsrfToken(data?.csrfToken);
      if (lsAddress && csrfToken) {
        if (normalizedMatch && lsAddress !== normalizedMatch) continue;
        return { lsAddress, csrfToken };
      }
    } catch {
      // ignore
    }
  }
  return { lsAddress: '', csrfToken: '' };
}

export function getLsConfig(overrides = {}) {
  const env = overrides.env ?? process.env;
  let lsAddress = overrides.lsAddress ?? env.ANTIGRAVITY_LS_ADDRESS ?? '';
  let csrfToken = overrides.csrfToken ?? env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  if ((!lsAddress || !csrfToken) && overrides.lsAddress === undefined) {
    // With a known address, only accept a token cached for that same Language Server
    const cached = readCachedLsCredentials(overrides.sidecarDataRoot, overrides.sidecarId, {
      lsAddress,
    });
    if (!lsAddress) lsAddress = cached.lsAddress;
    if (!csrfToken) csrfToken = cached.csrfToken;
  }
  return { lsAddress, csrfToken };
}

export function findListeningPids(port, { execFn = execFileSync } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) return [];
  try {
    const rawOut =
      process.platform === 'win32'
        ? execFn(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
            ],
            EXEC_OPTS
          )
        : execFn('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], EXEC_OPTS);
    const pids = String(rawOut || '')
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

export function isNodeProcess(pid, { execFn = execFileSync } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    const rawOut =
      process.platform === 'win32'
        ? execFn(
            'powershell.exe',
            ['-NoProfile', '-Command', `(Get-Process -Id ${n} -ErrorAction SilentlyContinue).ProcessName`],
            EXEC_OPTS
          )
        : execFn('ps', ['-p', String(n), '-o', 'comm='], EXEC_OPTS);
    return /(^|[\\/])node(\.exe)?$/i.test(String(rawOut || '').trim());
  } catch {
    return false;
  }
}

export function killSidecarProcessByPortOrPid(
  sidecarId,
  { sidecarDataRoot = SIDECAR_DATA_ROOT, execFn = execFileSync, killFn = process.kill } = {}
) {
  if (!sidecarId) return { restarted: false };
  let runtimePid = 0;
  let port = 0;
  const rt = readJsonSafe(join(sidecarDataRoot, sidecarId, 'data', 'runtime.json'), null);
  if (rt && typeof rt === 'object') {
    if (Number(rt.pid) > 0) runtimePid = Number(rt.pid);
    if (Number(rt.webPort) > 0) port = Number(rt.webPort);
  }

  if (!port) {
    try {
      const logPath = join(sidecarDataRoot, sidecarId, 'logs', 'sidecar.log');
      if (existsSync(logPath)) {
        const text = readFileSync(logPath, 'utf8');
        const matches = [...text.matchAll(/listening on 127\.0\.0\.1:(\d+)/g)];
        if (matches.length > 0) {
          port = Number(matches[matches.length - 1][1]);
        }
      }
    } catch {
      // ignore
    }
  }

  // Never kill on a PID alone: runtime.json outlives the sidecar, and the OS may have
  // reused that PID for an unrelated process (Windows recycles PIDs aggressively).
  if (!port) return { restarted: false };
  const owners = findListeningPids(port, { execFn });

  if (runtimePid) {
    if (!owners.includes(runtimePid)) return { restarted: false, reason: 'stale runtime.json' };
    try {
      killFn(runtimePid, 'SIGTERM');
      return { restarted: true, method: `pid:${runtimePid}` };
    } catch {
      return { restarted: false };
    }
  }

  // Port recovered from the log only: kill just the node processes listening on it
  const killed = [];
  for (const pid of owners) {
    if (!isNodeProcess(pid, { execFn })) continue;
    try {
      killFn(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      // ignore
    }
  }
  if (killed.length > 0) {
    return { restarted: true, method: `port:${port}->pid:${killed.join(',')}` };
  }
  return { restarted: false };
}

export async function callLsRpc(method, body = {}, options = {}) {
  const { lsAddress, csrfToken } = getLsConfig(options);
  if (!lsAddress || !csrfToken) {
    throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
  }

  const fetchImpl = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from LanguageServerService/${method} (HTTP ${res.status})`);
    }
  }

  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(`LanguageServerService/${method} failed: ${msg}`);
  }

  return parsed;
}

/**
 * Opt-in cache in front of callLsRpc. Concurrent calls with the same method and body share one
 * in-flight request, and successful results are kept for that method's TTL. Failures are never
 * cached. Cached results are shared between callers, so treat them as read-only.
 *
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.ttlMs] Per-method TTL in ms; 0 only merges in-flight calls.
 * @param {number} [opts.defaultTtlMs] TTL for methods missing from `ttlMs`.
 * @param {Function} [opts.rpcFn] Underlying call, `(method, body, options) => Promise`.
 * @param {Function} [opts.now] Clock, for tests.
 * @returns {{ call: Function, invalidate: Function }} `invalidate(...methods)` drops those
 *   methods' entries (in flight or cached), or every entry when called with no arguments.
 */
export function createLsRpcCache({ ttlMs = {}, defaultTtlMs = 0, rpcFn = callLsRpc, now = Date.now } = {}) {
  const entries = new Map();

  function call(method, body = {}, options = {}) {
    // One cache line per Language Server; the token, timeout and fetchFn don't change the answer
    const key = `${getLsConfig(options).lsAddress}\n${method}\n${JSON.stringify(body)}`;
    const hit = entries.get(key);
    if (hit && (hit.pending || now() < hit.expiresAt)) return hit.promise;

    const ttl = ttlMs[method] ?? defaultTtlMs;
    const entry = { method, pending: true, expiresAt: 0, promise: null };
    entry.promise = Promise.resolve()
      .then(() => rpcFn(method, body, options))
      .then(
        (result) => {
          // invalidate() ran during the call: keep the stale answer out of the cache
          if (entries.get(key) === entry) {
            entry.pending = false;
            entry.expiresAt = now() + ttl;
            if (ttl <= 0) entries.delete(key);
          }
          return result;
        },
        (err) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw err;
        }
      );
    entries.set(key, entry);
    return entry.promise;
  }

  function invalidate(...methods) {
    if (methods.length === 0) {
      entries.clear();
      return;
    }
    for (const [key, entry] of entries) {
      if (methods.includes(entry.method)) entries.delete(key);
    }
  }

  return { call, invalidate };
}

export const getSidecars = (options = {}) => callLsRpc('GetSidecars', {}, options);
export const manageSidecar = (sidecarId, action, options = {}) =>
  callLsRpc('ManageSidecar', { action, sidecarId }, options);
export const getAllTrajectories = (options = {}) =>
  callLsRpc('GetAllCascadeTrajectories', {}, options);
export const getUserStatus = (options = {}) => callLsRpc('GetUserStatus', {}, options);
