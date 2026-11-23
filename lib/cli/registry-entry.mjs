/**
 * @fileoverview Hangar `registry.json` entry builder, schema validator, capability tier inference,
 * safe registry file upserter, and automated GitHub PR helper (`agy-sidecar-kit registry-entry`).
 */

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../config.mjs';
import { normalizeGithubOwner } from '../scaffolder/base-layer.mjs';
import { resolveProjectNames, toDisplayName } from '../scaffolder/naming.mjs';
import { KIT_ROOT, removeLinkOrDir } from '../setup.mjs';
import { buildPluginProject } from './build-plugin.mjs';

export const TIERS = Object.freeze([
  'TIER_1_TELEMETRY',
  'TIER_2_LOCAL_TOOLING',
  'TIER_3_AGENT_CONTROL',
]);

const TIERS_SET = new Set(TIERS);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;
const SIDECAR_ID = /^[a-z0-9][a-z0-9_-]*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const RESERVED_IDS = new Set(['hangar', 'sidecar-hub']);
const KINDS = new Set(['sidecar', 'plugin']);
const PORT_SOURCES = new Set(['claude', 'gemini', 'cursor', 'roo', 'codex', 'auto']);
const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const SHORT_SHA = /^[0-9a-f]{7,39}$/i;
const SPDX = /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;
const HANGAR_REPO_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9][a-z0-9._-]*$/i;

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const CODE_SCAN_EXT = /\.(?:m?[jt]sx?|cjs|cts|py|html)$/i;
const DOCS_SKIP_PATH = /^(?:\.[^/]+\/)?(?:skills|rules|agents|commands)\//i;
const MAX_CODE_SCAN_BYTES = 5_000_000;

const MCP_APP_MARKERS = [
  /\bui:\/\/[a-z0-9._-]+/i,
  /text\/html\s*;\s*profile=mcp-app/i,
  /@modelcontextprotocol\/ext-apps/,
];

const MCP_APP_MESSAGE_MARKERS = [/\bui\/message\b/, /com\.google\.antigravity\/message/];

const SIDECAR_AGENT_CONTROL_MARKERS = [
  /\bsidecar(?:\?\.|\.)agent(?:\?\.|\.)(?:sendMessage|startConversation|newConversation)\b/,
  /['"](?:SendUserCascadeMessage|StartCascade)['"]/,
  /['"](?:send-message|new-conversation)['"]|\bagentapi\s+(?:send-message|new-conversation)\b/,
];

const TRUSTED_SIDECAR_DEPS = new Set(['antigravity-sidecar-kit', 'sidecar_sdk']);
const LIFECYCLE_INSTALL_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isRelativeInside(p) {
  return (
    isNonEmptyString(p) && !/^[\\/]|^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..')
  );
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isWithinRoot(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readJsonChecked(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false, valid: true, value: null };
  }
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) {
      return { exists: true, valid: false, value: null };
    }
    return { exists: true, valid: true, value: JSON.parse(raw) };
  } catch {
    return { exists: true, valid: false, value: null };
  }
}

function extractServerMap(obj) {
  if (!isPlainObject(obj)) return {};
  if (isPlainObject(obj.mcpServers)) return obj.mcpServers;
  const map = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (
      !k.startsWith('$') &&
      k !== '__proto__' &&
      k !== 'constructor' &&
      k !== 'prototype' &&
      !['version', 'description', 'name'].includes(k) &&
      isPlainObject(v) &&
      ('command' in v || 'url' in v || 'httpUrl' in v || 'serverUrl' in v)
    ) {
      map[k] = v;
    }
  }
  return map;
}

function collectHookEvents(obj, events, commandStrings = []) {
  if (!isPlainObject(obj)) return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'enabled' || k === 'description' || k === 'modules') continue;
    if (Array.isArray(v)) {
      events.add(k);
      for (const item of v) {
        if (isPlainObject(item)) {
          if (typeof item.command === 'string') commandStrings.push(item.command);
          if (Array.isArray(item.hooks)) {
            for (const sub of item.hooks) {
              if (isPlainObject(sub) && typeof sub.command === 'string') {
                commandStrings.push(sub.command);
              }
            }
          }
        }
      }
    } else if (isPlainObject(v)) {
      collectHookEvents(v, events, commandStrings);
    }
  }
}

function pathTokenEscapesRoot(rawToken, resolvedPluginRoot) {
  if (typeof rawToken !== 'string' || !rawToken.trim()) return false;
  const trimmed = rawToken.trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!trimmed) return false;
  const rootVarMatch = trimmed.match(/^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}[\\/]?(.*)$/);
  if (rootVarMatch) {
    const sub = rootVarMatch[1] || '.';
    const target = resolve(resolvedPluginRoot, sub);
    return !isWithinRoot(resolvedPluginRoot, target);
  }
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) {
    const target = resolve(resolvedPluginRoot, trimmed);
    return !isWithinRoot(resolvedPluginRoot, target);
  }
  return false;
}

function walkPluginFiles(resolvedPluginRoot, realPluginRoot) {
  const files = [];
  const seenRealFiles = new Set();
  const symlinkIssues = [];

  const visit = (dir, relPrefix, activeDirs) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.git') continue;
      const full = join(dir, entry);
      const relPosix = relPrefix ? `${relPrefix}/${entry}` : entry;
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let targetReal = '';
        try {
          targetReal = realpathSync.native(full);
        } catch {
          symlinkIssues.push(`symlink "${relPosix}" is dangling or unresolvable`);
          continue;
        }
        if (!isWithinRoot(realPluginRoot, targetReal)) {
          symlinkIssues.push(
            `symlink "${relPosix}" points outside plugin directory (${targetReal})`
          );
          continue;
        }
        try {
          const targetStat = lstatSync(targetReal);
          if (targetStat.isDirectory()) {
            if (!activeDirs.has(targetReal)) {
              const nextDirs = new Set(activeDirs);
              nextDirs.add(targetReal);
              visit(targetReal, relPosix, nextDirs);
            }
          } else if (targetStat.isFile() && !seenRealFiles.has(targetReal)) {
            seenRealFiles.add(targetReal);
            files.push({ full: targetReal, path: relPosix });
          }
        } catch {
          // ignore unreadable internal symlink target
        }
        continue;
      }
      if (SKIP_DIRS.has(entry)) continue;
      if (lst.isDirectory()) {
        let dirReal = '';
        try {
          dirReal = realpathSync.native(full);
        } catch {
          continue;
        }
        if (activeDirs.has(dirReal)) continue;
        const nextDirs = new Set(activeDirs);
        nextDirs.add(dirReal);
        visit(full, relPosix, nextDirs);
      } else if (lst.isFile()) {
        try {
          const fileReal = realpathSync.native(full);
          if (!seenRealFiles.has(fileReal)) {
            seenRealFiles.add(fileReal);
            files.push({ full, path: relPosix });
          }
        } catch {
          files.push({ full, path: relPosix });
        }
      }
    }
  };

  visit(resolvedPluginRoot, '', new Set([realPluginRoot]));
  return { files, symlinkIssues };
}

function readCodeTextIfScannable(filePath) {
  let buf;
  try {
    const fd = openSync(filePath, 'r');
    try {
      if (fstatSync(fd).size > MAX_CODE_SCAN_BYTES) return null;
      buf = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

function collectPluginSidecars(resolvedPluginRoot) {
  const found = [];
  const seen = new Set();
  let externalReason = '';

  const addSidecar = (id, dir, isPluginRoot = false) => {
    const manifestPath = resolve(dir, 'sidecar.json');
    if (seen.has(manifestPath) || !existsSync(manifestPath)) return false;
    seen.add(manifestPath);
    const checked = readJsonChecked(manifestPath);
    const modChecked = readJsonChecked(join(dir, 'mod.json'));
    found.push({
      id,
      dir,
      isPluginRoot,
      manifest: checked.valid ? checked.value : null,
      mod: modChecked.exists && modChecked.valid ? modChecked.value : null,
    });
    return true;
  };

  if (existsSync(join(resolvedPluginRoot, 'sidecar.json'))) {
    const pluginManifest = readJsonChecked(join(resolvedPluginRoot, 'plugin.json'));
    const rootName =
      (isPlainObject(pluginManifest.value) && pluginManifest.value.name) ||
      basename(resolvedPluginRoot) ||
      'root';
    addSidecar(String(rootName), resolvedPluginRoot, true);
  }

  const sidecarsDir = join(resolvedPluginRoot, 'sidecars');
  if (existsSync(sidecarsDir)) {
    try {
      const sidecarsStat = lstatSync(sidecarsDir);
      if (sidecarsStat.isSymbolicLink()) {
        externalReason = 'sidecars directory is a symbolic link';
      } else if (sidecarsStat.isDirectory()) {
        for (const d of readdirSync(sidecarsDir)) {
          const subDir = join(sidecarsDir, d);
          try {
            const subStat = lstatSync(subDir);
            if (subStat.isSymbolicLink()) {
              if (!externalReason) {
                externalReason = `sidecars/${d} is a symbolic link`;
              }
            } else if (subStat.isDirectory()) {
              addSidecar(d, subDir, false);
            }
          } catch {
            // ignore unreadable entry
          }
        }
      }
    } catch {
      // ignore unreadable sidecars dir
    }
  }

  const sidecarsCfgPath = join(resolvedPluginRoot, 'sidecars.json');
  const hasSidecarsJson = existsSync(sidecarsCfgPath);
  if (hasSidecarsJson) {
    const cfgChecked = readJsonChecked(sidecarsCfgPath);
    const cfg = cfgChecked.value;
    if (!cfgChecked.valid || !isPlainObject(cfg)) {
      externalReason = externalReason || 'sidecars.json is malformed or unverified';
    } else if (
      cfg.inherits !== undefined &&
      (!Array.isArray(cfg.inherits) || cfg.inherits.length > 0)
    ) {
      externalReason = externalReason || 'sidecars.json inherits external configuration';
    } else if (cfg.entries !== undefined && !Array.isArray(cfg.entries)) {
      externalReason = externalReason || 'sidecars.json entries is malformed';
    } else if (Array.isArray(cfg.entries)) {
      for (const entry of cfg.entries) {
        const rawPath = typeof entry?.path === 'string' ? entry.path.trim() : '';
        if (
          !rawPath ||
          rawPath.startsWith('~/') ||
          isAbsolute(rawPath) ||
          win32.isAbsolute(rawPath)
        ) {
          externalReason =
            externalReason ||
            `sidecars.json references external sidecar path "${rawPath || '(invalid)'}"`;
          break;
        }
        const entryAbs = resolve(resolvedPluginRoot, rawPath);
        const rel = relative(resolvedPluginRoot, entryAbs);
        if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(entryAbs)) {
          externalReason =
            externalReason ||
            `sidecars.json references path outside or missing from plugin ("${rawPath}")`;
          break;
        }
        try {
          if (lstatSync(entryAbs).isSymbolicLink()) {
            externalReason =
              externalReason || `sidecars.json references symbolic link "${rawPath}"`;
            break;
          }
          addSidecar(basename(entryAbs), entryAbs, rel === '');
          for (const sub of readdirSync(entryAbs, { withFileTypes: true })) {
            if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
            addSidecar(sub.name, join(entryAbs, sub.name), false);
          }
        } catch {
          externalReason =
            externalReason || `sidecars.json entry "${rawPath}" could not be inspected`;
          break;
        }
      }
    }
  }

  return { sidecars: found, hasSidecarsJson, externalReason };
}

/**
 * Infers Hangar's 3-tier capability classification for a plugin directory.
 *
 * @param {string} pluginDir
 * @returns {{
 *   tier: 'TIER_1_TELEMETRY' | 'TIER_2_LOCAL_TOOLING' | 'TIER_3_AGENT_CONTROL',
 *   reasons: string[],
 * }}
 */
export function inferPluginTier(pluginDir) {
  if (!pluginDir || typeof pluginDir !== 'string') {
    throw new Error('inferPluginTier requires a valid pluginDir path.');
  }
  const resolvedPluginRoot = resolve(pluginDir);
  if (!existsSync(resolvedPluginRoot)) {
    throw new Error(`Plugin directory does not exist: ${resolvedPluginRoot}`);
  }
  const realPluginRoot = realpathSync.native(resolvedPluginRoot);

  const reasons = [];
  let rank = 0;

  // 1. Hooks
  const events = new Set();
  const hookCommands = [];
  for (const rel of ['hooks.json', 'hooks/hooks.json', '.claude-plugin/hooks.json']) {
    const checked = readJsonChecked(join(resolvedPluginRoot, rel));
    if (checked.exists && !checked.valid) {
      rank = 2;
      reasons.push(`${rel}: malformed hooks JSON cannot verify hook events`);
    } else if (checked.value) {
      collectHookEvents(checked.value, events, hookCommands);
    }
  }
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json']) {
    const checked = readJsonChecked(join(resolvedPluginRoot, rel));
    if (checked.exists && !checked.valid) {
      rank = 2;
      reasons.push(`${rel}: malformed plugin manifest JSON`);
    } else if (isPlainObject(checked.value?.hooks)) {
      collectHookEvents(checked.value.hooks, events, hookCommands);
    } else if (typeof checked.value?.hooks === 'string') {
      if (pathTokenEscapesRoot(checked.value.hooks, resolvedPluginRoot)) {
        rank = 2;
        reasons.push(`${rel}: hooks path escapes plugin directory`);
      }
    }
  }
  if (events.size > 0) {
    rank = Math.max(rank, 1);
    reasons.push(`hooks: ${[...events].join(', ')}`);
  }
  if (events.has('Stop') || events.has('PostInvocation')) {
    rank = 2;
    reasons.push('a hook can keep the agent running');
  }
  for (const cmdStr of hookCommands) {
    const tokens = cmdStr.split(/\s+/).filter(Boolean);
    if (tokens.some((tok) => pathTokenEscapesRoot(tok, resolvedPluginRoot))) {
      rank = 2;
      reasons.push('hook command references path outside plugin directory');
      break;
    }
  }

  // 2. MCP servers
  const mcpMap = Object.create(null);
  for (const rel of ['mcp_config.json', '.mcp.json', 'mcp.json']) {
    const checked = readJsonChecked(join(resolvedPluginRoot, rel));
    if (checked.exists && !checked.valid) {
      rank = 2;
      reasons.push(`${rel}: malformed MCP config JSON`);
    } else if (checked.value) {
      Object.assign(mcpMap, extractServerMap(checked.value));
    }
  }
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']) {
    const checked = readJsonChecked(join(resolvedPluginRoot, rel));
    const declared = checked.value?.mcpServers;
    if (isPlainObject(declared)) {
      Object.assign(mcpMap, extractServerMap({ mcpServers: declared }));
    } else if (typeof declared === 'string') {
      if (pathTokenEscapesRoot(declared, resolvedPluginRoot)) {
        rank = 2;
        reasons.push(`${rel}: mcpServers path escapes plugin directory`);
      }
    }
  }
  const servers = Object.entries(mcpMap);
  if (servers.length > 0) {
    rank = Math.max(rank, 1);
    reasons.push(`MCP servers: ${servers.map(([n]) => n).join(', ')}`);
    for (const [srvName, srvCfg] of servers) {
      if (!isPlainObject(srvCfg)) continue;
      const tokens = [
        ...(typeof srvCfg.command === 'string' ? [srvCfg.command] : []),
        ...(typeof srvCfg.cwd === 'string' ? [srvCfg.cwd] : []),
        ...(Array.isArray(srvCfg.args) ? srvCfg.args.filter((a) => typeof a === 'string') : []),
      ];
      if (tokens.some((tok) => pathTokenEscapesRoot(tok, resolvedPluginRoot))) {
        rank = 2;
        reasons.push(`MCP server "${srvName}" references path outside plugin directory`);
      }
    }
  }

  // 3. Agents (`agents/*.md`)
  const agentsDir = join(resolvedPluginRoot, 'agents');
  if (existsSync(agentsDir)) {
    try {
      const agentsReal = realpathSync.native(agentsDir);
      if (isWithinRoot(realPluginRoot, agentsReal) && lstatSync(agentsReal).isDirectory()) {
        const agents = readdirSync(agentsReal).filter((f) => f.endsWith('.md'));
        if (agents.length > 0) {
          rank = Math.max(rank, 2);
          reasons.push(`agents: ${agents.map((f) => f.replace(/\.md$/, '')).join(', ')}`);
        }
      }
    } catch {
      // dangling symlink is caught and escalated by walkPluginFiles
    }
  }

  // 4. Sidecars & sidecar.json escalators
  const { sidecars, hasSidecarsJson, externalReason } = collectPluginSidecars(resolvedPluginRoot);
  if (sidecars.length > 0 || hasSidecarsJson) {
    rank = Math.max(rank, 1);
    const label = sidecars.length > 0 ? sidecars.map((s) => s.id).join(', ') : 'sidecars.json';
    reasons.push(`sidecars: ${label} (a full Node process outside agy's permission prompts)`);
  }
  if (externalReason) {
    rank = 2;
    reasons.push(externalReason);
  }
  for (const { id, dir, manifest: sc, mod } of sidecars) {
    if (mod) {
      if (mod.tier === TIERS[2]) {
        rank = 2;
        reasons.push(`UI mod ${id}: ${(mod.tierReasons ?? []).slice(1).join(', ')}`);
      }
      continue;
    }
    if (!isPlainObject(sc)) {
      rank = 2;
      reasons.push(
        `sidecar ${id}: malformed sidecar.json cannot verify non-interactive permissions`
      );
      continue;
    }
    if (sc.sandbox?.disable_sandbox === true || sc.sandbox?.disableSandbox === true) {
      reasons.push(`sidecar ${id}: disables process sandbox (sandbox.disable_sandbox: true)`);
    }
    if (typeof sc.builtin === 'string' && sc.builtin.trim() === 'schedule') {
      rank = 2;
      reasons.push(`sidecar ${id}: scheduled automation ("builtin": "schedule")`);
    }
    if (sc.agent_permissions?.allows_user_interactions === true) {
      rank = 2;
      reasons.push(`sidecar ${id}: agent_permissions.allows_user_interactions is true`);
    }
    const grants = sc.agent_permissions?.access_grants;
    if (Array.isArray(grants) ? grants.length > 0 : Boolean(grants)) {
      rank = 2;
      reasons.push(
        `sidecar ${id}: grants agent tool permissions (${Array.isArray(grants) ? grants.join(', ') : String(grants)})`
      );
    }
    const wsUris = sc.agent_permissions?.workspace_uris;
    if (Array.isArray(wsUris) ? wsUris.length > 0 : Boolean(wsUris)) {
      rank = 2;
      reasons.push(
        `sidecar ${id}: grants agent workspace access (${Array.isArray(wsUris) ? wsUris.join(', ') : String(wsUris)})`
      );
    }
    const scTokens = [
      ...(typeof sc.cwd === 'string' ? [sc.cwd] : []),
      ...(Array.isArray(sc.args) ? sc.args.filter((a) => typeof a === 'string') : []),
    ];
    if (
      scTokens.some((tok) => {
        if (!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(tok)) return false;
        return !isWithinRoot(resolvedPluginRoot, resolve(dir, tok));
      })
    ) {
      rank = 2;
      reasons.push(`sidecar ${id}: args/cwd escape plugin directory`);
    }
  }

  // 5. Symlink containment + runtime JS / MCP App markers
  const { files, symlinkIssues } = walkPluginFiles(resolvedPluginRoot, realPluginRoot);
  for (const issue of symlinkIssues) {
    rank = 2;
    reasons.push(issue);
  }

  let hasMcpApp = false;
  let hasUiMessage = false;
  let hasAgentControlSource = false;

  for (const { full, path } of files) {
    if (!CODE_SCAN_EXT.test(path) || DOCS_SKIP_PATH.test(path)) continue;
    const text = readCodeTextIfScannable(full);
    if (text === null) continue;
    if (!hasMcpApp && MCP_APP_MARKERS.some((re) => re.test(text))) {
      hasMcpApp = true;
    }
    if (!hasUiMessage && MCP_APP_MESSAGE_MARKERS.some((re) => re.test(text))) {
      hasUiMessage = true;
    }
    if (!hasAgentControlSource && SIDECAR_AGENT_CONTROL_MARKERS.some((re) => re.test(text))) {
      hasAgentControlSource = true;
    }
    if (hasMcpApp && hasUiMessage && hasAgentControlSource) break;
  }

  if (servers.length > 0 && hasMcpApp) {
    rank = Math.max(rank, 1);
    reasons.push('MCP App UI views (SEP-1865 ui://)');
  }
  if (hasUiMessage) {
    rank = 2;
    reasons.push('an MCP App view or script can send messages into the conversation (ui/message)');
  }
  if (hasAgentControlSource) {
    rank = 2;
    reasons.push('runtime source sends messages or starts agent conversations');
  }

  return { tier: TIERS[rank], reasons };
}

function checkRelease(release, where, errors, kind = 'sidecar') {
  if (!isPlainObject(release)) {
    errors.push(`${where}.release must be an object`);
    return;
  }
  const { gitRepo, tarballUrl, sha256, path, ref } = release;
  if (!gitRepo && !tarballUrl) {
    errors.push(`${where}.release needs gitRepo or tarballUrl`);
  }
  if (gitRepo !== undefined && !isHttpsUrl(gitRepo)) {
    errors.push(`${where}.release.gitRepo must be an https URL`);
  }
  if (tarballUrl !== undefined) {
    if (!isHttpsUrl(tarballUrl)) {
      errors.push(`${where}.release.tarballUrl must be an https URL`);
    }
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      errors.push(`${where}.release.tarballUrl requires a 64-hex sha256`);
    }
  }
  if (path !== undefined && !isRelativeInside(path)) {
    errors.push(`${where}.release.path must be a relative path inside the package`);
  }
  if (
    ref !== undefined &&
    (typeof ref !== 'string' || !GIT_REF.test(ref) || ref.includes('..') || SHORT_SHA.test(ref))
  ) {
    errors.push(`${where}.release.ref must be a tag or a full 40-character commit SHA`);
  }
  if (kind !== 'plugin' && (path !== undefined || ref !== undefined)) {
    errors.push(`${where}.release.path and release.ref are only supported with kind "plugin"`);
  }
}

/**
 * Validates a single Hangar `registry.json` package entry against Hangar's exact schema rules.
 *
 * @param {unknown} entry
 * @returns {string[]}
 */
export function validateRegistryEntry(entry) {
  const errors = [];
  if (!isPlainObject(entry)) {
    return ['entry must be a JSON object'];
  }
  const where = `entry${typeof entry.id === 'string' && entry.id ? ` (${entry.id})` : ''}`;

  if (typeof entry.id !== 'string' || !SIDECAR_ID.test(entry.id)) {
    errors.push(`${where}.id must match ${SIDECAR_ID}`);
  }
  if (RESERVED_IDS.has(entry.id)) {
    errors.push(`${where}.id is reserved`);
  }
  if (!isNonEmptyString(entry.name)) {
    errors.push(`${where}.name is required`);
  }
  if (typeof entry.latestVersion !== 'string' || !SEMVER.test(entry.latestVersion)) {
    errors.push(`${where}.latestVersion must be semver`);
  }
  if (!TIERS_SET.has(entry.capabilityTier)) {
    errors.push(`${where}.capabilityTier must be one of ${TIERS.join(', ')}`);
  }
  if (
    entry.npmPackage !== undefined &&
    (typeof entry.npmPackage !== 'string' || !NPM_NAME.test(entry.npmPackage))
  ) {
    errors.push(`${where}.npmPackage is not a valid npm name`);
  }
  if (entry.funding !== undefined && !isHttpsUrl(entry.funding)) {
    errors.push(`${where}.funding must be an https URL`);
  }
  if (
    entry.categories !== undefined &&
    !(Array.isArray(entry.categories) && entry.categories.every(isNonEmptyString))
  ) {
    errors.push(`${where}.categories must be an array of strings`);
  }
  if (entry.license !== undefined && !(typeof entry.license === 'string' && SPDX.test(entry.license))) {
    errors.push(`${where}.license must be an SPDX license id or expression`);
  }
  if (entry.homepage !== undefined && !isHttpsUrl(entry.homepage)) {
    errors.push(`${where}.homepage must be an https URL`);
  }
  if (entry.author !== undefined) {
    if (!isPlainObject(entry.author) || !isNonEmptyString(entry.author.name)) {
      errors.push(`${where}.author must be an object with a non-empty name`);
    } else {
      if (entry.author.github !== undefined && !isNonEmptyString(entry.author.github)) {
        errors.push(`${where}.author.github must be a non-empty string`);
      }
      if (entry.author.verified !== undefined && typeof entry.author.verified !== 'boolean') {
        errors.push(`${where}.author.verified must be a boolean`);
      }
    }
  }
  if (entry.securityScan !== undefined) {
    if (
      !isPlainObject(entry.securityScan) ||
      typeof entry.securityScan.passed !== 'boolean' ||
      typeof entry.securityScan.hasPostInstallScripts !== 'boolean' ||
      typeof entry.securityScan.externalDependencies !== 'number' ||
      !Number.isInteger(entry.securityScan.externalDependencies) ||
      entry.securityScan.externalDependencies < 0
    ) {
      errors.push(
        `${where}.securityScan must specify boolean passed/hasPostInstallScripts and non-negative integer externalDependencies`
      );
    }
  }
  if (entry.workspaceTriggers !== undefined) {
    if (!isPlainObject(entry.workspaceTriggers)) {
      errors.push(`${where}.workspaceTriggers must be an object`);
    } else if (entry.workspaceTriggers.files !== undefined) {
      const files = entry.workspaceTriggers.files;
      const bad = Array.isArray(files) ? files.filter((f) => !isRelativeInside(f)) : [files];
      if (bad.length > 0) {
        errors.push(
          `${where}.workspaceTriggers.files must be relative paths inside the workspace: ${JSON.stringify(bad)}`
        );
      }
    }
  }

  const kind = entry.kind ?? 'sidecar';
  if (!KINDS.has(kind)) {
    errors.push(`${where}.kind must be "sidecar" or "plugin"`);
  }
  if (entry.port !== undefined) {
    if (kind !== 'plugin') errors.push(`${where}.port needs kind "plugin"`);
    if (!isPlainObject(entry.port) || !PORT_SOURCES.has(entry.port.from)) {
      errors.push(`${where}.port.from must be one of ${[...PORT_SOURCES].join(', ')}`);
    }
    if (!entry.release?.gitRepo) {
      errors.push(`${where}.release.gitRepo is required when port is set`);
    }
    if (!entry.release?.ref) {
      errors.push(`${where}.release.ref is required when port is set`);
    }
  }
  checkRelease(entry.release, where, errors, kind);

  return errors;
}

function normalizeGitRepoUrl(rawRepository) {
  const raw =
    typeof rawRepository === 'string'
      ? rawRepository.trim()
      : isPlainObject(rawRepository) && typeof rawRepository.url === 'string'
        ? rawRepository.url.trim()
        : '';

  if (!raw) return '';

  let url = raw.replace(/^git\+/i, '');
  if (/^github:/i.test(url)) {
    url = `https://github.com/${url.slice('github:'.length).replace(/^\/+/, '')}`;
  } else if (/^git@github\.com:/i.test(url)) {
    url = `https://github.com/${url.slice('git@github.com:'.length)}`;
  } else if (/^ssh:\/\/git@github\.com\//i.test(url)) {
    url = `https://github.com/${url.slice('ssh://git@github.com/'.length)}`;
  } else if (HANGAR_REPO_SLUG_RE.test(url)) {
    url = `https://github.com/${url}`;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.search = '';
    const cleanPath = parsed.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!cleanPath || cleanPath === '/') return '';
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return '';
  }
}

function extractGithubHandle(rawCandidate) {
  if (typeof rawCandidate !== 'string' || !rawCandidate.trim()) return '';
  const trimmed = rawCandidate.trim();
  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    try {
      const seg = new URL(trimmed).pathname.split('/').filter(Boolean)[0] || '';
      if (!seg || seg.toLowerCase() === 'example') return '';
      return normalizeGithubOwner(seg);
    } catch {
      return '';
    }
  }
  try {
    const owner = normalizeGithubOwner(trimmed);
    return owner.toLowerCase() === 'example' ? '' : owner;
  } catch {
    return '';
  }
}

function resolveAuthorField({ pkg, hubManifest, pluginManifest, gitRepo }) {
  const fromHub = isPlainObject(hubManifest?.author) ? hubManifest.author : null;
  const fromPlugin = isPlainObject(pluginManifest?.author) ? pluginManifest.author : null;
  const fromPkg = isPlainObject(pkg?.author) ? pkg.author : null;

  let name = '';
  if (isNonEmptyString(fromHub?.name)) name = fromHub.name.trim();
  else if (isNonEmptyString(fromPlugin?.name)) name = fromPlugin.name.trim();
  else if (isNonEmptyString(fromPkg?.name)) name = fromPkg.name.trim();
  else if (isNonEmptyString(pluginManifest?.author)) name = pluginManifest.author.trim();
  else if (isNonEmptyString(pkg?.author)) {
    name = pkg.author.replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim();
  }
  if (!name) name = 'Sidecar Author';

  const github =
    extractGithubHandle(fromHub?.github) ||
    extractGithubHandle(fromPlugin?.github) ||
    extractGithubHandle(fromPlugin?.url) ||
    extractGithubHandle(fromPkg?.github) ||
    extractGithubHandle(fromPkg?.url) ||
    extractGithubHandle(gitRepo);

  return {
    name,
    ...(github ? { github } : {}),
  };
}

function extractFundingHttpsUrl(rawFunding) {
  if (!rawFunding) return '';
  if (typeof rawFunding === 'string') {
    return isHttpsUrl(rawFunding.trim()) ? rawFunding.trim() : '';
  }
  if (isPlainObject(rawFunding) && typeof rawFunding.url === 'string') {
    return isHttpsUrl(rawFunding.url.trim()) ? rawFunding.url.trim() : '';
  }
  if (Array.isArray(rawFunding)) {
    for (const item of rawFunding) {
      const found = extractFundingHttpsUrl(item);
      if (found) return found;
    }
  }
  return '';
}

function resolveHomepageUrl({ pkg, pluginManifest, gitRepo }) {
  for (const candidate of [pluginManifest?.homepage, pkg?.homepage]) {
    if (typeof candidate === 'string' && isHttpsUrl(candidate.trim())) {
      return candidate.trim().replace(/#readme$/i, '');
    }
  }
  return gitRepo;
}

function computeSidecarSecurityScan(pkg) {
  const scripts = isPlainObject(pkg?.scripts) ? pkg.scripts : {};
  const hasPostInstallScripts = LIFECYCLE_INSTALL_SCRIPTS.some((hook) =>
    isNonEmptyString(scripts[hook])
  );
  const depNames = new Set([
    ...(isPlainObject(pkg?.dependencies) ? Object.keys(pkg.dependencies) : []),
    ...(isPlainObject(pkg?.optionalDependencies) ? Object.keys(pkg.optionalDependencies) : []),
  ]);
  let externalDependencies = 0;
  for (const dep of depNames) {
    if (!TRUSTED_SIDECAR_DEPS.has(dep)) {
      externalDependencies += 1;
    }
  }
  return {
    passed: !hasPostInstallScripts,
    hasPostInstallScripts,
    externalDependencies,
  };
}

function inferStandaloneSidecarTier(resolvedRepo, hubManifest) {
  const declared = hubManifest?.capabilityTier;
  const declaredRank = TIERS.indexOf(declared);
  let rank = declaredRank >= 0 ? declaredRank : 0;

  if (existsSync(join(resolvedRepo, 'mcp.mjs'))) {
    rank = Math.max(rank, 1);
  }
  const inspected = inferPluginTier(resolvedRepo);
  if (inspected.tier === 'TIER_3_AGENT_CONTROL') {
    rank = 2;
  }
  return TIERS[rank];
}

/**
 * Builds and validates a Hangar `registry.json` package entry from a sidecar or plugin repository.
 *
 * @param {{
 *   repoRoot?: string,
 *   kitRoot?: string,
 *   agyValidate?: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildRegistryEntry({
  repoRoot = process.cwd(),
  kitRoot = KIT_ROOT,
  agyValidate = true,
  env = process.env,
} = {}) {
  const resolvedRepo = resolve(repoRoot);
  const pkgPath = join(resolvedRepo, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`Missing package.json in ${resolvedRepo}`);
  }
  const pkg = readJsonSafe(pkgPath, null, { strict: true });

  const rawPluginDir =
    isPlainObject(pkg.agyPlugin) && typeof pkg.agyPlugin.pluginDir === 'string'
      ? pkg.agyPlugin.pluginDir
      : 'plugin';
  const isPluginProject =
    isPlainObject(pkg.agyPlugin) || existsSync(join(resolvedRepo, rawPluginDir, 'plugin.json'));

  if (isPluginProject) {
    const srcPluginDir = resolve(resolvedRepo, rawPluginDir);
    const srcPluginManifestPath = join(srcPluginDir, 'plugin.json');
    const srcPluginManifest = existsSync(srcPluginManifestPath)
      ? readJsonSafe(srcPluginManifestPath, null, { strict: true })
      : null;

    const gitRepo =
      normalizeGitRepoUrl(pkg.repository) || normalizeGitRepoUrl(srcPluginManifest?.repository);
    if (!gitRepo) {
      throw new Error(
        `Missing or invalid "repository" / gitRepo HTTPS URL in ${pkgPath}. Add a "repository" field (or pass --github <owner> during init) before generating a Hangar registry entry.`
      );
    }

    const built = buildPluginProject({
      repoRoot: resolvedRepo,
      tar: true,
      agyValidate,
      kitRoot,
      env,
    });
    const builtManifest = readJsonSafe(join(built.dir, 'plugin.json'), null, { strict: true });
    const { tier } = inferPluginTier(built.dir);
    const author = resolveAuthorField({ pkg, pluginManifest: builtManifest, gitRepo });
    const funding = extractFundingHttpsUrl(pkg.funding);
    const license =
      (isNonEmptyString(builtManifest?.license) && builtManifest.license.trim()) ||
      (isNonEmptyString(pkg.license) && pkg.license.trim()) ||
      'MIT';
    const categories =
      Array.isArray(pkg.agyPlugin?.categories) &&
      pkg.agyPlugin.categories.length > 0 &&
      pkg.agyPlugin.categories.every(isNonEmptyString)
        ? pkg.agyPlugin.categories.map((c) => c.trim())
        : ['utilities'];
    const displayName =
      (isNonEmptyString(builtManifest?.displayName) && builtManifest.displayName.trim()) ||
      toDisplayName(built.pluginName) ||
      built.pluginName;
    const tagline =
      (isNonEmptyString(builtManifest?.description) && builtManifest.description.trim()) ||
      (isNonEmptyString(pkg.description) && pkg.description.trim()) ||
      `${displayName} native plugin for Google Antigravity.`;

    const entry = {
      id: built.pluginName,
      name: displayName,
      kind: 'plugin',
      ...(pkg.private !== true && isNonEmptyString(pkg.name) && NPM_NAME.test(pkg.name.trim())
        ? { npmPackage: pkg.name.trim() }
        : {}),
      tagline,
      author,
      ...(funding ? { funding } : {}),
      latestVersion: built.version,
      pricing: 'free',
      categories,
      capabilityTier: tier,
      license,
      homepage: resolveHomepageUrl({ pkg, pluginManifest: builtManifest, gitRepo }),
      release: {
        tarballUrl: `${gitRepo}/releases/download/v${built.version}/${built.pluginName}-plugin-${built.version}.tgz`,
        sha256: built.sha256,
      },
    };

    const validationErrors = validateRegistryEntry(entry);
    if (validationErrors.length > 0) {
      throw new Error(`Generated plugin registry entry is invalid: ${validationErrors.join('; ')}`);
    }
    return entry;
  }

  const sidecarJsonPath = join(resolvedRepo, 'sidecar.json');
  if (!existsSync(sidecarJsonPath)) {
    throw new Error(
      `Cannot build registry entry in ${resolvedRepo}: expected either a plugin manifest (${rawPluginDir}/plugin.json) or a standalone sidecar.json.`
    );
  }
  const sidecarJson = readJsonSafe(sidecarJsonPath, null, { strict: true });
  const hubManifestPath = join(resolvedRepo, 'hub-manifest.json');
  const hubManifest = existsSync(hubManifestPath)
    ? readJsonSafe(hubManifestPath, null, { strict: true })
    : null;

  const gitRepo = normalizeGitRepoUrl(pkg.repository);
  if (!gitRepo) {
    throw new Error(
      `Missing or invalid "repository" / gitRepo HTTPS URL in ${pkgPath}. Add a "repository" field (or pass --github <owner> during init) before generating a Hangar registry entry.`
    );
  }

  const id =
    (isNonEmptyString(hubManifest?.id) && hubManifest.id.trim()) ||
    resolveProjectNames({
      name: pkg.name || basename(resolvedRepo),
      archetype: 'sidecar-ui',
    }).id;
  const displayName =
    (isNonEmptyString(hubManifest?.name) && hubManifest.name.trim()) ||
    (isNonEmptyString(sidecarJson?.display_name) && sidecarJson.display_name.trim()) ||
    toDisplayName(id) ||
    id;
  const tagline =
    (isNonEmptyString(hubManifest?.tagline) && hubManifest.tagline.trim()) ||
    (isNonEmptyString(pkg.description) && pkg.description.trim()) ||
    (isNonEmptyString(sidecarJson?.description) && sidecarJson.description.trim()) ||
    `${displayName} Auxiliary Pane sidecar for Google Antigravity.`;
  const latestVersion =
    (isNonEmptyString(pkg.version) && pkg.version.trim()) ||
    (isNonEmptyString(hubManifest?.version) && hubManifest.version.trim()) ||
    '';
  const author = resolveAuthorField({ pkg, hubManifest, gitRepo });
  const funding =
    extractFundingHttpsUrl(hubManifest?.funding) || extractFundingHttpsUrl(pkg.funding);
  const categories =
    Array.isArray(hubManifest?.categories) &&
    hubManifest.categories.length > 0 &&
    hubManifest.categories.every(isNonEmptyString)
      ? hubManifest.categories.map((c) => c.trim())
      : ['utilities'];
  const license =
    (isNonEmptyString(pkg.license) && pkg.license.trim()) ||
    (isNonEmptyString(hubManifest?.license) && hubManifest.license.trim()) ||
    'MIT';
  const workspaceTriggers = isPlainObject(hubManifest?.workspaceTriggers)
    ? structuredClone(hubManifest.workspaceTriggers)
    : { files: ['package.json'] };

  const entry = {
    id,
    name: displayName,
    ...(pkg.private !== true && isNonEmptyString(pkg.name)
      ? { npmPackage: pkg.name.trim() }
      : {}),
    tagline,
    author,
    ...(funding ? { funding } : {}),
    latestVersion,
    pricing: isNonEmptyString(hubManifest?.pricing) ? hubManifest.pricing.trim() : 'free',
    categories,
    capabilityTier: inferStandaloneSidecarTier(resolvedRepo, hubManifest),
    license,
    homepage: resolveHomepageUrl({ pkg, gitRepo }),
    securityScan: computeSidecarSecurityScan(pkg),
    workspaceTriggers,
    release: {
      gitRepo,
    },
  };

  const validationErrors = validateRegistryEntry(entry);
  if (validationErrors.length > 0) {
    throw new Error(`Generated sidecar registry entry is invalid: ${validationErrors.join('; ')}`);
  }
  return entry;
}

function isDefaultCategories(categories) {
  return Array.isArray(categories) && categories.length === 1 && categories[0] === 'utilities';
}

function isDefaultWorkspaceTriggers(triggers) {
  return (
    isPlainObject(triggers) &&
    Array.isArray(triggers.files) &&
    triggers.files.length === 1 &&
    triggers.files[0] === 'package.json'
  );
}

/**
 * Safely inserts or updates a package entry in an existing Hangar `registry.json` file without
 * clobbering malformed files and while preserving `author.verified: true` and curated fields.
 *
 * @param {string} registryPath
 * @param {Record<string, unknown>} entry
 * @returns {{ action: 'inserted' | 'updated', entry: Record<string, unknown> }}
 */
export function upsertRegistryFile(registryPath, entry) {
  if (!registryPath || typeof registryPath !== 'string') {
    throw new Error('upsertRegistryFile requires a valid registryPath.');
  }
  const resolvedPath = resolve(registryPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Registry file does not exist: ${resolvedPath}`);
  }

  const entryErrors = validateRegistryEntry(entry);
  if (entryErrors.length > 0) {
    throw new Error(`Refusing to write invalid registry entry: ${entryErrors.join('; ')}`);
  }

  const rawText = readFileSync(resolvedPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!rawText) {
    throw new Error(`Malformed or empty registry JSON in ${resolvedPath}`);
  }

  const registry = readJsonSafe(resolvedPath, null, { strict: true });
  if (!isPlainObject(registry)) {
    throw new Error(`Invalid registry root in ${resolvedPath}: expected a JSON object.`);
  }
  if (!Array.isArray(registry.packages)) {
    throw new Error(`Invalid registry in ${resolvedPath}: "packages" must be an array.`);
  }

  const existingIndex = registry.packages.findIndex(
    (item) => isPlainObject(item) && item.id === entry.id
  );

  if (existingIndex === -1) {
    const insertedEntry = structuredClone(entry);
    registry.packages.push(insertedEntry);
    writeJsonNoBom(resolvedPath, registry);
    return { action: 'inserted', entry: insertedEntry };
  }

  const existing = registry.packages[existingIndex];
  const definedUpdates = Object.fromEntries(
    Object.entries(entry).filter(([, val]) => val !== undefined)
  );
  const merged = structuredClone({
    ...existing,
    ...definedUpdates,
  });

  if (isPlainObject(existing.author) || isPlainObject(entry.author)) {
    merged.author = {
      ...(isPlainObject(existing.author) ? existing.author : {}),
      ...(isPlainObject(entry.author) ? entry.author : {}),
    };
    if (existing.author?.verified === true && entry.author?.verified === undefined) {
      merged.author.verified = true;
    }
  }

  if (
    Array.isArray(existing.categories) &&
    existing.categories.length > 0 &&
    (entry.categories === undefined ||
      (isDefaultCategories(entry.categories) && !isDefaultCategories(existing.categories)))
  ) {
    merged.categories = structuredClone(existing.categories);
  }

  if (
    isPlainObject(existing.workspaceTriggers) &&
    (entry.workspaceTriggers === undefined ||
      (isDefaultWorkspaceTriggers(entry.workspaceTriggers) &&
        !isDefaultWorkspaceTriggers(existing.workspaceTriggers)))
  ) {
    merged.workspaceTriggers = structuredClone(existing.workspaceTriggers);
  }

  if (entry.funding === undefined && existing.funding !== undefined) {
    merged.funding = existing.funding;
  }

  merged.release = structuredClone(entry.release);

  const mergedErrors = validateRegistryEntry(merged);
  if (mergedErrors.length > 0) {
    throw new Error(`Merged registry entry failed validation: ${mergedErrors.join('; ')}`);
  }

  registry.packages[existingIndex] = merged;
  writeJsonNoBom(resolvedPath, registry);
  return { action: 'updated', entry: merged };
}

function invokeExec(execFn, cmd, args, options = {}) {
  const runner = typeof execFn === 'function' ? execFn : execFileSync;
  const out = runner(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    ...options,
  });
  if (typeof out === 'string') return out;
  if (Buffer.isBuffer(out)) return out.toString('utf8');
  if (isPlainObject(out)) {
    if (typeof out.status === 'number' && out.status !== 0) {
      throw new Error(String(out.stderr || out.stdout || `${cmd} exited with ${out.status}`));
    }
    return String(out.stdout || '');
  }
  return '';
}

/**
 * Forks/clones Hangar into a temporary directory, upserts `registry.json` on branch
 * `registry/<id>-<version>`, pushes, and opens a pull request via `gh`.
 *
 * @param {{
 *   repoRoot?: string,
 *   hangarRepo?: string,
 *   execFn?: (cmd: string, args: string[], options?: Record<string, unknown>) => unknown,
 *   kitRoot?: string,
 * }} [options]
 * @returns {{ branch: string, prUrl: string }}
 */
export function openRegistryPr({
  repoRoot = process.cwd(),
  hangarRepo = 'arthurcavallari/antigravity-hangar',
  execFn = execFileSync,
  kitRoot = KIT_ROOT,
  agyValidate = true,
  env = process.env,
} = {}) {
  const cleanHangarRepo = typeof hangarRepo === 'string' ? hangarRepo.trim() : '';
  if (
    !cleanHangarRepo ||
    cleanHangarRepo.includes('..') ||
    !HANGAR_REPO_SLUG_RE.test(cleanHangarRepo)
  ) {
    throw new Error(`Invalid hangarRepo "${String(hangarRepo)}": expected "owner/repo".`);
  }

  const resolvedRepo = resolve(repoRoot);
  const entry = buildRegistryEntry({ repoRoot: resolvedRepo, kitRoot, agyValidate, env });
  const branch = `registry/${entry.id}-${entry.latestVersion}`;

  try {
    invokeExec(execFn, 'gh', ['auth', 'status'], { cwd: resolvedRepo });
  } catch (err) {
    throw new Error(
      `GitHub CLI authentication check ("gh auth status") failed: ${err?.message || String(err)}`
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-hangar-pr-'));
  try {
    const cloneDir = join(tempRoot, 'hangar');
    try {
      invokeExec(
        execFn,
        'gh',
        [
          'repo',
          'fork',
          cleanHangarRepo,
          '--clone',
          '--default-branch-only',
          '--',
          cloneDir,
          '--depth=1',
        ],
        { cwd: tempRoot }
      );
    } catch (forkErr) {
      const msg = String(forkErr?.stderr || forkErr?.message || forkErr);
      if (!existsSync(join(cloneDir, 'registry.json')) && /cannot fork|own repo/i.test(msg)) {
        invokeExec(
          execFn,
          'gh',
          ['repo', 'clone', cleanHangarRepo, cloneDir, '--', '--depth=1'],
          { cwd: tempRoot }
        );
      } else {
        throw forkErr;
      }
    }

    invokeExec(execFn, 'git', ['checkout', '-B', branch], { cwd: cloneDir });

    const targetRegistryPath = join(cloneDir, 'registry.json');
    const { action, entry: finalEntry } = upsertRegistryFile(targetRegistryPath, entry);

    const commitTitle = `registry(${finalEntry.id}): ${action === 'updated' ? 'update' : 'add'} ${finalEntry.id} v${finalEntry.latestVersion}`;
    const prBody = [
      `## Registry ${action === 'updated' ? 'Update' : 'Submission'}: \`${finalEntry.id}\` (\`v${finalEntry.latestVersion}\`)`,
      '',
      `- **Kind:** \`${finalEntry.kind || 'sidecar'}\``,
      `- **Capability Tier:** \`${finalEntry.capabilityTier}\``,
      `- **Release:** ${finalEntry.release?.tarballUrl || finalEntry.release?.gitRepo || ''}`,
    ].join('\n');

    invokeExec(execFn, 'git', ['add', 'registry.json'], { cwd: cloneDir });
    invokeExec(execFn, 'git', ['commit', '-m', commitTitle], { cwd: cloneDir });
    invokeExec(execFn, 'git', ['push', '-u', 'origin', branch], { cwd: cloneDir });

    const prOut = invokeExec(
      execFn,
      'gh',
      ['pr', 'create', '--repo', cleanHangarRepo, '--title', commitTitle, '--body', prBody],
      { cwd: cloneDir }
    );
    const urlMatch = prOut.match(/https:\/\/\S+/g);
    const prUrl = urlMatch ? urlMatch[urlMatch.length - 1].trim() : prOut.trim();
    if (!isHttpsUrl(prUrl)) {
      throw new Error(`gh pr create did not return a valid HTTPS pull request URL: "${prOut.trim()}"`);
    }

    return { branch, prUrl };
  } finally {
    removeLinkOrDir(tempRoot);
  }
}
