/**
 * @fileoverview Resolves the Antigravity (`agy`) CLI executable across `~/.gemini/bin/agy` and `PATH`,
 * picking the higher semver and isolating `--version` / `validate` probes in a temporary home directory.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeLinkOrDir } from '../setup.mjs';

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

/**
 * Parses a `[major, minor, patch]` semver tuple from `agy --version` output.
 *
 * @param {string} rawOutput
 * @returns {[number, number, number] | null}
 */
export function parseAgySemver(rawOutput) {
  if (typeof rawOutput !== 'string') return null;
  const match = SEMVER_RE.exec(rawOutput);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares two 3-number semver tuples (`< 0`, `0`, `> 0`).
 *
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function extractEnvPath(env = process.env) {
  if (!env || typeof env !== 'object') return '';
  let value = '';
  for (const [k, v] of Object.entries(env)) {
    if (/^path$/i.test(k) && typeof v === 'string') {
      value = v;
    }
  }
  return value;
}

export function normalizeChildEnv(baseEnv = process.env, overrides = {}, platform = process.platform) {
  const next = {};
  const pathVal = extractEnvPath(
    overrides && Object.keys(overrides).some((k) => /^path$/i.test(k)) ? overrides : baseEnv
  );
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (/^path$/i.test(k) || v === undefined) continue;
    next[k] = String(v);
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (/^path$/i.test(k) || v === undefined) continue;
    next[k] = String(v);
  }
  const pathKey = platform === 'win32' ? 'Path' : 'PATH';
  next[pathKey] = pathVal;
  if (platform === 'win32') {
    if (!next.SystemRoot && process.env.SystemRoot) {
      next.SystemRoot = process.env.SystemRoot;
    }
    if (!next.ComSpec && process.env.ComSpec) {
      next.ComSpec = process.env.ComSpec;
    }
  }
  return next;
}

function quoteWinCmdArg(arg) {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) {
    throw new Error(`Invalid control character in command argument: ${JSON.stringify(s)}`);
  }
  return `"${s.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

function hasNodeShebang(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(128);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const firstLine = head.split(/\r?\n/, 1)[0] || '';
    return firstLine.startsWith('#!') && /\bnode\b/i.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

export function spawnResolvedExecutable(execPath, args, options = {}, platform = process.platform) {
  const fullExec = resolve(execPath);
  if (/\.m?js$/i.test(fullExec)) {
    return spawnSync(process.execPath, [fullExec, ...args], options);
  }
  if (platform === 'win32') {
    if (/\.(?:cmd|bat)$/i.test(fullExec)) {
      const comspec = options?.env?.ComSpec || process.env.ComSpec || 'cmd.exe';
      const cmdLine = `"${[fullExec, ...args].map(quoteWinCmdArg).join(' ')}"`;
      return spawnSync(comspec, ['/d', '/s', '/c', cmdLine], {
        ...options,
        windowsVerbatimArguments: true,
      });
    }
    if (!/\.(?:exe|com)$/i.test(fullExec) && hasNodeShebang(fullExec)) {
      return spawnSync(process.execPath, [fullExec, ...args], options);
    }
  }
  return spawnSync(fullExec, args, options);
}

/**
 * Runs an `agy` command in an isolated temporary `HOME`/`USERPROFILE` so probes and validations
 * never mutate the user's real `~/.gemini` state.
 */
export function spawnAgyIsolated(
  agyPath,
  args,
  { env = process.env, platform = process.platform, timeout = 30_000 } = {}
) {
  const tempHome = mkdtempSync(join(tmpdir(), 'agy-cli-probe-'));
  try {
    const childEnv = normalizeChildEnv(
      env,
      {
        HOME: tempHome,
        USERPROFILE: tempHome,
        APPDATA: join(tempHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(tempHome, 'AppData', 'Local'),
        XDG_CONFIG_HOME: join(tempHome, '.config'),
        ANTIGRAVITY_APP_DATA_DIR: join(tempHome, '.gemini', 'antigravity'),
        NO_COLOR: '1',
      },
      platform
    );
    return spawnResolvedExecutable(
      agyPath,
      args,
      {
        env: childEnv,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      },
      platform
    );
  } finally {
    removeLinkOrDir(tempHome);
  }
}

function isRegularFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function findInDirectory(dir, names) {
  if (!dir) return null;
  for (const name of names) {
    const full = join(dir, name);
    if (isRegularFile(full)) return full;
  }
  return null;
}

function probeCandidate(candidatePath, { env, platform }) {
  const run = spawnAgyIsolated(candidatePath, ['--version'], {
    env,
    platform,
    timeout: 15_000,
  });
  if (!run || run.error || run.status !== 0) {
    return null;
  }
  const combined = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim();
  return {
    path: candidatePath,
    semver: parseAgySemver(combined),
  };
}

/**
 * Resolves the best available `agy` executable across `~/.gemini/bin/agy` and `PATH`.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   explicitPath?: string,
 *   platform?: NodeJS.Platform,
 * }} [options]
 * @returns {{ path: string | null, semver: [number, number, number] | null }}
 */
export function resolveAgyExecutable({
  env = process.env,
  explicitPath = '',
  platform = process.platform,
} = {}) {
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
  const pathDelim = platform === 'win32' ? ';' : ':';
  const rawPath = extractEnvPath(env);
  const pathDirs = rawPath
    .split(pathDelim)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean);

  const trimmedExplicit =
    (typeof explicitPath === 'string' && explicitPath.trim()) ||
    (typeof env?.AGY_BIN === 'string' && env.AGY_BIN.trim()) ||
    '';

  if (trimmedExplicit) {
    let target = null;
    if (isRegularFile(trimmedExplicit)) {
      target = resolve(trimmedExplicit);
    } else if (!trimmedExplicit.includes('/') && !trimmedExplicit.includes('\\')) {
      const bareCandidates =
        platform === 'win32' && !/\.(?:exe|cmd|bat|com|m?js)$/i.test(trimmedExplicit)
          ? ['.exe', '.cmd', '.bat', ''].map((ext) => `${trimmedExplicit}${ext}`)
          : [trimmedExplicit];
      for (const dir of pathDirs) {
        const match = findInDirectory(dir, bareCandidates);
        if (match) {
          target = match;
          break;
        }
      }
    }
    if (!target) return { path: null, semver: null };
    const probed = probeCandidate(target, { env, platform });
    return probed || { path: null, semver: null };
  }

  const homeBase =
    platform === 'win32'
      ? env?.USERPROFILE || env?.HOME || homedir()
      : env?.HOME || env?.USERPROFILE || homedir();

  const geminiCandidate = findInDirectory(join(homeBase, '.gemini', 'bin'), names);
  const geminiReal = geminiCandidate ? safeRealpath(geminiCandidate) : '';

  let pathCandidate = null;
  for (const dir of pathDirs) {
    const match = findInDirectory(dir, names);
    if (!match) continue;
    if (geminiReal && safeRealpath(match) === geminiReal) continue;
    pathCandidate = match;
    break;
  }

  const geminiRes = geminiCandidate ? probeCandidate(geminiCandidate, { env, platform }) : null;
  const pathRes = pathCandidate ? probeCandidate(pathCandidate, { env, platform }) : null;

  if (geminiRes && pathRes) {
    if (geminiRes.semver && pathRes.semver) {
      return compareSemver(pathRes.semver, geminiRes.semver) > 0 ? pathRes : geminiRes;
    }
    if (pathRes.semver && !geminiRes.semver) return pathRes;
    return geminiRes;
  }

  return geminiRes || pathRes || { path: null, semver: null };
}
