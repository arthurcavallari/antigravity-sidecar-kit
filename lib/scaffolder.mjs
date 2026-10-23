/**
 * @fileoverview Scaffolds a minimal, Hangar-compatible Antigravity sidecar project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonNoBom } from './config.mjs';

const KIT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function sanitizeSidecarName(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^antigravity-sidecar-|^antigravity-|^agy-/i, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toDisplayName(id = '') {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function scaffoldSidecarProject({ name, targetDir, force = false } = {}) {
  const id = sanitizeSidecarName(name);
  if (!id) {
    throw new Error('A valid sidecar name is required (e.g. "agy-sidecar-kit init my-sidecar")');
  }
  const displayName = toDisplayName(id) || id;
  const pkgName = `antigravity-${id}`;
  const outDir = resolve(targetDir || join(process.cwd(), pkgName));

  if (existsSync(join(outDir, 'package.json')) && !force) {
    throw new Error(`Target directory already contains a package.json: ${outDir}`);
  }

  mkdirSync(join(outDir, 'ui'), { recursive: true });
  mkdirSync(join(outDir, 'test'), { recursive: true });

  writeJsonNoBom(join(outDir, 'package.json'), {
    name: pkgName,
    version: '1.0.0',
    type: 'module',
    description: `${displayName} sidecar for Google Antigravity.`,
    license: 'MIT',
    files: ['sidecar.json', 'hub-manifest.json', 'server.mjs', 'setup.mjs', 'ui', 'test'],
    bin: {
      [pkgName]: './setup.mjs',
    },
    engines: { node: '>=20.0.0' },
    dependencies: {
      'antigravity-sidecar-kit': `^${KIT_VERSION}`,
    },
    scripts: {
      start: 'node server.mjs',
      setup: 'node setup.mjs',
      uninstall: 'node setup.mjs --uninstall',
      test: 'node --test test/*.test.mjs',
    },
  });

  writeJsonNoBom(join(outDir, 'sidecar.json'), {
    command: 'node',
    args: ['server.mjs'],
    display_name: displayName,
    description: `${displayName} Auxiliary Pane sidecar for Google Antigravity.`,
    has_web_ui: true,
    restart_policy: 'always',
    ui_config: {
      display_name: displayName,
      views: [
        {
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
          path: '/',
          title: displayName,
        },
      ],
    },
    agent_permissions: {
      workspace_uris: [],
      allows_user_interactions: true,
    },
  });

  writeJsonNoBom(join(outDir, 'hub-manifest.json'), {
    id,
    name: displayName,
    tagline: `${displayName} Auxiliary Pane sidecar for Google Antigravity.`,
    version: '1.0.0',
    license: 'MIT',
    pricing: 'free',
    categories: ['productivity'],
    capabilityTier: 'TIER_1_TELEMETRY',
    workspaceTriggers: { files: ['*'] },
    minAntigravityVersion: '2.0.0',
  });

  writeFileSync(
    join(outDir, 'setup.mjs'),
    `#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';

const REPO_ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));

runSidecarSetup({
  sidecarId: '${id}',
  repoRoot: REPO_ROOT,
  requiredFiles: ['sidecar.json', 'server.mjs', 'ui/index.html', 'ui/styles.css', 'ui/app.js'],
  testFiles: ['test/smoke.test.mjs'],
}).catch((err) => {
  console.error('[${id}] Setup failed:', err.message);
  process.exit(1);
});
`,
    'utf8'
  );

  writeFileSync(
    join(outDir, 'server.mjs'),
    `import { SidecarApp, Response } from 'sidecar_sdk';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetHandler, createAgyCssHandler } from 'antigravity-sidecar-kit/server';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const UI_DIR = join(__dirname, 'ui');

// Pass the SDK's Response class so SidecarApp's instanceof checks recognise handler results
const serveAsset = (relPath, contentType) =>
  createAssetHandler(UI_DIR, relPath, contentType, { ResponseClass: Response });

const app = new SidecarApp();
app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/app.js', serveAsset('app.js', 'text/javascript; charset=utf-8'));

app.api('/api/status', async () => ({
  ok: true,
  sidecarId: '${id}',
  theme: resolveHostTheme(),
  timestamp: new Date().toISOString(),
}), 'POST');

await app.run();
// Antigravity doesn't stop sidecars when it quits on Windows; exit once its language server is gone.
exitWithLanguageServer({ app });
`,
    'utf8'
  );

  writeFileSync(
    join(outDir, 'ui', 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${displayName}</title>
  <script src="/preload.js"></script>
  <link rel="stylesheet" href="/compiled_tailwind.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="shell">
    <h1>${displayName}</h1>
    <p id="status">Connecting…</p>
  </main>
  <script src="/app.js"></script>
</body>
</html>
`,
    'utf8'
  );

  writeFileSync(
    join(outDir, 'ui', 'styles.css'),
    `:root {
  color-scheme: dark light;
}
body {
  margin: 0;
  padding: 12px;
  background: var(--background, #181818);
  color: var(--foreground, #ffffff);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
}
`,
    'utf8'
  );

  writeFileSync(
    join(outDir, 'ui', 'app.js'),
    `(async function () {
  const fn = window.sidecar?.fetch || window.fetch.bind(window);
  const res = await fn('/api/status', { method: 'POST', body: '{}' });
  const data = await res.json();
  const el = document.getElementById('status');
  if (el) el.textContent = \`Active (\${data.timestamp})\`;
})();
`,
    'utf8'
  );

  writeFileSync(
    join(outDir, 'test', 'smoke.test.mjs'),
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('sidecar.json and hub-manifest.json are valid', () => {
  const sidecar = JSON.parse(readFileSync(join(ROOT, 'sidecar.json'), 'utf8'));
  const hub = JSON.parse(readFileSync(join(ROOT, 'hub-manifest.json'), 'utf8'));
  assert.equal(sidecar.command, 'node');
  assert.equal(hub.id, '${id}');
});
`,
    'utf8'
  );

  return { id, pkgName, displayName, outDir };
}
