/**
 * @fileoverview File layer builders for standalone sidecar archetypes (`sidecar-ui`, `sidecar-mcp`)
 * and shared sidecar UI/runtime entrypoints.
 */

import { buildPackageMetadata } from './base-layer.mjs';

function escapeHtml(raw = '') {
  return String(raw ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

export function buildIndexHtml(displayName) {
  const safeTitle = escapeHtml(displayName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <script src="/preload.js"></script>
  <link rel="stylesheet" href="/compiled_tailwind.css" />
  <link rel="stylesheet" href="/shell.css" />
  <link rel="stylesheet" href="/ui.css" />
  <link rel="stylesheet" href="/styles.css" />
  <script defer src="/shell.js"></script>
  <script defer src="/ui.js"></script>
</head>
<body>
  <main class="shell">
    <h1>${safeTitle}</h1>
    <p id="status">Connecting…</p>
  </main>
  <script src="/app.js"></script>
</body>
</html>
`;
}

export function buildStylesCss() {
  return `:root {
  color-scheme: dark light;
}
body {
  margin: 0;
  padding: 12px;
  background: var(--agy-canvas);
  color: var(--agy-ink);
  font-family: var(--agy-font-sans, var(--vscode-font-family, system-ui, sans-serif));
  font-size: var(--text-base, 0.875rem);
  line-height: 1.4285;
}
`;
}

export function buildUiAppJs() {
  return `(async function () {
  const fn = window.sidecar?.fetch || window.fetch.bind(window);
  const res = await fn('/api/status', { method: 'POST', body: '{}' });
  const data = await res.json();
  const el = document.getElementById('status');
  if (el) el.textContent = \`Active (\${data.timestamp})\`;
})();
`;
}

export function buildLaunchMjs(displayName) {
  return `import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSidecarLauncher } from 'antigravity-sidecar-kit/launcher';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

await runSidecarLauncher({
  targetPath: join(__dirname, 'server.mjs'),
  sidecarName: ${JSON.stringify(displayName)},
  repoRoot: __dirname,
});
`;
}

export function buildSidecarServerMjs({
  id,
  pluginName = '',
  archetype = 'sidecar-ui',
} = {}) {
  const isMcp = archetype === 'sidecar-mcp';
  const isPluginSidecar = archetype === 'plugin-sidecar';
  const stateSidecarId = isPluginSidecar && pluginName ? `${pluginName}--${id}` : id;
  const fsImports = isPluginSidecar
    ? "import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';"
    : "import { mkdtempSync, realpathSync, rmSync } from 'node:fs';";
  const mcpImport = isMcp
    ? "import { buildMcpTools, createInitialState } from './mcp.mjs';\n"
    : '';
  const sharedPrelude = isPluginSidecar
    ? `const sharedUrl = existsSync(new URL('../../lib/shared.mjs', import.meta.url))
  ? new URL('../../lib/shared.mjs', import.meta.url)
  : new URL('../../../lib/shared.mjs', import.meta.url);
const { getPluginSummary } = await import(sharedUrl.href);
`
    : '';
  const stateSyncExtra = isMcp
    ? `      mcpPath: '/api/mcp',
      initialState: createInitialState,
      mcpTools: buildMcpTools(),`
    : `      initialState: () => ({ status: 'active' }),`;
  const mcpRouteLine = isMcp
    ? `\n  app.api('/api/mcp', (data, ctx) => stateSync.handleMcp(data, ctx), 'POST');\n`
    : '';
  const statusPayloadFields = isPluginSidecar
    ? `    ok: true,
    ...getPluginSummary(),
    theme: resolveHostTheme(),
    timestamp: new Date().toISOString(),`
    : `    ok: true,
    sidecarId: SIDECAR_ID,
    theme: resolveHostTheme(),
    timestamp: new Date().toISOString(),`;

  return `${fsImports}
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FallbackResponse,
  createSidecarApp,
  exitWithLanguageServer,
  resolveHostTheme,
  resolveSidecarDataRoot,
  setupSidecarServer,
} from 'antigravity-sidecar-kit';
${mcpImport}
const sdk = await import('sidecar_sdk').catch(() => null);
const Response = sdk?.Response || FallbackResponse;
${sharedPrelude}const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const __dirname = dirname(MODULE_PATH);
const UI_DIR = join(__dirname, 'ui');
const SIDECAR_ID = ${JSON.stringify(id)};
const STATE_SIDECAR_ID = ${JSON.stringify(stateSidecarId)};
const UI_ASSETS = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
});

const isMain = (() => {
  try {
    return (
      !process.execArgv.includes('--test') &&
      realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH
    );
  } catch {
    return false;
  }
})();

export async function createServer(rawOpts = {}) {
  const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const hasExplicitEnv = Boolean(opts.env && typeof opts.env === 'object');
  const env = hasExplicitEnv ? opts.env : process.env;
  const uiToken =
    opts.uiToken !== undefined
      ? String(opts.uiToken)
      : String(env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
  const port =
    opts.port !== undefined
      ? Number(opts.port)
      : Number(env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  const ownedTempDir =
    !opts.dataDir && !opts.dataRoot && !hasExplicitEnv && !isMain
      ? mkdtempSync(join(tmpdir(), \`agy-\${STATE_SIDECAR_ID}-srv-\`))
      : '';
  const dataDir = opts.dataDir || ownedTempDir || undefined;
  const dataRoot =
    opts.dataRoot ||
    (!dataDir && (isMain || hasExplicitEnv) ? resolveSidecarDataRoot(env) : undefined);

  const app =
    opts.app ||
    createSidecarApp({
      port,
      host: opts.host || '127.0.0.1',
      uiToken,
    });

  const { sync: stateSync } = setupSidecarServer(app, {
    uiDir: opts.uiDir || UI_DIR,
    assets: UI_ASSETS,
    uiModules: ['core', 'controls', 'surfaces'],
    ResponseClass: Response,
    uiToken,
    stateSyncOptions: {
      sidecarId: STATE_SIDECAR_ID,
      ...(dataDir ? { dataDir } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      uiAuthToken: uiToken,
      ResponseClass: Response,
${stateSyncExtra}
    },
  });
${mcpRouteLine}
  app.api(
    '/api/status',
    async () => ({
${statusPayloadFields}
    }),
    'POST'
  );

  const origAppClose = app.close.bind(app);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stateSync?.stop?.();
    await origAppClose();
    if (ownedTempDir) {
      rmSync(ownedTempDir, { recursive: true, force: true });
    }
  };
  app.close = close;

  const server = opts.listen === false ? null : await app.run();
  return {
    app,
    stateSync,
    server,
    port: app.port,
    url: server ? \`http://\${app.host}:\${app.port}\` : null,
    close,
  };
}

if (isMain) {
  const { app, close } = await createServer({ listen: false });
  process.once('exit', () => {
    void close();
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      void close().finally(() => process.exit(0));
    });
  }
  await app.run();
  // Antigravity doesn't stop sidecars when it quits on Windows; exit once its language server is gone.
  exitWithLanguageServer({ app, onExit: close });
}
`;
}

export function buildSidecarMcpMjs({ id, displayName }) {
  return `#!/usr/bin/env node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSidecarDataRoot } from 'antigravity-sidecar-kit/config';
import { startStdioMcpBridge } from 'antigravity-sidecar-kit/state-sync';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const SIDECAR_ID = ${JSON.stringify(id)};

const isMain = (() => {
  try {
    return (
      !process.execArgv.includes('--test') &&
      realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH
    );
  } catch {
    return false;
  }
})();

export function createInitialState() {
  return { items: [], updatedAt: null };
}

export function buildMcpTools() {
  return [
    {
      name: 'status',
      description: ${JSON.stringify(`Returns current ${displayName} status and recorded item count.`)},
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { currentState }) => {
        const items = Array.isArray(currentState?.items) ? currentState.items : [];
        return {
          result: {
            ok: true,
            sidecarId: SIDECAR_ID,
            count: items.length,
            items,
            updatedAt: currentState?.updatedAt ?? null,
          },
        };
      },
    },
    {
      name: 'add_item',
      description: ${JSON.stringify(`Appends an item to ${displayName} state.`)},
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Item text to append.' },
        },
        required: ['text'],
      },
      handler: async (args, { currentState }) => {
        const text = String(args?.text ?? args?.title ?? args?.item ?? '').trim();
        if (!text) {
          return { error: { code: -32602, message: 'text is required' } };
        }
        const prevItems = Array.isArray(currentState?.items) ? currentState.items : [];
        const now = new Date().toISOString();
        const item = { id: \`item-\${prevItems.length + 1}\`, text, createdAt: now };
        const items = [...prevItems, item];
        return {
          patch: { items, updatedAt: now },
          result: { ok: true, item, items },
        };
      },
    },
  ];
}

export function startMcpStdio(rawOpts = {}) {
  const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const hasExplicitEnv = Boolean(opts.env && typeof opts.env === 'object');
  const env = hasExplicitEnv ? opts.env : process.env;
  const ownedTempDir =
    !opts.dataDir && !opts.dataRoot && !hasExplicitEnv && !isMain
      ? mkdtempSync(join(tmpdir(), \`agy-\${SIDECAR_ID}-mcp-\`))
      : '';
  const dataDir = opts.dataDir || (ownedTempDir || undefined);
  const dataRoot =
    opts.dataRoot ||
    (!dataDir && (isMain || hasExplicitEnv) ? resolveSidecarDataRoot(env) : undefined);

  const bridge = startStdioMcpBridge({
    sidecarId: SIDECAR_ID,
    ...(dataDir ? { dataDir } : {}),
    ...(dataRoot ? { dataRoot } : {}),
    mcpPath: opts.mcpPath || '/api/mcp',
    initialState: createInitialState,
    mcpTools: opts.mcpTools || buildMcpTools(),
    input: opts.input || process.stdin,
    output: opts.output || process.stdout,
    exitOnClose: Boolean(opts.exitOnClose),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.forwardTimeoutMs !== undefined ? { forwardTimeoutMs: opts.forwardTimeoutMs } : {}),
    ...(opts.serverInfoPath !== undefined ? { serverInfoPath: opts.serverInfoPath } : {}),
  });

  const cleanupTemp = () => {
    if (ownedTempDir) {
      rmSync(ownedTempDir, { recursive: true, force: true });
    }
  };
  const closed = bridge.closed.finally(cleanupTemp);
  const close = () => {
    bridge.close();
  };

  return { ...bridge, close, closed };
}

if (isMain) {
  startMcpStdio({ exitOnClose: true });
}
`;
}

export function buildSidecarSetupMjs({ id, archetype = 'sidecar-ui' }) {
  if (archetype === 'sidecar-mcp') {
    return `#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_JSON_PATH,
  DEFAULT_MCP_CONFIG_PATH,
  GLOBAL_SIDECARS_DIR,
  syncMcpServerConfig,
} from 'antigravity-sidecar-kit/config';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(MODULE_PATH);
const SIDECAR_ID = ${JSON.stringify(id)};

const isMain = (() => {
  try {
    return (
      !process.execArgv.includes('--test') &&
      realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH
    );
  } catch {
    return false;
  }
})();

export function parseMcpFlags(args = []) {
  let enableMcp = true;
  for (const raw of Array.isArray(args) ? args : []) {
    if (raw === '--no-mcp') enableMcp = false;
    else if (raw === '--with-mcp') enableMcp = true;
  }
  return { enableMcp };
}

export async function runSetup(args = process.argv.slice(2), options = {}) {
  const { enableMcp } = parseMcpFlags(args);
  const { mcpConfigPath, onUninstall: userOnUninstall, ...setupOpts } = options ?? {};
  const effectiveSidecarsDir = setupOpts.globalSidecarsDir || GLOBAL_SIDECARS_DIR;
  const isSandboxed =
    Boolean(mcpConfigPath) ||
    resolve(effectiveSidecarsDir) !== resolve(GLOBAL_SIDECARS_DIR) ||
    Boolean(
      setupOpts.configJsonPath && resolve(setupOpts.configJsonPath) !== resolve(CONFIG_JSON_PATH)
    );
  const callLsRpcFn = setupOpts.callLsRpcFn ?? (!isSandboxed ? callLsRpc : undefined);
  const resolveMcpPath = (cfgPath) =>
    mcpConfigPath ||
    (cfgPath ? join(dirname(resolve(cfgPath)), 'mcp_config.json') : DEFAULT_MCP_CONFIG_PATH);

  const res = await runSidecarSetup({
    sidecarId: SIDECAR_ID,
    repoRoot: setupOpts.repoRoot || REPO_ROOT,
    args,
    requiredFiles: [
      'sidecar.json',
      'hub-manifest.json',
      'launch.mjs',
      'server.mjs',
      'mcp.mjs',
      'ui/index.html',
      'ui/styles.css',
      'ui/app.js',
    ],
    testFiles: ['test/smoke.test.mjs'],
    ...setupOpts,
    onUninstall: async (ctx) => {
      await syncMcpServerConfig({
        serverName: SIDECAR_ID,
        uninstall: true,
        mcpConfigPath: resolveMcpPath(ctx.configJsonPath),
        sidecarId: SIDECAR_ID,
        callLsRpcFn,
      });
      if (typeof userOnUninstall === 'function') {
        await userOnUninstall(ctx);
      }
    },
  });

  if (!res.uninstalled && enableMcp) {
    await syncMcpServerConfig({
      serverName: SIDECAR_ID,
      command: process.execPath,
      args: [join(effectiveSidecarsDir, SIDECAR_ID, 'mcp.mjs')],
      enabled: true,
      mcpConfigPath: resolveMcpPath(setupOpts.configJsonPath),
      sidecarId: SIDECAR_ID,
      callLsRpcFn,
    });
  }

  return res;
}

if (isMain) {
  runSetup().catch((err) => {
    console.error(\`[\${SIDECAR_ID}] Setup failed:\`, err.message);
    process.exit(1);
  });
}
`;
  }

  return `#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSidecarSetup } from 'antigravity-sidecar-kit/setup';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(MODULE_PATH);
const SIDECAR_ID = ${JSON.stringify(id)};

const isMain = (() => {
  try {
    return (
      !process.execArgv.includes('--test') &&
      realpathSync(resolve(process.argv[1] || '')) === MODULE_PATH
    );
  } catch {
    return false;
  }
})();

export async function runSetup(args = process.argv.slice(2), options = {}) {
  return runSidecarSetup({
    sidecarId: SIDECAR_ID,
    repoRoot: options.repoRoot || REPO_ROOT,
    args,
    requiredFiles: [
      'sidecar.json',
      'hub-manifest.json',
      'launch.mjs',
      'server.mjs',
      'ui/index.html',
      'ui/styles.css',
      'ui/app.js',
    ],
    testFiles: ['test/smoke.test.mjs'],
    ...options,
  });
}

if (isMain) {
  runSetup().catch((err) => {
    console.error(\`[\${SIDECAR_ID}] Setup failed:\`, err.message);
    process.exit(1);
  });
}
`;
}

function buildSidecarSmokeTestMjs({ id, archetype }) {
  const isMcp = archetype === 'sidecar-mcp';
  const mcpImports = isMcp
    ? `import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { startMcpStdio } from '../mcp.mjs';
`
    : '';
  const mcpTestBlock = isMcp
    ? `
test('mcp.mjs handles initialize, tools/list, and tools/call over stdio', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'smoke-mcp-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input: output, crlfDelay: Infinity, terminal: false });
  const queue = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const nextMsg = () =>
    queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r));

  const bridge = startMcpStdio({ dataDir, input, output });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
    const init = await nextMsg();
    assert.equal(init.id, 1);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\\n');
    const list = await nextMsg();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('status'));
    assert.ok(names.includes('add_item'));

    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'add_item', arguments: { text: 'smoke item' } },
      }) + '\\n'
    );
    const added = await nextMsg();
    const body = JSON.parse(added.result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1);
  } finally {
    rl.close();
    input.end();
    bridge.close();
    await bridge.closed;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
`
    : '';

  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPluginOrSidecar } from 'antigravity-sidecar-kit/validator';
import { createServer } from '../server.mjs';
${mcpImports}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('manifests pass strict validation', () => {
  const lint = lintPluginOrSidecar(ROOT, { strict: true });
  assert.equal(lint.valid, true, JSON.stringify(lint));
  const hub = JSON.parse(readFileSync(join(ROOT, 'hub-manifest.json'), 'utf8'));
  assert.equal(hub.id, ${JSON.stringify(id)});
});

test('server.mjs serves health and token-protected UI', async () => {
  const srv = await createServer({ port: 0, uiToken: 'test-tok' });
  try {
    const health = await fetch(\`\${srv.url}/_sidecar/health\`);
    assert.equal(health.status, 200);
    const page = await fetch(\`\${srv.url}/index.html?token=test-tok\`);
    assert.equal(page.status, 200);
  } finally {
    await srv.close();
  }
});
${mcpTestBlock}`;
}

export function buildSidecarJson({
  displayName,
  description,
  entrypoint,
  hideTitleBar = false,
  includeAgentPermissions = true,
}) {
  return {
    command: 'node',
    args: ['launch.mjs'],
    display_name: displayName,
    description,
    has_web_ui: true,
    restart_policy: 'always',
    sandbox: {
      disable_sandbox: true,
    },
    ui_config: {
      display_name: displayName,
      views: [
        {
          entrypoint,
          path: '/',
          title: displayName,
          ...(hideTitleBar ? { title_bar_style: 'SIDECAR_UI_TITLE_BAR_STYLE_HIDDEN' } : {}),
        },
      ],
    },
    ...(includeAgentPermissions ? { agent_permissions: { workspace_uris: [] } } : {}),
  };
}

/**
 * Builds the `sidecar-ui` or `sidecar-mcp` file map (`relPath -> string | object`).
 */
export function buildSidecarLayer({
  archetype = 'sidecar-ui',
  id,
  pkgName,
  folderName,
  bins,
  displayName,
  description,
  entrypoint,
  hideTitleBar = false,
  authorName = 'Sidecar Author',
  githubOwner = '',
  kitVersion,
}) {
  const isMcp = archetype === 'sidecar-mcp';
  const resolvedAuthor = String(authorName || 'Sidecar Author').trim() || 'Sidecar Author';
  const resolvedDescription =
    (typeof description === 'string' && description.trim()) ||
    (isMcp
      ? `${displayName} Auxiliary Pane sidecar and stdio MCP server for Google Antigravity.`
      : `${displayName} Auxiliary Pane sidecar for Google Antigravity.`);

  const meta = buildPackageMetadata({
    pkgName,
    folderName,
    description: resolvedDescription,
    authorName: resolvedAuthor,
    githubOwner,
  });

  const packageJson = {
    name: pkgName,
    version: '1.0.0',
    type: 'module',
    description: resolvedDescription,
    license: 'MIT',
    ...meta,
    files: isMcp
      ? ['sidecar.json', 'hub-manifest.json', 'launch.mjs', 'server.mjs', 'mcp.mjs', 'setup.mjs', 'ui']
      : ['sidecar.json', 'hub-manifest.json', 'launch.mjs', 'server.mjs', 'setup.mjs', 'ui'],
    bin: bins,
    engines: { node: '>=20.0.0' },
    dependencies: { 'antigravity-sidecar-kit': `^${kitVersion}` },
    devDependencies: { linkedom: '^0.18.15' },
    scripts: {
      start: 'node launch.mjs',
      setup: 'node setup.mjs',
      'setup:copy': 'node setup.mjs --copy',
      uninstall: 'node setup.mjs --uninstall',
      test: 'node --test test/*.test.mjs',
      'validate:manifest': 'agy-sidecar-kit lint',
      'test:pack': 'agy-sidecar-kit pack-smoke',
      prepublishOnly: 'npm test && npm run validate:manifest && npm run test:pack',
    },
  };

  const hubManifest = {
    id,
    name: displayName,
    tagline: resolvedDescription,
    description: resolvedDescription,
    version: '1.0.0',
    author: {
      name: resolvedAuthor,
      ...(githubOwner ? { github: githubOwner } : {}),
    },
    license: 'MIT',
    pricing: 'free',
    categories: ['utilities'],
    capabilityTier: isMcp ? 'TIER_2_LOCAL_TOOLING' : 'TIER_1_TELEMETRY',
    workspaceTriggers: { files: ['package.json'] },
    minAntigravityVersion: '2.0.0',
  };

  const files = new Map();
  files.set('package.json', packageJson);
  files.set(
    'sidecar.json',
    buildSidecarJson({
      displayName,
      description: resolvedDescription,
      entrypoint,
      hideTitleBar,
      includeAgentPermissions: true,
    })
  );
  files.set('hub-manifest.json', hubManifest);
  files.set('launch.mjs', buildLaunchMjs(displayName));
  files.set('server.mjs', buildSidecarServerMjs({ id, archetype }));
  if (isMcp) {
    files.set('mcp.mjs', buildSidecarMcpMjs({ id, displayName }));
  }
  files.set('setup.mjs', buildSidecarSetupMjs({ id, archetype }));
  files.set('ui/index.html', buildIndexHtml(displayName));
  files.set('ui/styles.css', buildStylesCss());
  files.set('ui/app.js', buildUiAppJs());
  files.set('test/smoke.test.mjs', buildSidecarSmokeTestMjs({ id, archetype }));
  return files;
}
