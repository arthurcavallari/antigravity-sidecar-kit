/**
 * @fileoverview Shared base repository layer (.gitignore, .gitattributes, LICENSE, README.md, CI workflows)
 * and package.json repository metadata helper for Antigravity archetypes.
 */

import { readFileSync } from 'node:fs';
import { ARCHETYPES, resolveProjectNames, toDisplayName } from './naming.mjs';

const GITHUB_OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function readWorkflowAsset(filename) {
  return readFileSync(new URL(`./workflows/${filename}`, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
}

export function normalizeGithubOwner(rawOwner = '') {
  if (rawOwner === undefined || rawOwner === null) return '';
  if (typeof rawOwner !== 'string') {
    throw new Error('Invalid GitHub owner: expected a string.');
  }
  let cleaned = rawOwner.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
  if (!cleaned || cleaned.includes('..') || !GITHUB_OWNER_RE.test(cleaned)) {
    throw new Error(`Invalid GitHub owner "${rawOwner}".`);
  }
  return cleaned;
}

export function buildGitignore() {
  return [
    'node_modules/',
    'dist/',
    '*.tgz',
    '*.sha256',
    '*.log',
    'npm-debug.log*',
    '.env',
    '.env.*',
    'coverage/',
    'tmp/',
    '.idea/',
    '.vscode/',
    '.DS_Store',
    'Thumbs.db',
    '.superpowers/',
    '.worktrees/',
    'docs/superpowers/',
    '',
  ].join('\n');
}

export function buildGitattributes() {
  return [
    '* text=auto eol=lf',
    '*.mjs text eol=lf',
    '*.js text eol=lf',
    '*.json text eol=lf',
    '*.css text eol=lf',
    '*.html text eol=lf',
    '*.md text eol=lf',
    '*.yml text eol=lf',
    '*.yaml text eol=lf',
    '',
  ].join('\n');
}

export function buildMitLicense({ authorName = 'Sidecar Author', year } = {}) {
  const resolvedYear = year ?? new Date().getUTCFullYear();
  const resolvedAuthor = String(authorName || 'Sidecar Author').trim() || 'Sidecar Author';
  return `MIT License

Copyright (c) ${resolvedYear} ${resolvedAuthor}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function defaultDescriptionFor(archetype, displayName) {
  if (archetype === 'sidecar-mcp') {
    return `${displayName} Auxiliary Pane sidecar and stdio MCP server for Google Antigravity.`;
  }
  if (archetype === 'plugin') {
    return `${displayName} native plugin for Google Antigravity.`;
  }
  if (archetype === 'plugin-sidecar') {
    return `${displayName} native plugin and companion sidecar for Google Antigravity.`;
  }
  return `${displayName} Auxiliary Pane sidecar for Google Antigravity.`;
}

export function buildReadme({
  archetype,
  pkgName,
  pluginName,
  displayName,
  description,
}) {
  const isStandaloneSidecar = archetype === 'sidecar-ui' || archetype === 'sidecar-mcp';
  const summary =
    (typeof description === 'string' && description.trim()) ||
    defaultDescriptionFor(archetype, displayName);

  if (isStandaloneSidecar) {
    const mcpNote =
      archetype === 'sidecar-mcp'
        ? '\nPass `--no-mcp` to `node setup.mjs --no-mcp` to skip global MCP server registration.\n'
        : '';
    return `# ${displayName}

${summary}

## Quick Start

\`\`\`bash
npx ${pkgName}
\`\`\`

Or from a local checkout:

\`\`\`bash
npm install
npm run setup
\`\`\`
${mcpNote}
To remove the sidecar registration:

\`\`\`bash
npm run uninstall
\`\`\`

## Development

\`\`\`bash
npm start
npm test
npm run validate:manifest
npm run test:pack
\`\`\`

## License

MIT
`;
  }

  return `# ${displayName}

${summary}

## Quick Start

Build and install the Antigravity plugin locally:

\`\`\`bash
npm install
npm run build:plugin
agy plugin install ./dist/plugin/${pluginName}
\`\`\`

## Development

\`\`\`bash
npm test
npm run validate:manifest
npm run build:plugin
npm run test:pack
\`\`\`

## License

MIT
`;
}

/**
 * Builds the `author` and optional GitHub `homepage` / `bugs` / `repository` fields for `package.json`.
 *
 * @param {{
 *   pkgName?: string,
 *   folderName?: string,
 *   description?: string,
 *   authorName?: string,
 *   githubOwner?: string,
 * }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildPackageMetadata(options = {}) {
  const {
    pkgName = '',
    folderName = '',
    description,
    authorName = 'Sidecar Author',
    githubOwner = '',
  } = options ?? {};

  const resolvedAuthor = String(authorName || 'Sidecar Author').trim() || 'Sidecar Author';
  const owner = normalizeGithubOwner(githubOwner);
  const trimmedDesc =
    typeof description === 'string' && description.trim() ? description.trim() : '';

  const meta = {
    ...(trimmedDesc ? { description: trimmedDesc } : {}),
    author: owner
      ? { name: resolvedAuthor, url: `https://github.com/${owner}` }
      : { name: resolvedAuthor },
  };

  if (!owner) {
    return meta;
  }

  const rawSlug =
    String(folderName || '').trim() ||
    (typeof pkgName === 'string' && pkgName.includes('/')
      ? pkgName.split('/')[1]
      : String(pkgName || '').trim());
  if (!rawSlug || rawSlug.includes('..') || !REPO_SLUG_RE.test(rawSlug)) {
    throw new Error('A valid folderName or pkgName is required when githubOwner is specified.');
  }

  meta.homepage = `https://github.com/${owner}/${rawSlug}#readme`;
  meta.bugs = {
    url: `https://github.com/${owner}/${rawSlug}/issues`,
  };
  meta.repository = {
    type: 'git',
    url: `git+https://github.com/${owner}/${rawSlug}.git`,
  };

  return meta;
}

/**
 * Builds the shared base layer Map (`relPath -> utf8Content`) for any archetype.
 *
 * @param {{
 *   archetype?: string,
 *   id?: string,
 *   pkgName?: string,
 *   folderName?: string,
 *   pluginName?: string,
 *   displayName?: string,
 *   description?: string,
 *   authorName?: string,
 *   githubOwner?: string,
 *   ci?: boolean,
 *   year?: number,
 * }} [options]
 * @returns {Map<string, string>}
 */
export function buildBaseLayer(options = {}) {
  const {
    archetype = 'sidecar-ui',
    id,
    pkgName,
    folderName,
    pluginName,
    displayName,
    description,
    authorName = 'Sidecar Author',
    githubOwner = '',
    ci = true,
    year,
  } = options ?? {};

  if (typeof archetype !== 'string' || !ARCHETYPES.includes(archetype)) {
    throw new Error(
      `Unknown archetype "${String(archetype)}". Expected one of: ${ARCHETYPES.join(', ')}`
    );
  }

  normalizeGithubOwner(githubOwner);

  const fallbackSeed = id || pluginName || folderName || pkgName;
  const fallbackNames =
    (!id || !pkgName || !folderName || !pluginName) && fallbackSeed
      ? resolveProjectNames({ name: fallbackSeed, archetype, pkgName })
      : null;

  const resolvedId = id || fallbackNames?.id || '';
  const resolvedPkgName = pkgName || fallbackNames?.pkgName || '';
  const resolvedFolderName = folderName || fallbackNames?.folderName || '';
  const resolvedPluginName = pluginName || fallbackNames?.pluginName || '';
  const resolvedDisplayName =
    displayName || fallbackNames?.displayName || toDisplayName(resolvedId) || resolvedId;

  if (
    !resolvedId ||
    !PLUGIN_SLUG_RE.test(resolvedId) ||
    !resolvedPkgName ||
    !NPM_PACKAGE_RE.test(resolvedPkgName) ||
    !resolvedFolderName ||
    resolvedFolderName.includes('..') ||
    !REPO_SLUG_RE.test(resolvedFolderName)
  ) {
    throw new Error('buildBaseLayer requires valid resolved project names (id, pkgName, folderName).');
  }

  const isPluginArchetype = archetype === 'plugin' || archetype === 'plugin-sidecar';
  if (isPluginArchetype && (!resolvedPluginName || !PLUGIN_SLUG_RE.test(resolvedPluginName))) {
    throw new Error(`Invalid pluginName "${String(resolvedPluginName)}".`);
  }

  const files = new Map();
  files.set('.gitignore', buildGitignore());
  files.set('.gitattributes', buildGitattributes());
  files.set('LICENSE', buildMitLicense({ authorName, year }));
  files.set(
    'README.md',
    buildReadme({
      archetype,
      pkgName: resolvedPkgName,
      pluginName: resolvedPluginName,
      displayName: resolvedDisplayName,
      description,
    })
  );

  if (ci !== false) {
    files.set('.github/dependabot.yml', readWorkflowAsset('dependabot.yml'));
    files.set('.github/workflows/codeql.yml', readWorkflowAsset('codeql.yml'));
    if (isPluginArchetype) {
      files.set('.github/workflows/test.yml', readWorkflowAsset('test-plugin.yml'));
      files.set(
        '.github/workflows/release.yml',
        readWorkflowAsset('release-plugin.yml').replaceAll('{{PLUGIN_NAME}}', resolvedPluginName)
      );
    } else {
      files.set('.github/workflows/test.yml', readWorkflowAsset('test-sidecar.yml'));
      files.set('.github/workflows/release.yml', readWorkflowAsset('release-sidecar.yml'));
    }
  }

  return files;
}
