/**
 * @fileoverview Connect RPC client, runtime credential cache, and process restarter
 * for the local Antigravity Language Server.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SIDECAR_DATA_ROOT, readJsonSafe } from './config.mjs';

const DEFAULT_TIMEOUT_MS = 4000;

function inferCurrentSidecarId() {
  if (process.env.ANTIGRAVITY_SIDECAR_ID) return String(process.env.ANTIGRAVITY_SIDECAR_ID).trim();
  try {
    const entryDir = process.argv[1] ? dirname(process.argv[1]) : process.cwd();
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({
        pid: process.pid,
        webPort: Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0,
        lsAddress: env.ANTIGRAVITY_LS_ADDRESS,
        csrfToken: env.ANTIGRAVITY_CSRF_TOKEN || '',
      }) + '\n',
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

persistSidecarRuntime();

export function readCachedLsCredentials(sidecarDataRoot = SIDECAR_DATA_ROOT, preferredId = '') {
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
  for (const id of candidates) {
    try {
      const p = join(sidecarDataRoot, id, 'data', 'runtime.json');
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data?.lsAddress && data?.csrfToken) {
        return { lsAddress: String(data.lsAddress), csrfToken: String(data.csrfToken) };
      }
    } catch {
      // ignore
    }
  }
  return { lsAddress: '', csrfToken: '' };
}

export function getLsConfig(overrides = {}) {
  let lsAddress = overrides.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? '';
  let csrfToken = overrides.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';
  if ((!lsAddress || !csrfToken) && overrides.lsAddress === undefined) {
    const cached = readCachedLsCredentials(overrides.sidecarDataRoot, overrides.sidecarId);
    if (!lsAddress) lsAddress = cached.lsAddress;
    if (!csrfToken) csrfToken = cached.csrfToken;
  }
  return { lsAddress, csrfToken };
}

export function killSidecarProcessByPortOrPid(
  sidecarId,
  { sidecarDataRoot = SIDECAR_DATA_ROOT, execFn = execFileSync, killFn = process.kill } = {}
) {
  if (!sidecarId) return { restarted: false };
  let port = 0;
  try {
    const rtPath = join(sidecarDataRoot, sidecarId, 'data', 'runtime.json');
    if (existsSync(rtPath)) {
      const rt = JSON.parse(readFileSync(rtPath, 'utf8'));
      if (rt?.pid && Number(rt.pid) > 0 && Number(rt.pid) !== process.pid) {
        try {
          killFn(Number(rt.pid), 'SIGTERM');
          return { restarted: true, method: `pid:${rt.pid}` };
        } catch {
          // Process already exited; fall through to log port check
        }
      }
      if (rt?.webPort) port = Number(rt.webPort);
    }
  } catch {
    // ignore
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

  if (!port) return { restarted: false };

  try {
    const rawOut =
      process.platform === 'win32'
        ? execFn(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          )
        : execFn('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
    const pids = String(rawOut || '')
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          killFn(pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
      return { restarted: true, method: `port:${port}->pid:${pids.join(',')}` };
    }
  } catch {
    // ignore
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

export const getSidecars = (options = {}) => callLsRpc('GetSidecars', {}, options);
export const manageSidecar = (sidecarId, action, options = {}) =>
  callLsRpc('ManageSidecar', { action, sidecarId }, options);
export const getAllTrajectories = (options = {}) =>
  callLsRpc('GetAllCascadeTrajectories', {}, options);
export const getUserStatus = (options = {}) => callLsRpc('GetUserStatus', {}, options);
