/**
 * @fileoverview OS-aware Antigravity paths and UTF-8 BOM-safe JSON config helpers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GLOBAL_CONFIG_DIR = join(homedir(), '.gemini', 'config');
export const GLOBAL_SIDECARS_DIR = join(GLOBAL_CONFIG_DIR, 'sidecars');
export const CONFIG_JSON_PATH = join(GLOBAL_CONFIG_DIR, 'config.json');
export const DEFAULT_CONFIG_PATH = CONFIG_JSON_PATH;

export const APP_STORAGE_PATH =
  process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'app_storage.json');

export const HANGAR_DATA_DIR =
  process.env.HANGAR_DATA_DIR ||
  process.env.SIDECAR_HUB_DATA_DIR ||
  join(homedir(), '.gemini', 'hangar');
export const HANGAR_PACKAGES_DIR = join(HANGAR_DATA_DIR, 'packages');
export const SIDECAR_DATA_ROOT = join(homedir(), '.gemini', 'antigravity', 'sidecar_data');

export function readJsonSafe(filePath, fallback = {}, options = {}) {
  const strict = Boolean(options?.strict);
  if (!filePath || !existsSync(filePath)) return structuredClone(fallback);
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return structuredClone(fallback);
    const parsed = JSON.parse(raw);
    if (strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`Invalid JSON object in ${filePath}`);
    }
    return parsed;
  } catch (err) {
    if (strict) throw err;
    return structuredClone(fallback);
  }
}

export function readJsonFile(filePath, { strict = false, fallback = {} } = {}) {
  const res = readJsonSafe(filePath, fallback, { strict });
  return res && typeof res === 'object' ? res : structuredClone(fallback);
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes JSON without a BOM via temp file + rename, so readers (including Antigravity
 * itself for config.json) never observe a truncated or half-written file.
 */
export function writeJsonNoBom(filePath, data) {
  let target = filePath;
  try {
    // Write through symlinked files instead of replacing the link
    target = realpathSync(filePath);
  } catch {
    // does not exist yet
  }
  mkdirSync(dirname(target), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${target}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmpPath, target);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= 3) break;
      // Windows: another process may briefly hold the file open
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    writeFileSync(target, content, 'utf8');
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export const writeJsonFile = writeJsonNoBom;

/**
 * Safely updates a sidecar entry in ~/.gemini/config/config.json without clobbering
 * malformed JSON files and always preserving sidecars[sidecarId].projectId.
 */
export function updateAgySidecarConfig(
  sidecarId,
  patchOrEnabled = true,
  configPath = CONFIG_JSON_PATH,
  { createIfMissing = false } = {}
) {
  if (!sidecarId || !configPath) return false;
  const fileExists = existsSync(configPath);
  if (!fileExists && !createIfMissing) return false;

  let cfg = {};
  if (fileExists) {
    try {
      cfg = readJsonSafe(configPath, {}, { strict: true });
    } catch {
      // Never clobber a malformed config.json
      return false;
    }
  }

  if (!cfg.sidecars || typeof cfg.sidecars !== 'object' || Array.isArray(cfg.sidecars)) {
    cfg.sidecars = {};
  }

  const patch =
    typeof patchOrEnabled === 'boolean'
      ? { enabled: patchOrEnabled }
      : patchOrEnabled && typeof patchOrEnabled === 'object'
        ? patchOrEnabled
        : { enabled: Boolean(patchOrEnabled) };

  const existing =
    cfg.sidecars[sidecarId] && typeof cfg.sidecars[sidecarId] === 'object'
      ? cfg.sidecars[sidecarId]
      : {};

  cfg.sidecars[sidecarId] = {
    ...existing,
    ...patch,
  };
  writeJsonNoBom(configPath, cfg);
  return true;
}
