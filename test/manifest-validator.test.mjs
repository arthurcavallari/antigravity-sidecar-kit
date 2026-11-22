import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateSidecarJson,
  validateHubManifest,
  lintPluginOrSidecar,
} from '../lib/manifest-validator.mjs';

describe('manifest-validator', () => {
  describe('validateSidecarJson', () => {
    it('accepts a valid sidecar.json configuration', () => {
      const res = validateSidecarJson({
        command: 'node',
        args: ['launch.mjs'],
        has_web_ui: true,
        ui_config: {
          display_name: 'Demo',
          views: [
            {
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
              path: '/',
              title: 'Demo',
            },
          ],
        },
        agent_permissions: {
          workspace_uris: ['file:///c:/repo'],
          allows_user_interactions: true,
        },
      });
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });

    it('emits SIDECAR-DRIFT-04 for invalid command, args, has_web_ui, views entrypoint, or workspace_uris', () => {
      const res = validateSidecarJson({
        command: '',
        args: [123],
        has_web_ui: 'yes',
        ui_config: {
          views: [{ entrypoint: 'INVALID_ENTRYPOINT', path: '/' }],
        },
        agent_permissions: {
          workspace_uris: [42],
        },
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.length >= 5);
      assert.ok(res.errors.every((e) => e.ruleId === 'SIDECAR-DRIFT-04'));
    });

    it('accepts builtin sidecar mode (e.g. schedule) and rejects simultaneous command + builtin or invalid restart_policy', () => {
      const builtinOk = validateSidecarJson({
        builtin: 'schedule',
        has_web_ui: true,
        restart_policy: 'on-failure',
        ui_config: {
          display_name: 'Automation',
          views: [
            {
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
              path: '/ui',
              title: 'Schedule',
              icon: 'calendar',
            },
          ],
        },
        agent_permissions: {
          access_grants: ['command:*', 'mcp:*'],
          allows_user_interactions: true,
        },
      });
      assert.equal(builtinOk.valid, true);
      assert.equal(builtinOk.errors.length, 0);

      const conflict = validateSidecarJson({
        command: 'node',
        builtin: 'schedule',
        restart_policy: 'invalid-policy',
        env: { BAD: 123 },
        agent_permissions: { access_grants: [123], allows_user_interactions: 'yes' },
      });
      assert.equal(conflict.valid, false);
      assert.equal(conflict.errors.length, 5);
      assert.ok(conflict.errors.every((e) => e.ruleId === 'SIDECAR-DRIFT-04'));

      const badScheduleArgs = validateSidecarJson({
        builtin: 'schedule',
        args: ['0 9 * * *'],
      });
      assert.equal(badScheduleArgs.valid, false);
      assert.equal(badScheduleArgs.errors.length, 1);
    });

    it('validates SidecarUIView title_bar_style / titleBarStyle, path, title, file_extensions, and url_schemes', () => {
      const okSidebar = validateSidecarJson({
        command: 'node',
        args: ['launch.mjs'],
        has_web_ui: true,
        ui_config: {
          display_name: 'Sidebar App',
          views: [
            {
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
              path: '/app',
              title: 'Sidebar App',
              title_bar_style: 'SIDECAR_UI_TITLE_BAR_STYLE_HIDDEN',
              file_extensions: ['.pdb', '.cif'],
              url_schemes: ['https'],
            },
            {
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
              path: '/',
              title: 'Aux App',
              titleBarStyle: 'SIDECAR_UI_TITLE_BAR_STYLE_UNSPECIFIED',
              fileExtensions: ['.json'],
              urlSchemes: ['https'],
            },
          ],
        },
      });
      assert.equal(okSidebar.valid, true);
      assert.equal(okSidebar.errors.length, 0);

      const badTitleBar = validateSidecarJson({
        command: 'node',
        args: ['launch.mjs'],
        ui_config: {
          views: [
            {
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
              path: 'relative-without-slash',
              title: 123,
              title_bar_style: 'hidden',
              file_extensions: [42],
              url_schemes: [null],
            },
          ],
        },
      });
      assert.equal(badTitleBar.valid, false);
      assert.ok(badTitleBar.errors.length >= 5);
      assert.ok(badTitleBar.errors.every((e) => e.ruleId === 'SIDECAR-DRIFT-04'));

      const badCamelUiConfig = validateSidecarJson({
        command: 'node',
        uiConfig: { views: [{ entrypoint: 'invalid' }] },
      });
      assert.equal(badCamelUiConfig.valid, false);
      assert.equal(badCamelUiConfig.errors[0].ruleId, 'SIDECAR-DRIFT-04');
    });

    it('accepts 2.34.0 sandbox.allowed_http_hosts and warns on deprecated allowed_hosts', () => {
      const validBase = { command: 'node', args: ['launch.mjs'] };
      const validRes = validateSidecarJson({
        ...validBase,
        sandbox: { allowed_http_hosts: ['api.example.com'], allowedHttpHosts: ['cdn.example.com'] },
      });
      assert.equal(validRes.valid, true);
      assert.equal(validRes.warnings.length, 0);

      const badType = validateSidecarJson({ ...validBase, sandbox: { allowed_http_hosts: [''] } });
      assert.equal(badType.valid, false);
      assert.equal(badType.errors[0].ruleId, 'SIDECAR-DRIFT-04');
      assert.match(badType.errors[0].message, /allowed_http_hosts/);

      const badCamelType = validateSidecarJson({ ...validBase, sandbox: { allowedHttpHosts: [123] } });
      assert.equal(badCamelType.valid, false);
      assert.equal(badCamelType.errors[0].ruleId, 'SIDECAR-DRIFT-04');
      assert.match(badCamelType.errors[0].message, /allowedHttpHosts/);

      const deprecated = validateSidecarJson({ ...validBase, sandbox: { allowed_hosts: ['example.com'] } });
      assert.equal(deprecated.valid, true);
      assert.equal(deprecated.warnings.length, 1);
      assert.equal(deprecated.warnings[0].ruleId, 'SIDECAR-DRIFT-04');
      assert.equal(deprecated.warnings[0].severity, 'warn');
      assert.match(deprecated.warnings[0].message, /deprecated.*allowed_http_hosts/i);

      const deprecatedCamel = validateSidecarJson({ ...validBase, sandbox: { allowedHosts: ['example.com'] } });
      assert.equal(deprecatedCamel.valid, true);
      assert.equal(deprecatedCamel.warnings.length, 1);
      assert.equal(deprecatedCamel.warnings[0].ruleId, 'SIDECAR-DRIFT-04');
      assert.match(deprecatedCamel.warnings[0].message, /deprecated.*allowed_http_hosts/i);
    });
  });

  describe('validateHubManifest', () => {
    it('catches version drift (SIDECAR-DRIFT-01), missing fields (SIDECAR-DRIFT-02), and unsafe workspaceTriggers (SIDECAR-DRIFT-03)', () => {
      const res = validateHubManifest(
        {
          id: 'bad-sidecar',
          name: 'Bad',
          tagline: '',
          version: '1.0.0',
          author: '',
          categories: [],
          capabilityTier: 'TIER_1_TELEMETRY',
          workspaceTriggers: { files: ['../secret.txt', '*', '/abs/path', 'C:\\win\\path', ''] },
        },
        { packageVersion: '1.2.0' }
      );
      assert.equal(res.valid, false);
      const ids = res.errors.map((e) => e.ruleId);
      assert.ok(ids.includes('SIDECAR-DRIFT-01'));
      assert.ok(ids.includes('SIDECAR-DRIFT-02'));
      assert.ok(ids.includes('SIDECAR-DRIFT-03'));
    });

    it('accepts a valid hub-manifest.json matching packageVersion', () => {
      const res = validateHubManifest(
        {
          id: 'good-sidecar',
          name: 'Good Sidecar',
          tagline: 'Telemetry sidecar for Antigravity',
          version: '1.4.0',
          author: { name: 'Author' },
          categories: ['utilities'],
          capabilityTier: 'TIER_2_LOCAL_TOOLING',
          workspaceTriggers: { files: ['package.json', 'Cargo.toml'] },
        },
        { packageVersion: '1.4.0' }
      );
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });
  });

  describe('lintPluginOrSidecar', () => {
    it('detects and autofixes FIGMA-MCP-01, SUPABASE-MCP-01, BIGIN-01, VAR-RULE-01, and SIDECAR-DRIFT-01/02 idempotently', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kit-lint-'));
      try {
        writeFileSync(
          join(tmpDir, 'package.json'),
          JSON.stringify({ name: 'test-plugin', version: '2.1.0', description: 'Plugin desc' }, null, 2)
        );
        writeFileSync(
          join(tmpDir, 'hub-manifest.json'),
          JSON.stringify({
            id: 'test-plugin',
            name: 'Test Plugin',
            tagline: '',
            version: '1.0.0',
            author: '',
            categories: [],
            capabilityTier: 'TIER_1_TELEMETRY',
            workspaceTriggers: { files: ['package.json'] },
          }, null, 2)
        );
        // Bare MCP server map (SUPABASE-MCP-01) + url key (FIGMA-MCP-01) + unpinned git URL (SUPPLY-UNPINNED-01)
        writeFileSync(
          join(tmpDir, 'mcp_config.json'),
          JSON.stringify({
            figma: { url: 'https://mcp.figma.com/mcp' },
            purple: {
              command: 'uvx',
              args: ['--from', 'git+https://github.com/Sentinel-One/purple-mcp.git', 'purple-mcp'],
            },
          }, null, 2)
        );
        // Hooks with BIGIN-01 (mcp__*) and WIN-SOC-01 ($(cat) / .sh)
        mkdirSync(join(tmpDir, 'hooks'), { recursive: true });
        writeFileSync(
          join(tmpDir, 'hooks', 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [
                {
                  matcher: 'mcp__*',
                  hooks: [
                    { type: 'command', command: '_in=$(cat); ./scripts/gate.sh' },
                  ],
                },
              ],
            },
          }, null, 2)
        );
        // Rules with VAR-RULE-01 (${PLUGIN_ROOT} and ${CLAUDE_PLUGIN_ROOT})
        mkdirSync(join(tmpDir, 'rules'), { recursive: true });
        writeFileSync(
          join(tmpDir, 'rules', 'AGENTS.md'),
          'Read ${PLUGIN_ROOT}/skills/foo/SKILL.md and ${CLAUDE_PLUGIN_ROOT}/rules/bar.md\n'
        );

        const first = lintPluginOrSidecar(tmpDir, { fix: false });
        assert.equal(first.valid, false);
        const errIds = first.errors.map((d) => d.ruleId);
        const warnIds = first.warnings.map((d) => d.ruleId);
        assert.ok(errIds.includes('SIDECAR-DRIFT-01'));
        assert.ok(errIds.includes('SIDECAR-DRIFT-02'));
        assert.ok(errIds.includes('SUPABASE-MCP-01'));
        assert.ok(errIds.includes('FIGMA-MCP-01'));
        assert.ok(errIds.includes('BIGIN-01'));
        assert.ok(warnIds.includes('VAR-RULE-01'));
        assert.ok(warnIds.includes('SUPPLY-UNPINNED-01'));
        assert.ok(warnIds.includes('WIN-SOC-01'));

        const fixed = lintPluginOrSidecar(tmpDir, { fix: true });
        assert.ok(fixed.fixedCount >= 5);
        assert.equal(fixed.valid, true);
        assert.equal(fixed.errors.length, 0);

        // Verify autofix idempotency on second pass
        const secondFix = lintPluginOrSidecar(tmpDir, { fix: true });
        assert.equal(secondFix.fixedCount, 0);
        assert.equal(secondFix.errors.length, 0);
        assert.equal(secondFix.valid, true);

        // Verify on-disk contents after autofix
        const fixedMcp = JSON.parse(readFileSync(join(tmpDir, 'mcp_config.json'), 'utf8'));
        assert.equal(fixedMcp.mcpServers.figma.serverUrl, 'https://mcp.figma.com/mcp');
        assert.equal('url' in fixedMcp.mcpServers.figma, false);

        const fixedHooks = JSON.parse(readFileSync(join(tmpDir, 'hooks', 'hooks.json'), 'utf8'));
        assert.equal(fixedHooks.hooks.PreToolUse[0].matcher, 'call_mcp_tool|mcp_*|mcp_tool');

        const fixedRule = readFileSync(join(tmpDir, 'rules', 'AGENTS.md'), 'utf8');
        assert.match(fixedRule, /\.\/skills\/foo\/SKILL\.md/);
        assert.match(fixedRule, /\.\/rules\/bar\.md/);
        assert.equal(fixedRule.includes('${PLUGIN_ROOT}'), false);
        assert.equal(fixedRule.includes('${CLAUDE_PLUGIN_ROOT}'), false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('autofixes BIGIN-01 mcp__ matchers the same way agy-plugin-porter remapMatcher does (eager mcp_<server>_<tool>)', () => {
      // Expected values are agy-plugin-porter's remapMatcher output for the same matchers, except
      // the invalid regex last: the porter reports it unmapped, the linter keeps the generic MCP tools.
      const cases = [
        ['mcp__zoho__delete_record|run_command', 'call_mcp_tool|mcp_tool|mcp_zoho_delete_record|run_command'],
        ['mcp__github__.*', 'call_mcp_tool|mcp_github_.*|mcp_tool'],
        ['mcp__github__', 'call_mcp_tool|mcp_github_.*|mcp_tool'],
        ['run_command|mcp__zoho__(delete|drop)', 'call_mcp_tool|mcp_tool|mcp_zoho_(delete|drop)|run_command'],
        ['(mcp__a__x|mcp__b__y)', '(mcp_a_x|mcp_b_y)|call_mcp_tool|mcp_tool'],
        [
          '^mcp__[A-Za-z0-9._-]*[Ee][Xx][Aa][Bb][Ee][Aa][Mm][A-Za-z0-9._-]*__',
          'call_mcp_tool|mcp_[A-Za-z0-9._-]*[Ee][Xx][Aa][Bb][Ee][Aa][Mm][A-Za-z0-9._-]*_.*|mcp_tool',
        ],
        ['.*mcp__.*', 'call_mcp_tool|mcp_tool'],
        ['mcp__bad__(', 'call_mcp_tool|mcp_tool'],
      ];
      const tmpDir = mkdtempSync(join(tmpdir(), 'kit-lint-mcp-'));
      try {
        const entry = (matcher) => ({ matcher, hooks: [{ type: 'command', command: 'node guard.mjs' }] });
        writeFileSync(
          join(tmpDir, 'hooks.json'),
          JSON.stringify({ native: { PreToolUse: cases.map(([m]) => entry(m)) } }, null, 2)
        );
        const first = lintPluginOrSidecar(tmpDir, { fix: false });
        assert.equal(first.errors.filter((d) => d.ruleId === 'BIGIN-01').length, cases.length);

        const fixed = lintPluginOrSidecar(tmpDir, { fix: true });
        assert.equal(fixed.fixedCount, cases.length);
        const out = JSON.parse(readFileSync(join(tmpDir, 'hooks.json'), 'utf8')).native.PreToolUse;
        assert.deepEqual(out.map((e) => e.matcher), cases.map(([, want]) => want));

        assert.equal(lintPluginOrSidecar(tmpDir, { fix: true }).fixedCount, 0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('preserves top-level $schema on bare .mcp.json, rewrites ${GEMINI_PLUGIN_PATH}/${extensionPath}/${/}, and warns on missing sidecar.json entry script (F-06, XREPO-05)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'kit-lint-f06-'));
      try {
        writeFileSync(
          join(tmpDir, '.mcp.json'),
          JSON.stringify({
            $schema: 'https://json.schemastore.org/mcp.json',
            supabase: {
              url: 'https://mcp.supabase.com/mcp',
            },
            localSrv: {
              command: 'node',
              args: ['${GEMINI_PLUGIN_PATH}${/}server.mjs'],
              url: '',
            },
          }, null, 2)
        );
        writeFileSync(
          join(tmpDir, 'sidecar.json'),
          JSON.stringify({
            command: 'node',
            args: ['bin/missing-entry.mjs'],
          }, null, 2)
        );
        mkdirSync(join(tmpDir, 'rules'), { recursive: true });
        writeFileSync(
          join(tmpDir, 'rules', 'gemini.md'),
          'Use ${extensionPath}/skills/a.md and $PLUGIN_ROOT/skills/b.md\n'
        );

        const fixed = lintPluginOrSidecar(tmpDir, { fix: true });
        assert.equal(fixed.valid, true);
        assert.ok(fixed.warnings.some((w) => w.ruleId === 'SIDECAR-DRIFT-04'));

        const mcpAfter = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf8'));
        assert.equal(mcpAfter.$schema, 'https://json.schemastore.org/mcp.json');
        assert.equal('$schema' in mcpAfter.mcpServers, false);
        assert.equal(mcpAfter.mcpServers.supabase.serverUrl, 'https://mcp.supabase.com/mcp');
        assert.equal('url' in mcpAfter.mcpServers.localSrv, false);
        assert.equal(mcpAfter.mcpServers.localSrv.args[0], '${PLUGIN_ROOT}/server.mjs');

        const ruleAfter = readFileSync(join(tmpDir, 'rules', 'gemini.md'), 'utf8');
        assert.match(ruleAfter, /\.\/skills\/a\.md/);
        assert.match(ruleAfter, /\.\/skills\/b\.md/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('ASK-05: rejects malformed JSON configs and enforces WIN-NPX-01, SOC-01, DESK-01, MCP-AUTH-01, HOOK-SCHEMA-01..03, HOOK-DIALECT-01, SKILL-FM-01, and SKILL-PATH-01', () => {
      const corruptDir = mkdtempSync(join(tmpdir(), 'kit-lint-corrupt-'));
      try {
        writeFileSync(join(corruptDir, 'mcp_config.json'), '{ broken json', 'utf8');
        writeFileSync(join(corruptDir, 'hooks.json'), '{ broken hooks', 'utf8');
        const corruptRes = lintPluginOrSidecar(corruptDir);
        assert.equal(corruptRes.valid, false, 'corrupt JSON files must fail validation');
        assert.ok(corruptRes.errors.length >= 2);
      } finally {
        rmSync(corruptDir, { recursive: true, force: true });
      }

      const rulesDir = mkdtempSync(join(tmpdir(), 'kit-lint-rules24-'));
      try {
        writeFileSync(
          join(rulesDir, 'mcp_config.json'),
          JSON.stringify({
            mcpServers: {
              npxSrv: { command: 'npx', args: ['@modelcontextprotocol/server-memory'] },
              uvSrv: { command: 'uv', args: ['--directory', '/ABSOLUTE/PATH/TO/SERVER', 'run', 'server.py'] },
              pySrv: { command: 'python3', args: ['server.py'], env: { API_KEY: 'YOUR_API_KEY' } },
            },
          }, null, 2)
        );
        mkdirSync(join(rulesDir, 'hooks'), { recursive: true });
        writeFileSync(
          join(rulesDir, 'hooks', 'hooks.json'),
          JSON.stringify({
            modules: ['ui-mod.mjs'],
            hooks: {
              InvalidLifecycleEvent: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ./scripts/missing-hook.mjs' }] }],
              PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ./scripts/missing-hook.mjs' }] }],
            },
          }, null, 2)
        );
        mkdirSync(join(rulesDir, 'skills', 'broken-skill'), { recursive: true });
        writeFileSync(join(rulesDir, 'skills', 'broken-skill', 'SKILL.md'), '# No frontmatter\n', 'utf8');
        mkdirSync(join(rulesDir, 'context', 'skills', 'orphan-skill'), { recursive: true });
        writeFileSync(join(rulesDir, 'context', 'skills', 'orphan-skill', 'SKILL.md'), '---\nname: orphan\ndescription: x\n---\n', 'utf8');

        const res = lintPluginOrSidecar(rulesDir);
        const allIds = [...res.errors, ...res.warnings].map((d) => d.ruleId);
        for (const expectedRule of [
          'WIN-NPX-01',
          'SOC-01',
          'DESK-01',
          'MCP-AUTH-01',
          'HOOK-DIALECT-01',
          'HOOK-SCHEMA-01',
          'HOOK-SCHEMA-02',
          'SKILL-FM-01',
          'SKILL-PATH-01',
        ]) {
          assert.ok(allIds.includes(expectedRule), `expected ${expectedRule} in ${JSON.stringify(allIds)}`);
        }
      } finally {
        rmSync(rulesDir, { recursive: true, force: true });
      }

      // KIT-11: VAR-HOOK-01 (${PLUGIN_ROOT} in hooks.json command) and MCP-NAME-01 (64-char MCP tool budget)
      const kit11Dir = mkdtempSync(join(tmpdir(), 'kit-lint-kit11-'));
      try {
        writeFileSync(join(kit11Dir, 'plugin.json'), JSON.stringify({ name: 'acme-long-plugin-suite', version: '1.0.0' }));
        mkdirSync(join(kit11Dir, 'scripts'), { recursive: true });
        writeFileSync(join(kit11Dir, 'scripts', 'hook.mjs'), 'export {};\n');
        writeFileSync(
          join(kit11Dir, 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node ${PLUGIN_ROOT}/scripts/hook.mjs' }] }],
            },
          })
        );
        writeFileSync(
          join(kit11Dir, 'mcp_config.json'),
          JSON.stringify({
            mcpServers: {
              'acme-long-plugin-suite_audit-engine': { command: 'node', args: ['${PLUGIN_ROOT}/scripts/hook.mjs'] },
            },
          })
        );
        const check11 = lintPluginOrSidecar(kit11Dir, { fix: false });
        const warn11 = check11.warnings.map((w) => w.ruleId);
        assert.ok(warn11.includes('VAR-HOOK-01'));
        assert.ok(warn11.includes('MCP-NAME-01'));

        lintPluginOrSidecar(kit11Dir, { fix: true });
        const fixedHookCmd = JSON.parse(readFileSync(join(kit11Dir, 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
        assert.equal(fixedHookCmd, 'node ./scripts/hook.mjs');
      } finally {
        rmSync(kit11Dir, { recursive: true, force: true });
      }
    });

    it('validates SidecarSandboxConfig fields and TypeScript (.ts/.mts) sidecar & hook entrypoints', () => {
      const okSb = validateSidecarJson({
        command: 'node',
        args: ['server.mts'],
        sandbox: {
          disable_sandbox: false,
          allow_full_network: false,
          allowed_http_hosts: ['api.example.com'],
          read_only_paths: ['/opt/shared-data'],
          read_write_paths: ['C:\\Temp\\sidecar-cache'],
        },
      });
      assert.equal(okSb.valid, true);
      assert.equal(okSb.warnings.length, 0);

      const badSb = validateSidecarJson({
        command: 'node',
        args: ['server.mjs'],
        sandbox: {
          disable_sandbox: 'yes',
          allow_full_network: 1,
          allowed_http_hosts: [''],
          read_only_paths: ['~/.gemini/antigravity'],
          read_write_paths: ['/Users/alice/.gemini/config/plugins'],
        },
      });
      assert.equal(badSb.valid, false);
      assert.equal(badSb.errors.length, 3);
      const sbWarns = badSb.warnings.filter((w) => w.ruleId === 'SIDECAR-SANDBOX-01');
      assert.equal(sbWarns.length, 2);

      // Ancestor paths that enclose ~/.gemini/(antigravity|config) also fail bidirectional within() in checkRequestedPath
      const ancestorSb = validateSidecarJson({
        command: 'node',
        args: ['server.mjs'],
        sandbox: {
          read_only_paths: ['/Users/alice/.gemini', '/Users/alice', '/', '/Users/alice/Projects/app', '/Users/alice/.gemini/other'],
          read_write_paths: ['C:\\Users\\alice\\.gemini', 'C:\\'],
        },
      });
      assert.equal(ancestorSb.valid, true);
      const ancestorWarns = ancestorSb.warnings.filter((w) => w.ruleId === 'SIDECAR-SANDBOX-01');
      assert.equal(ancestorWarns.length, 5);

      // Unknown sandbox keys and duplicate snake+camel arrays are not silently ignored
      const mixedSb = validateSidecarJson({
        command: 'node',
        args: ['server.mjs'],
        sandbox: {
          allow_network: true,
          read_only_paths: ['/tmp/ok'],
          readOnlyPaths: [123],
        },
      });
      assert.equal(mixedSb.valid, false);
      assert.ok(mixedSb.errors.some((e) => e.ruleId === 'SIDECAR-DRIFT-04' && e.message.includes('readOnlyPaths')));
      assert.ok(mixedSb.warnings.some((w) => w.ruleId === 'SIDECAR-DRIFT-04' && w.message.includes('allow_network')));

      const tsDir = mkdtempSync(join(tmpdir(), 'kit-lint-ts-'));
      try {
        writeFileSync(
          join(tsDir, 'sidecar.json'),
          JSON.stringify({ command: 'node', args: ['entry.mts'], sandbox: { disable_sandbox: true } })
        );
        writeFileSync(
          join(tsDir, 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node ./scripts/guard.ts' }] }],
            },
          })
        );
        const missingRes = lintPluginOrSidecar(tsDir);
        const missingWarns = missingRes.warnings.map((w) => w.ruleId);
        assert.ok(missingWarns.includes('SIDECAR-DRIFT-04'), 'warns when entry.mts is missing');
        assert.ok(missingWarns.includes('HOOK-SCHEMA-02'), 'warns when ./scripts/guard.ts is missing');

        mkdirSync(join(tsDir, 'scripts'), { recursive: true });
        writeFileSync(join(tsDir, 'entry.mts'), 'export {};\n');
        writeFileSync(join(tsDir, 'scripts', 'guard.ts'), 'export {};\n');
        const presentRes = lintPluginOrSidecar(tsDir);
        assert.equal(presentRes.warnings.length, 0);
      } finally {
        rmSync(tsDir, { recursive: true, force: true });
      }
    });

    it('lintPluginOrSidecar walks sidecars/*/sidecar.json and sidecars.json entries, and rejects wildcard access_grants', () => {
      const pluginDir = mkdtempSync(join(tmpdir(), 'kit-lint-plugin-sidecars-'));
      try {
        writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'multi-sidecar-plugin', version: '1.0.0' }));
        mkdirSync(join(pluginDir, 'sidecars', 'board'), { recursive: true });
        writeFileSync(
          join(pluginDir, 'sidecars', 'board', 'sidecar.json'),
          JSON.stringify({
            command: 'node',
            args: ['missing-board.mjs'],
            restart_policy: 'always',
            agent_permissions: {
              access_grants: ['command(*)', 'read_file(/)', 'command(gh pr list)'],
            },
          })
        );

        mkdirSync(join(pluginDir, 'packages', 'ext-sidecars', 'cron-job'), { recursive: true });
        writeFileSync(
          join(pluginDir, 'packages', 'ext-sidecars', 'cron-job', 'sidecar.json'),
          JSON.stringify({
            builtin: 'schedule',
            args: ['node'],
            restart_policy: 'always',
          })
        );
        writeFileSync(
          join(pluginDir, 'sidecars.json'),
          JSON.stringify({
            entries: [{ path: 'packages/ext-sidecars' }],
          })
        );

        const res = lintPluginOrSidecar(pluginDir);
        assert.equal(res.valid, false);
        assert.ok(
          res.errors.some((e) => e.file === 'sidecars/board/sidecar.json' && e.message.includes('command(*)')),
          `expected wildcard command(*) error in ${JSON.stringify(res.errors)}`
        );
        assert.ok(
          res.errors.some((e) => e.file === 'sidecars/board/sidecar.json' && e.message.includes('read_file(/)')),
          `expected wildcard read_file(/) error in ${JSON.stringify(res.errors)}`
        );
        assert.ok(
          res.warnings.some((w) => w.file === 'sidecars/board/sidecar.json' && w.message.includes('missing-board.mjs')),
          `expected missing-board.mjs warning in ${JSON.stringify(res.warnings)}`
        );
        assert.ok(
          res.errors.some(
            (e) =>
              e.file === 'packages/ext-sidecars/cron-job/sidecar.json' &&
              e.message.includes('"builtin": "schedule"')
          ),
          `expected schedule args error from sidecars.json target in ${JSON.stringify(res.errors)}`
        );

        writeFileSync(join(pluginDir, 'sidecars.json'), '{ malformed', 'utf8');
        const badCfg = lintPluginOrSidecar(pluginDir);
        assert.ok(badCfg.errors.some((e) => e.file === 'sidecars.json'));
      } finally {
        rmSync(pluginDir, { recursive: true, force: true });
      }
    });
  });
});
