/**
 * @fileoverview Schema validator and corpus defect linter for Antigravity sidecars and plugins.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from './config.mjs';

const VALID_CAPABILITY_TIERS = new Set([
  'TIER_1_TELEMETRY',
  'TIER_2_LOCAL_TOOLING',
  'TIER_3_AGENT_CONTROL',
]);

const VALID_SIDECAR_ENTRYPOINTS = new Set([
  'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  'SIDECAR_UI_ENTRYPOINT_FULL_PANE',
  'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
]);

const VALID_RESTART_POLICIES = new Set(['always', 'on-failure', 'never']);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Validates a `sidecar.json` manifest object.
 * @param {object} sidecarJson
 * @param {{ targetDir?: string, file?: string }} [options]
 * @returns {{ valid: boolean, errors: Array<object>, warnings: Array<object> }}
 */
export function validateSidecarJson(sidecarJson, { targetDir, file = 'sidecar.json' } = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(sidecarJson)) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} must be a JSON object.`,
    });
    return { valid: false, errors, warnings };
  }

  const hasCommand = typeof sidecarJson.command === 'string' && Boolean(sidecarJson.command.trim());
  const hasBuiltin = typeof sidecarJson.builtin === 'string' && Boolean(sidecarJson.builtin.trim());

  if (hasCommand && hasBuiltin) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} cannot specify both "command" and "builtin" simultaneously.`,
    });
  } else if (!hasCommand && !hasBuiltin) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} must specify a non-empty "command" or "builtin" string.`,
    });
  } else if (sidecarJson.command !== undefined && !hasCommand) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} must specify a non-empty "command" string.`,
    });
  } else if (sidecarJson.builtin !== undefined && !hasBuiltin) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} must specify a non-empty "builtin" string.`,
    });
  }

  if (
    sidecarJson.args !== undefined &&
    (!Array.isArray(sidecarJson.args) || !sidecarJson.args.every((a) => typeof a === 'string'))
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} "args" must be an array of strings when present.`,
    });
  } else if (
    hasBuiltin &&
    sidecarJson.builtin.trim() === 'schedule' &&
    Array.isArray(sidecarJson.args) &&
    (sidecarJson.args.length < 2 || !sidecarJson.args[0].trim())
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} with "builtin": "schedule" must specify "args" as ["<cron>", "<command>", ...args].`,
    });
  } else if (
    targetDir &&
    Array.isArray(sidecarJson.args) &&
    typeof sidecarJson.args[0] === 'string'
  ) {
    const arg0 = sidecarJson.args[0].trim();
    if (
      arg0 &&
      !arg0.startsWith('-') &&
      !arg0.startsWith('$') &&
      !arg0.includes('://') &&
      /\.(?:m?js|cjs|py|sh)$/i.test(arg0) &&
      !existsSync(join(targetDir, arg0))
    ) {
      warnings.push({
        ruleId: 'SIDECAR-DRIFT-04',
        severity: 'warn',
        file,
        message: `${file} entrypoint script "${arg0}" does not exist in ${targetDir}.`,
      });
    }
  }

  if (
    sidecarJson.env !== undefined &&
    (!isPlainObject(sidecarJson.env) || !Object.values(sidecarJson.env).every((v) => typeof v === 'string'))
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} "env" must be an object mapping string keys to string values when present.`,
    });
  }

  if (sidecarJson.has_web_ui !== undefined && typeof sidecarJson.has_web_ui !== 'boolean') {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} "has_web_ui" must be a boolean when present.`,
    });
  }

  if (
    sidecarJson.restart_policy !== undefined &&
    (typeof sidecarJson.restart_policy !== 'string' || !VALID_RESTART_POLICIES.has(sidecarJson.restart_policy))
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-04',
      severity: 'error',
      file,
      message: `${file} "restart_policy" must be one of "always", "on-failure", or "never" when present.`,
    });
  }

  if (sidecarJson.ui_config !== undefined) {
    if (!isPlainObject(sidecarJson.ui_config)) {
      errors.push({
        ruleId: 'SIDECAR-DRIFT-04',
        severity: 'error',
        file,
        message: `${file} "ui_config" must be an object when present.`,
      });
    } else if (sidecarJson.ui_config.views !== undefined) {
      if (
        !Array.isArray(sidecarJson.ui_config.views) ||
        !sidecarJson.ui_config.views.every(
          (v) => isPlainObject(v) && VALID_SIDECAR_ENTRYPOINTS.has(v.entrypoint)
        )
      ) {
        errors.push({
          ruleId: 'SIDECAR-DRIFT-04',
          severity: 'error',
          file,
          message: `${file} "ui_config.views" entries must have entrypoint "SIDECAR_UI_ENTRYPOINT_AUX_PANE".`,
        });
      }
    }
  }

  if (sidecarJson.agent_permissions !== undefined) {
    if (!isPlainObject(sidecarJson.agent_permissions)) {
      errors.push({
        ruleId: 'SIDECAR-DRIFT-04',
        severity: 'error',
        file,
        message: `${file} "agent_permissions" must be an object when present.`,
      });
    } else {
      if (
        sidecarJson.agent_permissions.workspace_uris !== undefined &&
        (!Array.isArray(sidecarJson.agent_permissions.workspace_uris) ||
          !sidecarJson.agent_permissions.workspace_uris.every((u) => typeof u === 'string'))
      ) {
        errors.push({
          ruleId: 'SIDECAR-DRIFT-04',
          severity: 'error',
          file,
          message: `${file} "agent_permissions.workspace_uris" must be an array of strings when present.`,
        });
      }
      if (
        sidecarJson.agent_permissions.access_grants !== undefined &&
        (!Array.isArray(sidecarJson.agent_permissions.access_grants) ||
          !sidecarJson.agent_permissions.access_grants.every((g) => typeof g === 'string'))
      ) {
        errors.push({
          ruleId: 'SIDECAR-DRIFT-04',
          severity: 'error',
          file,
          message: `${file} "agent_permissions.access_grants" must be an array of strings when present.`,
        });
      }
      if (
        sidecarJson.agent_permissions.allows_user_interactions !== undefined &&
        typeof sidecarJson.agent_permissions.allows_user_interactions !== 'boolean'
      ) {
        errors.push({
          ruleId: 'SIDECAR-DRIFT-04',
          severity: 'error',
          file,
          message: `${file} "agent_permissions.allows_user_interactions" must be a boolean when present.`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates a `hub-manifest.json` object.
 * @param {object} hubManifest
 * @param {{ packageVersion?: string, file?: string }} [options]
 * @returns {{ valid: boolean, errors: Array<object>, warnings: Array<object> }}
 */
export function validateHubManifest(hubManifest, { packageVersion, file = 'hub-manifest.json' } = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(hubManifest)) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} must be a JSON object.`,
    });
    return { valid: false, errors, warnings };
  }

  if (typeof hubManifest.version !== 'string' || !hubManifest.version.trim()) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-01',
      severity: 'error',
      file,
      message: `${file} is missing a non-empty "version" string.`,
    });
  } else if (packageVersion && hubManifest.version !== packageVersion) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-01',
      severity: 'error',
      file,
      message: `${file} version "${hubManifest.version}" does not match package.json version "${packageVersion}".`,
    });
  }

  if (typeof hubManifest.id !== 'string' || !hubManifest.id.trim()) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} requires a non-empty "id" string.`,
    });
  }

  if (typeof hubManifest.name !== 'string' || !hubManifest.name.trim()) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} requires a non-empty "name" string.`,
    });
  }

  if (typeof hubManifest.tagline !== 'string' || !hubManifest.tagline.trim()) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} requires a non-empty "tagline" string.`,
    });
  }

  if (
    !isPlainObject(hubManifest.author) ||
    typeof hubManifest.author.name !== 'string' ||
    !hubManifest.author.name.trim()
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} requires an "author" object with a non-empty "author.name" string.`,
    });
  }

  if (
    !Array.isArray(hubManifest.categories) ||
    hubManifest.categories.length === 0 ||
    !hubManifest.categories.every((c) => typeof c === 'string' && c.trim().length > 0)
  ) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} requires a non-empty "categories" array of strings.`,
    });
  }

  if (!VALID_CAPABILITY_TIERS.has(hubManifest.capabilityTier)) {
    errors.push({
      ruleId: 'SIDECAR-DRIFT-02',
      severity: 'error',
      file,
      message: `${file} "capabilityTier" must be one of TIER_1_TELEMETRY, TIER_2_LOCAL_TOOLING, or TIER_3_AGENT_CONTROL.`,
    });
  }

  if (hubManifest.workspaceTriggers !== undefined) {
    if (!isPlainObject(hubManifest.workspaceTriggers)) {
      errors.push({
        ruleId: 'SIDECAR-DRIFT-03',
        severity: 'error',
        file,
        message: `${file} "workspaceTriggers" must be an object when present.`,
      });
    } else if (hubManifest.workspaceTriggers.files !== undefined) {
      if (!Array.isArray(hubManifest.workspaceTriggers.files)) {
        errors.push({
          ruleId: 'SIDECAR-DRIFT-03',
          severity: 'error',
          file,
          message: `${file} "workspaceTriggers.files" must be an array of relative file patterns.`,
        });
      } else {
        for (const entry of hubManifest.workspaceTriggers.files) {
          const invalid =
            typeof entry !== 'string' ||
            entry.trim() === '' ||
            entry.trim() === '*' ||
            entry.startsWith('/') ||
            entry.startsWith('\\') ||
            /^[a-zA-Z]:/.test(entry) ||
            entry.includes('..');
          if (invalid) {
            errors.push({
              ruleId: 'SIDECAR-DRIFT-03',
              severity: 'error',
              file,
              message: `${file} "workspaceTriggers.files" contains unsafe or overly broad pattern "${String(entry)}".`,
            });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

const VALID_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'PreInvocation',
  'PostInvocation',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'sessionStart',
  'stop',
]);

function inspectHooksTree(node, { relFile, targetDir, fix, errors, warnings, onFix }) {
  if (Array.isArray(node)) {
    for (const item of node) {
      inspectHooksTree(item, { relFile, targetDir, fix, errors, warnings, onFix });
    }
    return;
  }
  if (!isPlainObject(node)) return;

  if (Array.isArray(node.modules)) {
    warnings.push({
      ruleId: 'HOOK-DIALECT-01',
      severity: 'warn',
      file: relFile,
      message: `${relFile} contains non-standard Claude Mods "modules" array.`,
    });
  }

  if (isPlainObject(node.hooks)) {
    for (const eventKey of Object.keys(node.hooks)) {
      if (!VALID_HOOK_EVENTS.has(eventKey)) {
        errors.push({
          ruleId: 'HOOK-SCHEMA-01',
          severity: 'error',
          file: relFile,
          message: `Unknown hook event "${eventKey}" in ${relFile}.`,
        });
      }
    }
  }

  if (typeof node.matcher === 'string' && node.matcher.includes('mcp__')) {
    if (fix) {
      const parts = node.matcher
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const nextParts = [];
      for (const p of parts) {
        if (p.includes('mcp__')) {
          if (!nextParts.includes('call_mcp_tool')) nextParts.push('call_mcp_tool');
          if (!nextParts.includes('mcp_tool')) nextParts.push('mcp_tool');
        } else if (!nextParts.includes(p)) {
          nextParts.push(p);
        }
      }
      node.matcher = nextParts.join('|');
      onFix();
    } else {
      errors.push({
        ruleId: 'BIGIN-01',
        severity: 'error',
        file: relFile,
        message: `Hook matcher "${node.matcher}" in ${relFile} uses "mcp__*" instead of "call_mcp_tool|mcp_tool".`,
      });
    }
  }

  if (typeof node.command === 'string') {
    const cmd = node.command;
    const hasPosixSubshell = cmd.includes('$(cat)');
    const hasShWithoutNode =
      !/^\s*node\b/.test(cmd) && /(?:^|\s|["'./\\])[\w./\\-]+\.sh(?:\s|["']|$)/.test(cmd);
    if (hasPosixSubshell || hasShWithoutNode) {
      warnings.push({
        ruleId: 'WIN-SOC-01',
        severity: 'warn',
        file: relFile,
        message: `Hook command in ${relFile} uses POSIX subshell $(cat) or .sh script without a node wrapper: ${cmd}`,
      });
    }
    if (targetDir) {
      const relScriptMatch = cmd.match(/(?:^|\s)(?:\.\/|\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}\/)([\w./-]+\.(?:m?js|cjs|sh|py))(?:\s|$)/);
      if (relScriptMatch) {
        const scriptRel = relScriptMatch[1];
        if (!existsSync(join(targetDir, scriptRel))) {
          warnings.push({
            ruleId: 'HOOK-SCHEMA-02',
            severity: 'warn',
            file: relFile,
            message: `Hook command in ${relFile} references missing script "${scriptRel}".`,
          });
        }
      }
    }
  }

  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      inspectHooksTree(val, { relFile, targetDir, fix, errors, warnings, onFix });
    }
  }
}

/**
 * Lints (and optionally autofixes) a sidecar or plugin directory.
 * @param {string} targetDir
 * @param {{ fix?: boolean, strict?: boolean }} [options]
 * @returns {{ valid: boolean, errors: Array<object>, warnings: Array<object>, fixedCount: number }}
 */
export function lintPluginOrSidecar(targetDir, { fix = false, strict = false } = {}) {
  const errors = [];
  const warnings = [];
  let fixedCount = 0;

  const pkgPath = join(targetDir, 'package.json');
  const pkg = existsSync(pkgPath) ? readJsonSafe(pkgPath, null) : null;
  const packageVersion =
    isPlainObject(pkg) && typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version.trim()
      : undefined;

  const hubPath = join(targetDir, 'hub-manifest.json');
  if (existsSync(hubPath)) {
    const hubManifest = readJsonSafe(hubPath, null);
    if (isPlainObject(hubManifest) && fix) {
      let hubDirty = false;
      if (packageVersion && hubManifest.version !== packageVersion) {
        hubManifest.version = packageVersion;
        fixedCount++;
        hubDirty = true;
      }
      if (typeof hubManifest.tagline !== 'string' || !hubManifest.tagline.trim()) {
        hubManifest.tagline =
          (typeof hubManifest.description === 'string' && hubManifest.description.trim()) ||
          (isPlainObject(pkg) && typeof pkg.description === 'string' && pkg.description.trim()) ||
          `${hubManifest.name || hubManifest.id || 'Sidecar'} for Google Antigravity.`;
        fixedCount++;
        hubDirty = true;
      }
      if (
        !isPlainObject(hubManifest.author) ||
        typeof hubManifest.author.name !== 'string' ||
        !hubManifest.author.name.trim()
      ) {
        const authorName =
          (typeof hubManifest.author === 'string' && hubManifest.author.trim()) ||
          (isPlainObject(pkg) && typeof pkg.author === 'string' && pkg.author.trim()) ||
          (isPlainObject(pkg?.author) &&
            typeof pkg.author.name === 'string' &&
            pkg.author.name.trim()) ||
          'Sidecar Author';
        hubManifest.author = {
          ...(isPlainObject(hubManifest.author) ? hubManifest.author : {}),
          name: authorName,
        };
        fixedCount++;
        hubDirty = true;
      }
      if (
        !Array.isArray(hubManifest.categories) ||
        hubManifest.categories.length === 0 ||
        !hubManifest.categories.every((c) => typeof c === 'string' && c.trim().length > 0)
      ) {
        hubManifest.categories = ['utilities'];
        fixedCount++;
        hubDirty = true;
      }
      if (hubDirty) {
        writeJsonNoBom(hubPath, hubManifest);
      }
    }
    const hubRes = validateHubManifest(hubManifest, { packageVersion, file: 'hub-manifest.json' });
    errors.push(...hubRes.errors);
    warnings.push(...hubRes.warnings);
  }

  const sidecarPath = join(targetDir, 'sidecar.json');
  if (existsSync(sidecarPath)) {
    const sidecarJson = readJsonSafe(sidecarPath, null);
    const sidecarRes = validateSidecarJson(sidecarJson, { targetDir, file: 'sidecar.json' });
    errors.push(...sidecarRes.errors);
    warnings.push(...sidecarRes.warnings);
  }

  for (const relMcp of ['mcp_config.json', '.mcp.json', 'mcp.json']) {
    const mcpPath = join(targetDir, relMcp);
    if (!existsSync(mcpPath)) continue;
    let mcpData = readJsonSafe(mcpPath, null);
    if (!isPlainObject(mcpData)) {
      errors.push({
        ruleId: 'SUPABASE-MCP-01',
        severity: 'error',
        file: relMcp,
        message: `${relMcp} is not a valid JSON object.`,
      });
      continue;
    }
    let mcpDirty = false;

    const hasWrapper = isPlainObject(mcpData.mcpServers);
    if (!hasWrapper && Object.keys(mcpData).length > 0) {
      const MCP_META_KEYS = new Set(['$schema', 'version', 'description']);
      const metaEntries = {};
      const serverEntries = {};
      for (const [k, v] of Object.entries(mcpData)) {
        if (MCP_META_KEYS.has(k) && !isPlainObject(v)) {
          metaEntries[k] = v;
        } else {
          serverEntries[k] = v;
        }
      }
      if (fix) {
        mcpData = { ...metaEntries, mcpServers: serverEntries };
        fixedCount++;
        mcpDirty = true;
      } else {
        errors.push({
          ruleId: 'SUPABASE-MCP-01',
          severity: 'error',
          file: relMcp,
          message: `${relMcp} is missing top-level "mcpServers" wrapper object.`,
        });
      }
    }

    const rewriteMcpVarStr = (str, onVarFix) => {
      const next = str
        .replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|extensionPath|GEMINI_PLUGIN_PATH)\}/g, '${PLUGIN_ROOT}')
        .replace(/\$(?:CLAUDE_PLUGIN_ROOT|GEMINI_PLUGIN_PATH)\b/g, '${PLUGIN_ROOT}')
        .replace(/\$\{\/\}/g, '/');
      if (next !== str) onVarFix();
      return next;
    };

    const rewriteMcpVarsDeep = (val, onVarFix) => {
      if (typeof val === 'string') return rewriteMcpVarStr(val, onVarFix);
      if (Array.isArray(val)) return val.map((item) => rewriteMcpVarsDeep(item, onVarFix));
      if (isPlainObject(val)) {
        for (const [k, v] of Object.entries(val)) {
          val[k] = rewriteMcpVarsDeep(v, onVarFix);
        }
      }
      return val;
    };

    const serversMap = isPlainObject(mcpData.mcpServers) ? mcpData.mcpServers : mcpData;
    for (const [serverName, serverEntry] of Object.entries(serversMap)) {
      if (!isPlainObject(serverEntry)) continue;

      if (fix) {
        let varFixed = false;
        rewriteMcpVarsDeep(serverEntry, () => {
          varFixed = true;
        });
        if (varFixed) {
          fixedCount++;
          mcpDirty = true;
        }
      }

      if ('url' in serverEntry || 'httpUrl' in serverEntry) {
        const isStdioWithEmptyUrl =
          Boolean(serverEntry.command) &&
          !serverEntry.url &&
          !serverEntry.httpUrl &&
          !serverEntry.serverUrl;
        if (fix) {
          if (!isStdioWithEmptyUrl) {
            const resolvedUrl = serverEntry.serverUrl || serverEntry.url || serverEntry.httpUrl;
            if (typeof resolvedUrl === 'string' && resolvedUrl) {
              serverEntry.serverUrl = resolvedUrl;
            }
          }
          delete serverEntry.url;
          delete serverEntry.httpUrl;
          fixedCount++;
          mcpDirty = true;
        } else {
          errors.push({
            ruleId: 'FIGMA-MCP-01',
            severity: 'error',
            file: relMcp,
            message: `MCP server "${serverName}" in ${relMcp} uses "url"/"httpUrl" instead of "serverUrl".`,
          });
        }
      }

      if (serverEntry.command === 'npx' && (!Array.isArray(serverEntry.args) || !serverEntry.args.includes('-y'))) {
        warnings.push({
          ruleId: 'WIN-NPX-01',
          severity: 'warn',
          file: relMcp,
          message: `MCP server "${serverName}" in ${relMcp} uses "npx" without "-y".`,
        });
      }
      if (
        serverEntry.command === 'python3' ||
        (serverEntry.command === 'uv' &&
          Array.isArray(serverEntry.args) &&
          serverEntry.args.some((a) => /ABSOLUTE\/PATH/i.test(String(a))))
      ) {
        warnings.push({
          ruleId: serverEntry.command === 'python3' ? 'DESK-01' : 'SOC-01',
          severity: 'warn',
          file: relMcp,
          message: `MCP server "${serverName}" in ${relMcp} uses unportable command "${serverEntry.command}".`,
        });
      }
      const envOrHeaders = {
        ...(isPlainObject(serverEntry.env) ? serverEntry.env : {}),
        ...(isPlainObject(serverEntry.headers) ? serverEntry.headers : {}),
      };
      for (const [ek, ev] of Object.entries(envOrHeaders)) {
        if (typeof ev === 'string' && /YOUR_[A-Z0-9_]*KEY|YOUR_[A-Z0-9_]*TOKEN|REPLACE_ME/i.test(ev)) {
          warnings.push({
            ruleId: 'MCP-AUTH-01',
            severity: 'warn',
            file: relMcp,
            message: `MCP server "${serverName}" in ${relMcp} contains placeholder credential in "${ek}".`,
          });
        }
      }

      if (Array.isArray(serverEntry.args)) {
        for (const arg of serverEntry.args) {
          if (typeof arg !== 'string') continue;
          const gitMatch = arg.match(/git\+https?:\/\/[^\s"']+/i);
          if (gitMatch) {
            const gitUrl = gitMatch[0];
            const afterHost = gitUrl.replace(/^git\+https?:\/\/[^/]+\/?/i, '');
            if (!/@[^@/\s]+$/.test(afterHost)) {
              warnings.push({
                ruleId: 'SUPPLY-UNPINNED-01',
                severity: 'warn',
                file: relMcp,
                message: `MCP server "${serverName}" in ${relMcp} uses unpinned git URL "${gitUrl}" without @<tag/sha>.`,
              });
            }
          }
        }
      }
    }

    if (mcpDirty) {
      writeJsonNoBom(mcpPath, mcpData);
    }
  }

  for (const relHooks of ['hooks.json', 'hooks/hooks.json']) {
    const hooksPath = join(targetDir, relHooks);
    if (!existsSync(hooksPath)) continue;
    const hooksData = readJsonSafe(hooksPath, null);
    if (!isPlainObject(hooksData)) {
      errors.push({
        ruleId: 'HOOK-SCHEMA-01',
        severity: 'error',
        file: relHooks,
        message: `${relHooks} is not a valid JSON object.`,
      });
      continue;
    }
    let hooksDirty = false;

    inspectHooksTree(hooksData, {
      relFile: relHooks,
      targetDir,
      fix,
      errors,
      warnings,
      onFix: () => {
        fixedCount++;
        hooksDirty = true;
      },
    });

    if (hooksDirty) {
      writeJsonNoBom(hooksPath, hooksData);
    }
  }

  const skillsDir = join(targetDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const rawSkill = readFileSync(skillMd, 'utf8').replace(/^\uFEFF/, '');
      const fmMatch = rawSkill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch || !/^name:\s*\S+/m.test(fmMatch[1]) || !/^description:\s*\S+/m.test(fmMatch[1])) {
        warnings.push({
          ruleId: 'SKILL-FM-01',
          severity: 'warn',
          file: `skills/${entry.name}/SKILL.md`,
          message: `skills/${entry.name}/SKILL.md is missing YAML frontmatter with "name" and "description".`,
        });
      }
    }
  }

  const contextSkillsDir = join(targetDir, 'context', 'skills');
  if (existsSync(contextSkillsDir)) {
    warnings.push({
      ruleId: 'SKILL-PATH-01',
      severity: 'warn',
      file: 'context/skills',
      message: 'Skills under "context/skills/" are not discovered by Antigravity; move them to "skills/<name>/SKILL.md".',
    });
  }

  const rulesDir = join(targetDir, 'rules');
  if (existsSync(rulesDir)) {
    const entries = readdirSync(rulesDir, { withFileTypes: true });
    const ruleVarRe = /(?:\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath|GEMINI_PLUGIN_PATH)\}|\$(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|GEMINI_PLUGIN_PATH)\b)/;
    const ruleVarReplaceRe = /(?:\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath|GEMINI_PLUGIN_PATH)\}|\$(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|GEMINI_PLUGIN_PATH)\b)\/?/g;
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdc'))) {
        continue;
      }
      const relRule = `rules/${entry.name}`;
      const rulePath = join(rulesDir, entry.name);
      const content = readFileSync(rulePath, 'utf8');
      if (ruleVarRe.test(content)) {
        if (fix) {
          const updated = content.replace(ruleVarReplaceRe, './');
          const tmpRule = `${rulePath}.${process.pid}.tmp`;
          writeFileSync(tmpRule, updated, 'utf8');
          try {
            renameSync(tmpRule, rulePath);
          } catch {
            writeFileSync(rulePath, updated, 'utf8');
            rmSync(tmpRule, { force: true });
          }
          fixedCount++;
        } else {
          warnings.push({
            ruleId: 'VAR-RULE-01',
            severity: 'warn',
            file: relRule,
            message: `Rule file ${relRule} contains unexpanded \${PLUGIN_ROOT} or \${CLAUDE_PLUGIN_ROOT}.`,
          });
        }
      }
    }
  }

  const valid = strict ? errors.length === 0 && warnings.length === 0 : errors.length === 0;
  return { valid, errors, warnings, fixedCount };
}
