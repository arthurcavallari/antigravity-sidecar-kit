/**
 * @fileoverview File layer builders for Antigravity native plugin archetypes (`plugin`, `plugin-sidecar`).
 */

import { buildPackageMetadata } from './base-layer.mjs';
import { PLUGIN_COMPONENTS } from './naming.mjs';
import {
  buildIndexHtml,
  buildLaunchMjs,
  buildSidecarJson,
  buildSidecarServerMjs,
  buildStylesCss,
  buildUiAppJs,
} from './sidecar-layers.mjs';

export function normalizePluginComponents(
  rawComponents = ['skills', 'mcp'],
  { archetype = 'plugin' } = {}
) {
  let list;
  if (rawComponents === undefined) {
    list = ['skills', 'mcp'];
  } else if (typeof rawComponents === 'string') {
    list = rawComponents.trim()
      ? rawComponents
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [];
  } else if (Array.isArray(rawComponents)) {
    list = rawComponents.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`Invalid plugin component "${String(item)}".`);
      }
      return item.trim().toLowerCase();
    });
  } else {
    throw new Error(
      `Invalid plugin components: expected an array or comma-separated list of ${PLUGIN_COMPONENTS.join(', ')}.`
    );
  }

  const deduped = [];
  const seen = new Set();
  for (const comp of list) {
    if (!PLUGIN_COMPONENTS.includes(comp)) {
      throw new Error(
        `Unknown plugin component "${comp}". Expected subset of: ${PLUGIN_COMPONENTS.join(', ')}`
      );
    }
    if (!seen.has(comp)) {
      seen.add(comp);
      deduped.push(comp);
    }
  }

  if (archetype === 'plugin' && deduped.length === 0) {
    throw new Error(
      `Archetype "plugin" requires at least one component (${PLUGIN_COMPONENTS.join(', ')}).`
    );
  }

  return deduped;
}

function buildSkillMd({ id, displayName }) {
  const desc = `Use when working with ${displayName} workflows and guidance in Google Antigravity.`;
  return `---
name: ${id}
description: ${JSON.stringify(desc)}
---

# ${displayName}

## Overview

Starter skill for **${displayName}**. Replace these instructions with domain-specific workflows, invariants, and verification steps.

## Workflow

1. Inspect the active workspace before proposing changes.
2. Follow project conventions and run automated checks before completion.
`;
}

function buildRulesMd({ displayName }) {
  return `# ${displayName} Workspace Rules

- Keep changes minimal, deterministic, and covered by automated tests.
- Verify relevant manifests and scripts before reporting completion.
`;
}

function buildAgentMd({ id, displayName }) {
  const desc = `Specialist subagent for ${displayName} analysis and verification tasks.`;
  return `---
name: ${id}
description: ${JSON.stringify(desc)}
---

# ${displayName} Specialist

Focus on scoped ${displayName} tasks, verify findings against source files, and return concise, actionable summaries.
`;
}

function buildPluginMcpServerMjs({ pluginName }) {
  return `#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const SERVER_NAME = MANIFEST.name || ${JSON.stringify(pluginName)};
const SERVER_VERSION = MANIFEST.version || '1.0.0';

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

export const TOOLS = Object.freeze([
  {
    name: 'ping',
    description: 'Health check tool that echoes an optional message.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional message to echo back.',
        },
      },
    },
  },
]);

export function startPluginMcpStdio({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const write = (payload) => {
    output.write(\`\${JSON.stringify({ jsonrpc: '2.0', ...payload })}\\n\`);
  };

  const handleMessage = async (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      write({ id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const { id, method, params = {} } = msg;
    const isNotification = !Object.hasOwn(msg, 'id') || id === undefined;
    if (isNotification) return;

    switch (method) {
      case 'server/discover':
        write({
          id,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'],
            capabilities: { tools: {} },
            resultType: 'complete',
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
            },
          },
        });
        return;
      case 'initialize':
        write({
          id,
          result: {
            protocolVersion:
              typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
        return;
      case 'ping':
        write({ id, result: {} });
        return;
      case 'prompts/list':
        write({ id, result: { prompts: [] } });
        return;
      case 'resources/list':
        write({ id, result: { resources: [] } });
        return;
      case 'resources/templates/list':
        write({ id, result: { resourceTemplates: [] } });
        return;
      case 'tools/list':
        write({ id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        if (params?.name !== 'ping') {
          write({ id, error: { code: -32601, message: \`Unknown tool: \${String(params?.name || '')}\` } });
          return;
        }
        const echo =
          typeof params?.arguments?.message === 'string' && params.arguments.message
            ? params.arguments.message
            : 'pong';
        const body = { ok: true, plugin: SERVER_NAME, echo };
        write({
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(body) }],
          },
        });
        return;
      }
      default:
        write({ id, error: { code: -32601, message: \`Method not found: \${String(method || '')}\` } });
    }
  };

  let queue = Promise.resolve();
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue
      .then(() => {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          write({ id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        return handleMessage(parsed);
      })
      .catch((err) => {
        write({ id: null, error: { code: -32603, message: err?.message || String(err) } });
      });
  });

  const closed = new Promise((resolveClosed) => {
    rl.once('close', () => {
      queue.finally(resolveClosed);
    });
  });

  return {
    close() {
      rl.close();
    },
    closed,
  };
}

if (isMain) {
  startPluginMcpStdio();
}
`;
}

function buildSessionStartHookMjs() {
  return `import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookEnvelope, writeHookResult } from 'antigravity-sidecar-kit/hooks';

const MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));

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

export async function runSessionStartHook({
  stream = process.stdin,
  output = process.stdout,
  env = process.env,
} = {}) {
  const envelope = await readHookEnvelope({ stream, env });
  await writeHookResult({}, { stream: output, platform: envelope.platform, hookEvent: 'SessionStart' });
  return envelope;
}

if (isMain) {
  const timer = setTimeout(() => {
    process.stdout.write('{}', () => process.exit(0));
  }, 4000);
  timer.unref();

  runSessionStartHook()
    .then(() => process.exit(0))
    .catch(() => {
      process.stdout.write('{}', () => process.exit(0));
    });
}
`;
}

function buildSharedMjs({ pluginName, id }) {
  return `export const PLUGIN_NAME = ${JSON.stringify(pluginName)};
export const SIDECAR_ID = ${JSON.stringify(id)};

export function getPluginSummary() {
  return {
    pluginName: PLUGIN_NAME,
    sidecarId: SIDECAR_ID,
  };
}
`;
}

function buildPluginSmokeTestMjs({
  id,
  pluginName,
  hasSidecar,
  hasMcp,
  hasHooks,
}) {
  const extraNodeImports = [];
  if (hasSidecar) {
    extraNodeImports.push("import { existsSync, mkdtempSync, rmSync } from 'node:fs';");
    extraNodeImports.push("import { tmpdir } from 'node:os';");
    extraNodeImports.push("import { pathToFileURL } from 'node:url';");
  } else {
    extraNodeImports.push("import { mkdtempSync, rmSync } from 'node:fs';");
    extraNodeImports.push("import { tmpdir } from 'node:os';");
  }
  if (hasMcp) {
    extraNodeImports.push("import { createInterface } from 'node:readline';");
  }
  if (hasMcp || hasHooks) {
    extraNodeImports.push("import { PassThrough } from 'node:stream';");
  }

  const mcpImport = hasMcp
    ? "import { startPluginMcpStdio } from '../plugin/mcp/server.mjs';\n"
    : '';
  const hooksImport = hasHooks
    ? "import { runSessionStartHook } from '../plugin/scripts/session-start.mjs';\n"
    : '';

  const mcpTest = hasMcp
    ? `
test('plugin MCP server exposes ping tool over stdio', async () => {
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

  const srv = startPluginMcpStdio({ input, output });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\\n');
    const list = await nextMsg();
    assert.deepEqual(list.result.tools.map((t) => t.name), ['ping']);
  } finally {
    rl.close();
    input.end();
    srv.close();
    await srv.closed;
  }
});
`
    : '';

  const hooksTest = hasHooks
    ? `
test('SessionStart hook script returns valid JSON payload', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString('utf8');
  });
  input.end(JSON.stringify({ hook_event_name: 'SessionStart', workspacePaths: [] }));
  await runSessionStartHook({ stream: input, output });
  assert.deepEqual(JSON.parse(written), {});
});
`
    : '';

  const buildAndSidecarTest = hasSidecar
    ? `
test('companion sidecar boots cleanly and plugin bundle builds when available', async () => {
  if (typeof sc.buildPluginProject === 'function') {
    const outRoot = mkdtempSync(join(tmpdir(), 'smoke-plugin-build-'));
    try {
      const built = sc.buildPluginProject({
        repoRoot: ROOT,
        outRoot,
        tar: false,
        agyValidate: false,
      });
      assert.equal(
        existsSync(join(built.dir, 'node_modules', 'antigravity-sidecar-kit', 'package.json')),
        true
      );
      const { createServer } = await import(
        pathToFileURL(join(built.dir, 'sidecars', ${JSON.stringify(id)}, 'server.mjs')).href
      );
      const srv = await createServer({ port: 0, uiToken: 'smoke-tok' });
      try {
        const res = await fetch(\`\${srv.url}/_sidecar/health\`);
        assert.equal(res.status, 200);
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
    return;
  }

  const { createServer } = await import(
    pathToFileURL(join(ROOT, 'plugin', 'sidecars', ${JSON.stringify(id)}, 'server.mjs')).href
  );
  const srv = await createServer({ port: 0, uiToken: 'smoke-tok' });
  try {
    const res = await fetch(\`\${srv.url}/_sidecar/health\`);
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});
`
    : `
test('plugin bundle builds cleanly when buildPluginProject is available', () => {
  if (typeof sc.buildPluginProject !== 'function') return;
  const outRoot = mkdtempSync(join(tmpdir(), 'smoke-plugin-build-'));
  try {
    const built = sc.buildPluginProject({
      repoRoot: ROOT,
      outRoot,
      tar: false,
      agyValidate: false,
    });
    assert.equal(built.pluginName, ${JSON.stringify(pluginName)});
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});
`;

  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
${extraNodeImports.join('\n')}
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sc from 'antigravity-sidecar-kit/scaffolder';
import { lintPluginOrSidecar } from 'antigravity-sidecar-kit/validator';
${mcpImport}${hooksImport}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('plugin manifests pass strict validation', () => {
  const lint = lintPluginOrSidecar(join(ROOT, 'plugin'), { strict: true });
  assert.equal(lint.valid, true, JSON.stringify(lint));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, ${JSON.stringify(pluginName)});
});
${mcpTest}${hooksTest}${buildAndSidecarTest}`;
}

/**
 * Builds the `plugin` or `plugin-sidecar` file map (`relPath -> string | object`).
 */
export function buildPluginLayer({
  archetype = 'plugin',
  id,
  pkgName,
  folderName,
  pluginName,
  displayName,
  description,
  entrypoint = 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  hideTitleBar = false,
  components = ['skills', 'mcp'],
  authorName = 'Sidecar Author',
  githubOwner = '',
  kitVersion,
}) {
  const hasSidecar = archetype === 'plugin-sidecar';
  const normalizedComponents = normalizePluginComponents(components, { archetype });
  const componentSet = new Set(normalizedComponents);
  const hasHooks = componentSet.has('hooks');
  const hasMcp = componentSet.has('mcp');

  const resolvedAuthor = String(authorName || 'Sidecar Author').trim() || 'Sidecar Author';
  const resolvedDescription =
    (typeof description === 'string' && description.trim()) ||
    (hasSidecar
      ? `${displayName} native plugin and companion sidecar for Google Antigravity.`
      : `${displayName} native plugin for Google Antigravity.`);

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
    private: true,
    type: 'module',
    description: resolvedDescription,
    license: 'MIT',
    ...meta,
    engines: { node: '>=20.0.0' },
    scripts: {
      test: 'node --test test/*.test.mjs',
      'validate:manifest': 'agy-sidecar-kit lint --strict plugin',
      'build:plugin': 'agy-sidecar-kit build-plugin',
      'test:pack': 'agy-sidecar-kit pack-smoke',
    },
    devDependencies: {
      'antigravity-sidecar-kit': `^${kitVersion}`,
      ...(hasSidecar ? { linkedom: '^0.18.15' } : {}),
    },
    agyPlugin: {
      pluginDir: 'plugin',
      outDir: 'dist/plugin',
      copy: hasSidecar ? ['lib', 'LICENSE'] : ['LICENSE'],
      bundleKit: hasSidecar || hasHooks,
    },
  };

  const pluginJson = {
    name: pluginName,
    displayName,
    description: resolvedDescription,
    version: '1.0.0',
  };

  const files = new Map();
  files.set('package.json', packageJson);
  files.set('plugin/plugin.json', pluginJson);

  if (componentSet.has('skills')) {
    files.set(`plugin/skills/${id}/SKILL.md`, buildSkillMd({ id, displayName }));
  }

  if (hasMcp) {
    files.set('plugin/mcp_config.json', {
      mcpServers: {
        mcp: {
          command: 'node',
          args: ['${PLUGIN_ROOT}/mcp/server.mjs'],
        },
      },
    });
    files.set('plugin/mcp/server.mjs', buildPluginMcpServerMjs({ pluginName }));
  }

  if (componentSet.has('rules')) {
    files.set('plugin/rules/AGENTS.md', buildRulesMd({ displayName }));
  }

  if (hasHooks) {
    files.set('plugin/hooks.json', {
      [pluginName]: {
        SessionStart: [
          {
            type: 'command',
            command: 'node scripts/session-start.mjs',
            timeout: 10,
          },
        ],
      },
    });
    files.set('plugin/scripts/session-start.mjs', buildSessionStartHookMjs());
  }

  if (componentSet.has('agents')) {
    files.set(`plugin/agents/${id}.md`, buildAgentMd({ id, displayName }));
  }

  if (hasSidecar) {
    files.set('lib/shared.mjs', buildSharedMjs({ pluginName, id }));
    files.set(
      `plugin/sidecars/${id}/sidecar.json`,
      buildSidecarJson({
        displayName,
        description: resolvedDescription,
        entrypoint,
        hideTitleBar,
        includeAgentPermissions: false,
      })
    );
    files.set(`plugin/sidecars/${id}/launch.mjs`, buildLaunchMjs(displayName));
    files.set(
      `plugin/sidecars/${id}/server.mjs`,
      buildSidecarServerMjs({ id, archetype: 'plugin-sidecar' })
    );
    files.set(`plugin/sidecars/${id}/ui/index.html`, buildIndexHtml(displayName));
    files.set(`plugin/sidecars/${id}/ui/styles.css`, buildStylesCss());
    files.set(`plugin/sidecars/${id}/ui/app.js`, buildUiAppJs());
  }

  files.set(
    'test/smoke.test.mjs',
    buildPluginSmokeTestMjs({
      id,
      pluginName,
      hasSidecar,
      hasMcp,
      hasHooks,
    })
  );

  return files;
}
