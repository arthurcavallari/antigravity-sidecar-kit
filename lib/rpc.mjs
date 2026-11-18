/**
 * @fileoverview Connect RPC client, runtime credential cache, and process restarter
 * for the local Antigravity Language Server.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJsonSafe, resolveSidecarDataRoot } from './config.mjs';
import { parseLsAddress } from './lifecycle.mjs';
import {
  createConnectFrameAccumulator,
  decodeConnectFrame,
  encodeConnectFrame,
  parseConnectFrames,
} from './binary-stream.mjs';

export {
  createConnectFrameAccumulator,
  decodeConnectFrame,
  encodeConnectFrame,
  parseConnectFrames,
};

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

function parsePluginSidecarPair(rawId = '', env = {}) {
  const clean = String(rawId || '').trim();
  if (!clean) return null;
  if (clean.includes('/')) {
    const [plug, sub] = clean.split('/', 2);
    if (plug && sub) return [plug, sub];
  }
  if (clean.includes('--')) {
    const idx = clean.indexOf('--');
    const plug = clean.slice(0, idx);
    const sub = clean.slice(idx + 2);
    if (plug && sub) return [plug, sub];
  }
  const envPlugin = env?.PLUGIN_NAME ? String(env.PLUGIN_NAME).trim() : '';
  if (envPlugin) return [envPlugin, clean];
  return null;
}

function expandSidecarCandidateDirs(root, sidecarId = '', env = {}) {
  const clean = String(sidecarId || '').trim();
  if (!clean) return [];
  const dirs = [];
  const add = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  const pair = parsePluginSidecarPair(clean, env);
  if (pair) {
    add(join(root, pair[0], pair[1]));
    add(join(root, `${pair[0]}--${pair[1]}`));
  }
  if (!clean.includes('/')) {
    add(join(root, clean));
  }
  return dirs;
}

export function persistSidecarRuntime(
  sidecarId = inferCurrentSidecarId(),
  { sidecarDataRoot, env = process.env } = {}
) {
  if (!sidecarId || !env.ANTIGRAVITY_SIDECAR_WEB_PORT || !env.ANTIGRAVITY_LS_ADDRESS) {
    return false;
  }
  try {
    const effectiveRoot = sidecarDataRoot || resolveSidecarDataRoot(env);
    const pair = parsePluginSidecarPair(sidecarId, env);
    const dir = pair ? join(effectiveRoot, pair[0], pair[1], 'data') : join(effectiveRoot, sidecarId, 'data');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runtimePath = join(dir, 'runtime.json');
    // runtime.json holds the Language Server CSRF token, so keep it owner-only
    writeFileSync(
      runtimePath,
      JSON.stringify({
        pid: process.pid,
        ...(Number(env.ANTIGRAVITY_LAUNCHER_PID) > 0 ? { launcherPid: Number(env.ANTIGRAVITY_LAUNCHER_PID) } : {}),
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

let runtimePersisted = false;

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

export function extractCsrfToken(source) {
  if (typeof source === 'string') {
    const flagMatch = source.match(/--csrf[_-]token(?:=|\s+)["']?([^\s"']+)["']?/i);
    if (flagMatch) return sanitizeCsrfToken(flagMatch[1]);
    return sanitizeCsrfToken(source.trim());
  }
  if (source && typeof source === 'object') {
    const candidate =
      source.csrfToken ??
      source.csrf_token ??
      source.ANTIGRAVITY_CSRF_TOKEN ??
      source.headers?.['x-codeium-csrf-token'] ??
      source.env?.ANTIGRAVITY_CSRF_TOKEN ??
      '';
    return sanitizeCsrfToken(String(candidate));
  }
  return '';
}

export function createSingleFlightPoller(fn, { intervalMs = 2000, unref = true, onError } = {}) {
  let timer = null;
  let inFlight = null;
  let running = false;

  const trigger = () => {
    if (inFlight) return inFlight;
    const p = Promise.resolve()
      .then(() => fn())
      .catch((err) => {
        if (typeof onError === 'function') {
          try {
            onError(err);
          } catch {}
        }
        return undefined;
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  };

  const start = () => {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      if (!inFlight) trigger();
    }, intervalMs);
    if (unref) timer.unref?.();
  };

  const stop = () => {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, trigger, isRunning: () => running };
}

export function isPidAlive(pid, { killFn = process.kill } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    killFn(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function collectSidecarDirsUnderRoot(rootDir, addFn) {
  try {
    if (!rootDir || !existsSync(rootDir)) return;
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const level1 = join(rootDir, entry.name);
      addFn(level1);
      try {
        for (const sub of readdirSync(level1, { withFileTypes: true })) {
          if (!sub.isDirectory() || sub.name === 'data' || sub.name === 'logs') continue;
          addFn(join(level1, sub.name));
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export function listCachedLsCredentials(
  sidecarDataRoot,
  preferredId = '',
  { lsAddress: matchAddress = '', env = process.env, killFn = process.kill } = {}
) {
  const effectiveRoot = sidecarDataRoot || resolveSidecarDataRoot(env);
  const preferredDirs = expandSidecarCandidateDirs(effectiveRoot, preferredId, env);
  const preferredSet = new Set();
  const candidateDirs = [];
  const addDir = (d, isPreferred = false) => {
    if (!d) return;
    if (isPreferred) preferredSet.add(d);
    if (!candidateDirs.includes(d)) candidateDirs.push(d);
  };
  for (const prefDir of preferredDirs) {
    addDir(prefDir, true);
    const legacyPrefRoot = join(prefDir, 'data', 'sidecar_data');
    if (existsSync(legacyPrefRoot)) {
      for (const nestedPref of expandSidecarCandidateDirs(legacyPrefRoot, preferredId, env)) {
        addDir(nestedPref, true);
      }
    }
  }
  collectSidecarDirsUnderRoot(effectiveRoot, (dir) => {
    addDir(dir);
    const legacyNestedRoot = join(dir, 'data', 'sidecar_data');
    if (existsSync(legacyNestedRoot)) {
      collectSidecarDirsUnderRoot(legacyNestedRoot, addDir);
    }
  });
  const normalizedMatch = matchAddress ? sanitizeLoopbackAddress(matchAddress) || matchAddress : '';
  const scored = [];
  for (const baseDir of candidateDirs) {
    try {
      const p = join(baseDir, 'data', 'runtime.json');
      const data = JSON.parse(readFileSync(p, 'utf8'));
      const lsAddress = sanitizeLoopbackAddress(data?.lsAddress);
      const csrfToken = sanitizeCsrfToken(data?.csrfToken);
      if (!lsAddress || !csrfToken) continue;
      if (normalizedMatch && lsAddress !== normalizedMatch) continue;
      const pid = Number(data?.pid) || 0;
      const launcherPid = Number(data?.launcherPid) || 0;
      const hasPid = pid > 0 || launcherPid > 0;
      const live =
        !hasPid ||
        (pid > 0 && isPidAlive(pid, { killFn })) ||
        (launcherPid > 0 && isPidAlive(launcherPid, { killFn }));
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(p).mtimeMs || 0;
      } catch {
        // ignore
      }
      scored.push({
        lsAddress,
        csrfToken,
        live: live ? 1 : 0,
        preferred: preferredSet.has(baseDir) ? 1 : 0,
        mtimeMs,
        order: scored.length,
      });
    } catch {
      // ignore
    }
  }
  scored.sort(
    (a, b) =>
      b.live - a.live ||
      b.preferred - a.preferred ||
      b.mtimeMs - a.mtimeMs ||
      a.order - b.order
  );
  const seen = new Set();
  const out = [];
  for (const item of scored) {
    const key = `${item.lsAddress}\n${item.csrfToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lsAddress: item.lsAddress, csrfToken: item.csrfToken });
  }
  return out;
}

export function readCachedLsCredentials(
  sidecarDataRoot,
  preferredId = '',
  opts = {}
) {
  return listCachedLsCredentials(sidecarDataRoot, preferredId, opts)[0] ?? { lsAddress: '', csrfToken: '' };
}

function isRunCommandAgentEnv(env) {
  return Boolean(
    env &&
      String(env.ANTIGRAVITY_AGENT || '') === '1' &&
      !env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
      !env.ANTIGRAVITY_SIDECAR_ID
  );
}

export function getLsConfig(overrides = {}) {
  if (
    !runtimePersisted &&
    !overrides.env &&
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
    process.env.ANTIGRAVITY_LS_ADDRESS
  ) {
    runtimePersisted = true;
    persistSidecarRuntime();
  }
  const env = overrides.env ?? process.env;
  const effectiveRoot = overrides.sidecarDataRoot || resolveSidecarDataRoot(env);
  const killOpts = overrides.killFn ? { killFn: overrides.killFn } : {};
  if (
    isRunCommandAgentEnv(env) &&
    overrides.lsAddress === undefined &&
    overrides.csrfToken === undefined &&
    !overrides.allowAgentGateway
  ) {
    const samePort = env.ANTIGRAVITY_LS_ADDRESS
      ? readCachedLsCredentials(effectiveRoot, overrides.sidecarId, {
          lsAddress: env.ANTIGRAVITY_LS_ADDRESS,
          env,
          ...killOpts,
        })
      : { lsAddress: '', csrfToken: '' };
    if (samePort.lsAddress && samePort.csrfToken) return samePort;
    const cachedSidecar = readCachedLsCredentials(effectiveRoot, overrides.sidecarId, {
      env,
      ...killOpts,
    });
    if (cachedSidecar.lsAddress && cachedSidecar.csrfToken) return cachedSidecar;
  }
  let lsAddress = overrides.lsAddress ?? env.ANTIGRAVITY_LS_ADDRESS ?? '';
  let csrfToken = overrides.csrfToken ?? env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  if ((!lsAddress || !csrfToken) && overrides.lsAddress === undefined) {
    // With a known address, only accept a token cached for that same Language Server
    const cached = readCachedLsCredentials(effectiveRoot, overrides.sidecarId, {
      lsAddress,
      env,
      ...killOpts,
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

export function killPidAndWait(
  pid,
  { platform = process.platform, execFn = execFileSync, killFn = process.kill } = {}
) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (platform === 'win32' && killFn === process.kill) {
    try {
      execFn('taskkill', ['/T', '/F', '/PID', String(n)], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      // Fall back to killFn
    }
  }
  killFn(n, 'SIGTERM');
  return true;
}

export function killSidecarProcessByPortOrPid(
  sidecarId,
  { sidecarDataRoot, env = process.env, execFn = execFileSync, killFn = process.kill, platform = process.platform } = {}
) {
  if (!sidecarId) return { restarted: false };
  const effectiveRoot = sidecarDataRoot || resolveSidecarDataRoot(env);
  const candidateDirs = [...expandSidecarCandidateDirs(effectiveRoot, sidecarId, env)];
  for (const baseDir of [...candidateDirs]) {
    const legacyRoot = join(baseDir, 'data', 'sidecar_data');
    if (existsSync(legacyRoot)) {
      for (const nested of expandSidecarCandidateDirs(legacyRoot, sidecarId, env)) {
        if (!candidateDirs.includes(nested)) candidateDirs.push(nested);
      }
    }
  }
  let runtimePid = 0;
  let launcherPid = 0;
  let port = 0;
  for (const baseDir of candidateDirs) {
    const rt = readJsonSafe(join(baseDir, 'data', 'runtime.json'), null);
    if (rt && typeof rt === 'object') {
      if (Number(rt.pid) > 0) runtimePid = Number(rt.pid);
      if (Number(rt.launcherPid) > 0) launcherPid = Number(rt.launcherPid);
      if (Number(rt.webPort) > 0) port = Number(rt.webPort);
      if (port || runtimePid) break;
    }
  }

  if (!port) {
    for (const baseDir of candidateDirs) {
      try {
        const logPath = join(baseDir, 'logs', 'sidecar.log');
        if (existsSync(logPath)) {
          const text = readFileSync(logPath, 'utf8');
          const matches = [...text.matchAll(/listening on 127\.0\.0\.1:(\d+)/g)];
          if (matches.length > 0) {
            port = Number(matches[matches.length - 1][1]);
            break;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Never kill on a PID alone: runtime.json outlives the sidecar, and the OS may have
  // reused that PID for an unrelated process (Windows recycles PIDs aggressively).
  if (!port) return { restarted: false };
  const owners = findListeningPids(port, { execFn });

  if (runtimePid) {
    if (!owners.includes(runtimePid)) return { restarted: false, reason: 'stale runtime.json' };
    try {
      if (launcherPid > 0 && launcherPid !== runtimePid && isNodeProcess(launcherPid, { execFn })) {
        try { killPidAndWait(launcherPid, { platform, execFn, killFn }); } catch {}
      }
      killPidAndWait(runtimePid, { platform, execFn, killFn });
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
      killPidAndWait(pid, { platform, execFn, killFn });
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

function computeFallbackCredentials(primary, options = {}) {
  if (Array.isArray(options._fallbackQueue)) return options._fallbackQueue;
  if (options.lsAddress !== undefined || options.csrfToken !== undefined || options.allowAgentGateway) {
    return [];
  }
  const env = options.env ?? process.env;
  const agentEnv = isRunCommandAgentEnv(env);
  if (!agentEnv && env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    return [];
  }
  const effectiveRoot = options.sidecarDataRoot || resolveSidecarDataRoot(env);
  const matchAddr = !agentEnv && env.ANTIGRAVITY_LS_ADDRESS ? env.ANTIGRAVITY_LS_ADDRESS : '';
  const cached = listCachedLsCredentials(effectiveRoot, options.sidecarId, {
    lsAddress: matchAddr,
    env,
    ...(options.killFn ? { killFn: options.killFn } : {}),
  });
  const queue = [];
  const seen = new Set([`${primary.lsAddress}\n${primary.csrfToken}`]);
  const push = (lsAddress, csrfToken, isAgentGateway = false) => {
    if (!lsAddress || !csrfToken) return;
    const key = `${lsAddress}\n${csrfToken}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ lsAddress, csrfToken, isAgentGateway });
  };
  for (const c of cached) push(c.lsAddress, c.csrfToken, false);
  if (agentEnv && env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    const gwAddr = sanitizeLoopbackAddress(env.ANTIGRAVITY_LS_ADDRESS) || env.ANTIGRAVITY_LS_ADDRESS;
    const gwTok = sanitizeCsrfToken(String(env.ANTIGRAVITY_CSRF_TOKEN));
    push(gwAddr, gwTok, true);
  }
  return queue;
}

export async function callLsRpc(method, body = {}, options = {}) {
  const { lsAddress, csrfToken } = getLsConfig(options);
  if (!lsAddress || !csrfToken) {
    throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
  }

  const fallbackQueue = computeFallbackCredentials({ lsAddress, csrfToken }, options);
  const fetchImpl = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`;

  let res;
  try {
    const reqSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
      },
      body: JSON.stringify(body),
      signal: reqSignal,
    });
  } catch (err) {
    if (fallbackQueue.length > 0 && !options.signal?.aborted) {
      const [next, ...rest] = fallbackQueue;
      return callLsRpc(method, body, {
        ...options,
        lsAddress: next.lsAddress,
        csrfToken: next.csrfToken,
        ...(next.isAgentGateway ? { allowAgentGateway: true } : {}),
        _fallbackQueue: rest,
        _retriedCredentials: true,
      });
    }
    throw err;
  }

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
    if (
      !options._retriedPermissionDenied &&
      options.allowAgentGateway &&
      /permission[_ ]denied/i.test(`${parsed?.code || ''} ${msg}`)
    ) {
      const env = options.env ?? process.env;
      const cached = readCachedLsCredentials(options.sidecarDataRoot, options.sidecarId, {
        env,
        ...(options.killFn ? { killFn: options.killFn } : {}),
      });
      if (cached.lsAddress && cached.csrfToken && cached.csrfToken !== csrfToken) {
        return callLsRpc(method, body, {
          ...options,
          lsAddress: cached.lsAddress,
          csrfToken: cached.csrfToken,
          _fallbackQueue: [],
          _retriedCredentials: true,
          _retriedPermissionDenied: true,
        });
      }
    }
    throw new Error(`LanguageServerService/${method} failed: ${msg}`);
  }

  return parsed;
}

export async function callLsStreamRpc(method, body = {}, options = {}) {
  const { lsAddress, csrfToken } = getLsConfig(options);
  if (!lsAddress || !csrfToken) {
    throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
  }

  const fallbackQueue = computeFallbackCredentials({ lsAddress, csrfToken }, options);
  const fetchImpl = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFrames = options.maxFrames ?? Infinity;
  const idleTimeoutMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 0;
  const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`;

  const controller = new AbortController();
  let stoppedEarly = false;
  let timedOut = false;
  let idleTimer = null;

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        stoppedEarly = true;
        controller.abort();
      }, idleTimeoutMs);
    }
  };
  const hardTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let cleanedUp = false;
  const cleanupTimersAndSignal = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(hardTimer);
    clearIdle();
    options.signal?.removeEventListener?.('abort', onExternalAbort);
  };

  const frames = [];
  let permissionDeniedBeforeFrames = false;

  const processConnectFrames = (batch) => {
    for (const frame of batch) {
      let parsed = frame.data;
      if (typeof parsed === 'string') {
        if (!parsed.trim()) parsed = {};
        else throw new Error(`Invalid Connect JSON frame from LanguageServerService/${method}`);
      } else if (Buffer.isBuffer(parsed) || parsed instanceof Uint8Array) {
        if (parsed.byteLength === 0) parsed = {};
        else throw new Error(`Invalid Connect JSON frame from LanguageServerService/${method}`);
      } else if (!parsed || typeof parsed !== 'object') {
        parsed = {};
      }
      if ((frame.flags & 0x02) !== 0) {
        if (parsed?.error) {
          const msg = parsed.error.message || parsed.error.code || 'stream error';
          if (
            frames.length === 0 &&
            !options._retriedPermissionDenied &&
            options.allowAgentGateway &&
            /permission[_ ]denied/i.test(`${parsed.error.code || ''} ${msg}`)
          ) {
            permissionDeniedBeforeFrames = true;
          }
          throw new Error(`LanguageServerService/${method} failed: ${msg}`);
        }
        stoppedEarly = true;
        controller.abort();
        return true;
      }
      frames.push(parsed);
      if (typeof options.onFrame === 'function') {
        options.onFrame(parsed, frames.length - 1);
      }
      if (frames.length >= maxFrames || options.shouldStop?.(parsed, frames)) {
        stoppedEarly = true;
        controller.abort();
        return true;
      }
      armIdle();
    }
    return false;
  };

  let reader = null;
  let fetchFailedPreResponse = false;
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
        },
        body: encodeConnectFrame(body, 0),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      fetchFailedPreResponse = true;
      throw fetchErr;
    }

    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      let parsed = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // ignore non-JSON HTTP error body
        }
      }
      const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
      if (
        !options._retriedPermissionDenied &&
        options.allowAgentGateway &&
        /permission[_ ]denied/i.test(`${parsed?.code || ''} ${msg}`)
      ) {
        permissionDeniedBeforeFrames = true;
      }
      throw new Error(`LanguageServerService/${method} failed: ${msg}`);
    }

    const accumulator = createConnectFrameAccumulator();
    if (res.body && typeof res.body.getReader === 'function') {
      reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (processConnectFrames(accumulator.push(chunk))) break;
        }
      }
    } else if (typeof res.arrayBuffer === 'function') {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 0) {
        processConnectFrames(accumulator.push(new Uint8Array(ab)));
      }
    }
    return frames;
  } catch (err) {
    if (stoppedEarly) return frames;
    if (timedOut) {
      if (frames.length > 0 && options.returnPartialOnTimeout) return frames;
      throw new Error(`LanguageServerService/${method} timed out after ${timeoutMs}ms`);
    }
    if (
      fetchFailedPreResponse &&
      frames.length === 0 &&
      fallbackQueue.length > 0 &&
      !options.signal?.aborted
    ) {
      cleanupTimersAndSignal();
      const [next, ...rest] = fallbackQueue;
      return callLsStreamRpc(method, body, {
        ...options,
        lsAddress: next.lsAddress,
        csrfToken: next.csrfToken,
        ...(next.isAgentGateway ? { allowAgentGateway: true } : {}),
        _fallbackQueue: rest,
        _retriedCredentials: true,
      });
    }
    if (permissionDeniedBeforeFrames && frames.length === 0 && !options.signal?.aborted) {
      const env = options.env ?? process.env;
      const cached = readCachedLsCredentials(options.sidecarDataRoot, options.sidecarId, {
        env,
        ...(options.killFn ? { killFn: options.killFn } : {}),
      });
      if (cached.lsAddress && cached.csrfToken && cached.csrfToken !== csrfToken) {
        cleanupTimersAndSignal();
        return callLsStreamRpc(method, body, {
          ...options,
          lsAddress: cached.lsAddress,
          csrfToken: cached.csrfToken,
          _fallbackQueue: [],
          _retriedCredentials: true,
          _retriedPermissionDenied: true,
        });
      }
    }
    throw err;
  } finally {
    cleanupTimersAndSignal();
    try {
      await reader?.cancel?.();
    } catch {
      // ignore
    }
  }
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
  callLsRpc('ManageSidecar', { action, sidecarId, ...(options.payload || {}) }, options);
export async function getSidecarLogs(sidecarId, options = {}) {
  const tailLines = options.tailLines ?? options.maxLines;
  const logFilename = options.logFilename ?? options.logFileName;
  const frames = await callLsStreamRpc(
    'GetSidecarLogs',
    {
      sidecarId,
      ...(tailLines !== undefined ? { tailLines } : {}),
      ...(logFilename !== undefined ? { logFilename } : {}),
    },
    {
      ...options,
      maxFrames: options.maxFrames ?? (options.follow ? Infinity : 1),
    }
  );
  if (frames.length === 0) return { logs: '' };
  return {
    ...frames[0],
    logs: frames.map((f) => f?.logs ?? '').join(''),
  };
}
export const getSidecarEvents = (sidecarId, options = {}) =>
  callLsRpc('GetSidecarEvents', { sidecarId }, options);
export const listSidecarLogFiles = (sidecarId, options = {}) =>
  callLsRpc('ListSidecarLogFiles', { sidecarId }, options);
export function resolveSidecarConfig(sidecarIdOrOpts, options = {}) {
  const isObj = Boolean(sidecarIdOrOpts && typeof sidecarIdOrOpts === 'object');
  const merged = isObj ? { ...options, ...sidecarIdOrOpts } : options;
  const sidecarId = isObj ? String(merged.sidecarId || '') : String(sidecarIdOrOpts || '');
  const argumentValues = merged.argumentValues;
  return callLsRpc(
    'ResolveSidecarConfig',
    {
      sidecarId,
      ...(argumentValues && typeof argumentValues === 'object' ? { argumentValues } : {}),
    },
    merged
  );
}
export const getAllTrajectories = (options = {}) =>
  callLsRpc('GetAllCascadeTrajectories', {}, options);

export async function getTrajectorySummaries(options = {}) {
  const batchSize = options.batchSize ?? 100;
  const frames = await callLsStreamRpc(
    'JetboxSubscribeToSummaries',
    {},
    {
      ...options,
      idleTimeoutMs: options.idleTimeoutMs ?? 120,
      shouldStop:
        options.shouldStop ||
        ((frame) => {
          const updates = frame?.updates;
          const count = updates && typeof updates === 'object' ? Object.keys(updates).length : 0;
          return count < batchSize;
        }),
    }
  );
  const trajectorySummaries = {};
  const deletes = [];
  for (const frame of frames) {
    if (frame?.updates && typeof frame.updates === 'object') {
      Object.assign(trajectorySummaries, frame.updates);
    }
    if (Array.isArray(frame?.deletes)) {
      for (const delId of frame.deletes) {
        delete trajectorySummaries[delId];
        deletes.push(delId);
      }
    }
  }
  return { trajectorySummaries, deletes };
}

export const getUserStatus = (options = {}) => callLsRpc('GetUserStatus', {}, options);

export function resolveBrowserWsUrl(options = {}) {
  const env = options.env || process.env;
  const direct = String(options.wsUrl ?? env.AGY_BROWSER_WS_URL ?? '').trim();
  if (direct) return direct;
  const portFile = String(options.activePortFile ?? env.AGY_BROWSER_ACTIVE_PORT_FILE ?? '').trim();
  if (!portFile || !existsSync(portFile)) return '';
  try {
    const lines = readFileSync(portFile, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return '';
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return '';
    const rawPath = lines[1] || '/devtools/browser';
    const wsPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const host = String(options.host || '127.0.0.1').trim();
    return `ws://${host}:${port}${wsPath}`;
  } catch {
    return '';
  }
}
