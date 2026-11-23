/**
 * @fileoverview Scaffolds Antigravity sidecar and native plugin archetypes (`sidecar-ui`, `sidecar-mcp`, `plugin`, `plugin-sidecar`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeJsonNoBom } from './config.mjs';
import { lintPluginOrSidecar } from './manifest-validator.mjs';
import { buildBaseLayer, normalizeGithubOwner } from './scaffolder/base-layer.mjs';
import {
  ARCHETYPES,
  PLUGIN_COMPONENTS,
  resolveProjectNames,
  toDisplayName,
} from './scaffolder/naming.mjs';
import { buildPluginLayer } from './scaffolder/plugin-layers.mjs';
import {
  buildIndexHtml,
  buildSidecarLayer,
  buildSidecarServerMjs,
  buildStylesCss,
} from './scaffolder/sidecar-layers.mjs';

export { ARCHETYPES, PLUGIN_COMPONENTS, buildIndexHtml, buildStylesCss, resolveProjectNames };

const KIT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

export function sanitizeSidecarName(raw = '') {
  let clean = String(raw || '').trim().toLowerCase();
  for (const prefix of ['antigravity-sidecar-', 'antigravity-', 'agy-']) {
    if (clean.startsWith(prefix)) {
      clean = clean.slice(prefix.length);
      break;
    }
  }
  clean = clean.replace(/[^a-z0-9-_]+/g, '-');
  let start = 0;
  let end = clean.length;
  while (start < end && clean.charCodeAt(start) === 45) start++;
  while (end > start && clean.charCodeAt(end - 1) === 45) end--;
  return clean.slice(start, end);
}

export function generateHubManifest(opts = {}) {
  const id = sanitizeSidecarName(opts.id || opts.name || 'sidecar') || 'sidecar';
  const displayName = opts.title || opts.displayName || toDisplayName(id) || id;
  const description =
    opts.description || `${displayName} Auxiliary Pane sidecar for Google Antigravity.`;
  const tagline = opts.tagline || description;
  const manifest = {
    id,
    name: displayName,
    tagline,
    description,
    version: opts.version || '1.0.0',
    author: {
      name: opts.authorName || opts.author?.name || 'Sidecar Author',
      github: opts.authorGithub || opts.author?.github || 'https://github.com/example',
    },
    license: opts.license || 'MIT',
    pricing: opts.pricing || 'free',
    categories:
      Array.isArray(opts.categories) && opts.categories.length > 0 ? opts.categories : ['utilities'],
    capabilityTier: opts.capabilityTier || 'TIER_1_TELEMETRY',
    workspaceTriggers: opts.workspaceTriggers || { files: ['package.json'] },
    minAntigravityVersion: opts.minAntigravityVersion || '2.0.0',
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildServerMjs(id, options = {}) {
  return buildSidecarServerMjs({
    id,
    archetype: options?.archetype || 'sidecar-ui',
  });
}

const ENTRYPOINT_MAP = {
  aux_pane: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  'aux-pane': 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  SIDECAR_UI_ENTRYPOINT_AUX_PANE: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  sidebar: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
  SIDECAR_UI_ENTRYPOINT_SIDEBAR: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
  full_pane: 'SIDECAR_UI_ENTRYPOINT_FULL_PANE',
  'full-pane': 'SIDECAR_UI_ENTRYPOINT_FULL_PANE',
  SIDECAR_UI_ENTRYPOINT_FULL_PANE: 'SIDECAR_UI_ENTRYPOINT_FULL_PANE',
};

export function normalizeEntrypoint(raw = 'aux_pane') {
  const key = String(raw ?? 'aux_pane').trim();
  const mapped = Object.hasOwn(ENTRYPOINT_MAP, key)
    ? ENTRYPOINT_MAP[key]
    : Object.hasOwn(ENTRYPOINT_MAP, key.toLowerCase())
      ? ENTRYPOINT_MAP[key.toLowerCase()]
      : '';
  if (!mapped) {
    throw new Error(
      `Invalid entrypoint "${raw}" (expected aux_pane, sidebar, full_pane, or SIDECAR_UI_ENTRYPOINT_*)`
    );
  }
  return mapped;
}

/**
 * Scaffolds a complete Antigravity sidecar or native plugin project across any of the 4 archetypes.
 */
export function scaffoldProject({
  name,
  archetype = 'sidecar-ui',
  targetDir,
  pkgName,
  title,
  description,
  entrypoint = 'aux_pane',
  hideTitleBar = false,
  components = ['skills', 'mcp'],
  author,
  github = '',
  ci = true,
  force = false,
} = {}) {
  const names = resolveProjectNames({ name, archetype, pkgName });
  const isPlugin = archetype === 'plugin' || archetype === 'plugin-sidecar';
  const resolvedEntrypoint =
    archetype !== 'plugin' || entrypoint !== 'aux_pane'
      ? normalizeEntrypoint(entrypoint)
      : 'SIDECAR_UI_ENTRYPOINT_AUX_PANE';
  const githubOwner = normalizeGithubOwner(github);
  const cleanSingleLine = (val) =>
    typeof val === 'string' ? val.replace(/[\r\n]+/g, ' ').trim() : '';
  const displayName = cleanSingleLine(title) || names.displayName;
  const cleanDescription = cleanSingleLine(description) || undefined;
  const authorName = cleanSingleLine(author) || 'Sidecar Author';
  const outDir = resolve(targetDir || join(process.cwd(), names.folderName));

  if (existsSync(join(outDir, 'package.json')) && !force) {
    throw new Error(`Target directory already contains a package.json: ${outDir}`);
  }

  const baseFiles = buildBaseLayer({
    archetype,
    ...names,
    displayName,
    description: cleanDescription,
    authorName,
    githubOwner,
    ci,
  });

  const layerFiles = isPlugin
    ? buildPluginLayer({
        archetype,
        ...names,
        displayName,
        description: cleanDescription,
        entrypoint: resolvedEntrypoint,
        hideTitleBar: Boolean(hideTitleBar),
        components,
        authorName,
        githubOwner,
        kitVersion: KIT_VERSION,
      })
    : buildSidecarLayer({
        archetype,
        ...names,
        displayName,
        description: cleanDescription,
        entrypoint: resolvedEntrypoint,
        hideTitleBar: Boolean(hideTitleBar),
        authorName,
        githubOwner,
        kitVersion: KIT_VERSION,
      });

  const merged = new Map([...baseFiles, ...layerFiles]);
  for (const [relPath, value] of merged.entries()) {
    const dest = join(outDir, relPath);
    if (value && typeof value === 'object') {
      writeJsonNoBom(dest, value);
    } else if (relPath.endsWith('.json')) {
      writeJsonNoBom(dest, JSON.parse(String(value)));
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, String(value).replace(/\r\n/g, '\n'), 'utf8');
    }
  }

  const lint = lintPluginOrSidecar(outDir, { strict: true });
  const pluginDir = join(outDir, 'plugin');
  const pluginLint =
    isPlugin && existsSync(pluginDir)
      ? lintPluginOrSidecar(pluginDir, { strict: true })
      : { valid: true, errors: [], warnings: [] };

  if (!lint.valid || !pluginLint.valid) {
    const diagnostics = [
      ...lint.errors,
      ...lint.warnings,
      ...pluginLint.errors,
      ...pluginLint.warnings,
    ]
      .map((item) => `${item.ruleId} (${item.file}): ${item.message}`)
      .join('; ');
    throw new Error(`Scaffolded project failed strict lint: ${diagnostics}`);
  }

  return {
    id: names.id,
    archetype,
    pkgName: names.pkgName,
    pluginName: names.pluginName,
    displayName,
    outDir,
  };
}

export function scaffoldSidecarProject(opts = {}) {
  return scaffoldProject({
    ...opts,
    archetype: opts?.archetype || 'sidecar-ui',
  });
}
