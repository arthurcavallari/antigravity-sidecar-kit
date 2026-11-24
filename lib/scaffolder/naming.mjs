/**
 * @fileoverview Prefix-preserving project naming and validation for Antigravity archetypes.
 */

export const ARCHETYPES = Object.freeze([
  'sidecar-ui',
  'sidecar-mcp',
  'plugin',
  'plugin-sidecar',
]);

export const PLUGIN_COMPONENTS = Object.freeze([
  'skills',
  'mcp',
  'rules',
  'hooks',
  'agents',
]);

export const RESERVED_SIDECAR_IDS = Object.freeze(['hangar', 'sidecar-hub']);
const RESERVED_SIDECAR_SET = new Set(RESERVED_SIDECAR_IDS);

const KNOWN_PREFIXES = ['antigravity-sidecar-', 'antigravity-', 'agy-'];
const SLUG_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NPM_SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/;
const NPM_UNSCOPED_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Converts a kebab/snake slug into Title Case.
 * @param {string} [id]
 * @returns {string}
 */
export function toDisplayName(id = '') {
  return String(id || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function trimEdgeChars(str, chars) {
  let start = 0;
  let end = str.length;
  while (start < end && chars.includes(str[start])) start++;
  while (end > start && chars.includes(str[end - 1])) end--;
  return str.slice(start, end);
}

function sanitizeSlug(raw) {
  const collapsed = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return trimEdgeChars(collapsed, '-_');
}

function parseProjectNameInput(rawInput) {
  if (typeof rawInput !== 'string') {
    throw new Error('A valid project name is required.');
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('A valid project name is required.');
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`Invalid project name "${trimmed}": control characters are not allowed.`);
  }
  if (trimmed.includes('\\') || trimmed.includes(':')) {
    throw new Error(`Invalid project name "${trimmed}": path separators are not allowed.`);
  }
  if (trimmed.includes('..') || trimmed.startsWith('.')) {
    throw new Error(`Invalid project name "${trimmed}": path traversal segments are not allowed.`);
  }

  if (trimmed.includes('/')) {
    if (!trimmed.startsWith('@')) {
      throw new Error(
        `Invalid project name "${trimmed}": path separators are only allowed in @scope/name.`
      );
    }
    const parts = trimmed.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid scoped project name "${trimmed}": expected a single @scope/name pair.`
      );
    }
    const scope = parts[0].toLowerCase();
    const rawBase = parts[1];
    if (!NPM_SCOPE_RE.test(scope)) {
      throw new Error(`Invalid npm scope "${parts[0]}" in "${trimmed}".`);
    }
    if (rawBase.startsWith('.')) {
      throw new Error(`Invalid project name "${trimmed}": package basename cannot start with a dot.`);
    }
    return { scope, rawBase, trimmed };
  }

  if (trimmed.startsWith('@')) {
    throw new Error(`Invalid scoped project name "${trimmed}": expected @scope/name.`);
  }
  return { scope: '', rawBase: trimmed, trimmed };
}

/**
 * Resolves consistent project, package, directory, plugin, and bin identifiers for an archetype.
 *
 * @param {{
 *   name: string,
 *   archetype?: string,
 *   pkgName?: string,
 *   pkgNameOverride?: string,
 * }} [options]
 * @returns {{
 *   id: string,
 *   pkgName: string,
 *   folderName: string,
 *   pluginName: string,
 *   displayName: string,
 *   bins: Record<string, string>,
 * }}
 */
export function resolveProjectNames(options = {}) {
  const { name, archetype = 'sidecar-ui' } = options ?? {};
  if (typeof archetype !== 'string' || !ARCHETYPES.includes(archetype)) {
    throw new Error(
      `Unknown archetype "${String(archetype)}". Expected one of: ${ARCHETYPES.join(', ')}`
    );
  }

  const { scope, rawBase, trimmed } = parseProjectNameInput(name);
  const lowerBase = rawBase.toLowerCase();
  const isStandaloneSidecar = archetype === 'sidecar-ui' || archetype === 'sidecar-mcp';

  if (isStandaloneSidecar && lowerBase === 'antigravity-sidecar-hub') {
    throw new Error('Sidecar ID "sidecar-hub" is reserved by Antigravity Hangar.');
  }

  let matchedPrefix = '';
  for (const prefix of KNOWN_PREFIXES) {
    if (lowerBase.startsWith(prefix)) {
      const remainder = sanitizeSlug(lowerBase.slice(prefix.length));
      if (remainder) {
        matchedPrefix = prefix;
      }
      break;
    }
  }

  const hasExplicitPrefix = Boolean(scope || matchedPrefix);
  const id = sanitizeSlug(matchedPrefix ? lowerBase.slice(matchedPrefix.length) : lowerBase);
  if (!id || !SLUG_ID_RE.test(id)) {
    throw new Error(`Invalid project name "${trimmed}": could not derive a valid slug ID.`);
  }

  if (isStandaloneSidecar && RESERVED_SIDECAR_SET.has(id)) {
    throw new Error(`Sidecar ID "${id}" is reserved by Antigravity Hangar.`);
  }

  const rawPkgOverride =
    options?.pkgName !== undefined && options.pkgName !== ''
      ? options.pkgName
      : options?.pkgNameOverride;

  let resolvedPkgName;
  if (rawPkgOverride !== undefined && rawPkgOverride !== '') {
    if (typeof rawPkgOverride !== 'string') {
      throw new Error('Invalid npm package name override.');
    }
    const candidate = rawPkgOverride.trim();
    if (
      !candidate ||
      candidate.length > 214 ||
      candidate.includes('..') ||
      candidate.includes('\\') ||
      !NPM_PACKAGE_RE.test(candidate)
    ) {
      throw new Error(`Invalid npm package name "${rawPkgOverride}".`);
    }
    resolvedPkgName = candidate;
  } else if (hasExplicitPrefix) {
    const normalizedBase = trimEdgeChars(
      lowerBase.replace(/[^a-z0-9._-]+/g, '-'),
      '-._'
    );
    if (!normalizedBase || normalizedBase.includes('..') || !NPM_UNSCOPED_RE.test(normalizedBase)) {
      throw new Error(`Invalid project name "${trimmed}": cannot form a valid npm package name.`);
    }
    resolvedPkgName = scope ? `${scope}/${normalizedBase}` : normalizedBase;
    if (resolvedPkgName.length > 214 || !NPM_PACKAGE_RE.test(resolvedPkgName)) {
      throw new Error(`Invalid npm package name "${resolvedPkgName}".`);
    }
  } else {
    resolvedPkgName = isStandaloneSidecar ? `antigravity-${id}` : `agy-${id}`;
  }

  const folderName = resolvedPkgName.includes('/')
    ? resolvedPkgName.split('/')[1]
    : resolvedPkgName;
  const pluginName = sanitizeSlug(folderName);
  if (!pluginName || !SLUG_ID_RE.test(pluginName)) {
    throw new Error(`Invalid plugin name derived from "${folderName}".`);
  }

  const displayName = toDisplayName(id) || id;
  const bins = {};
  if (isStandaloneSidecar) {
    bins[`antigravity-${id}`] = './setup.mjs';
    bins[`agy-${id}`] = './setup.mjs';
    if (folderName !== `antigravity-${id}` && folderName !== `agy-${id}`) {
      bins[folderName] = './setup.mjs';
    }
  }

  return {
    id,
    pkgName: resolvedPkgName,
    folderName,
    pluginName,
    displayName,
    bins,
  };
}
