import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonNoBom } from '../lib/config.mjs';
import { KIT_ROOT, removeLinkOrDir } from '../lib/setup.mjs';
import * as scaffolder from '../lib/scaffolder.mjs';
import {
  buildRegistryEntry,
  inferPluginTier,
  openRegistryPr,
  upsertRegistryFile,
  validateRegistryEntry,
} from '../lib/cli/registry-entry.mjs';

/**
 * Self-contained mirror of Hangar's `scripts/validate-registry.mjs` package schema check
 * so `test/cli-registry-entry.test.mjs` never depends on a sibling repository checkout in CI.
 */
function hangarReferenceValidateRegistry(registry) {
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;
  const SIDECAR_ID = /^[a-z0-9][a-z0-9_-]*$/;
  const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const SHA256 = /^[0-9a-f]{64}$/i;
  const TIERS = new Set(['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL']);
  const RESERVED_IDS = new Set(['hangar', 'sidecar-hub']);
  const KINDS = new Set(['sidecar', 'plugin']);
  const PORT_SOURCES = new Set(['claude', 'gemini', 'cursor', 'roo', 'codex', 'auto']);
  const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
  const SHORT_SHA = /^[0-9a-f]{7,39}$/i;
  const SPDX = /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
  const isRelativeInside = (p) =>
    isNonEmptyString(p) && !/^[\\/]|^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..');
  const isHttpsUrl = (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  };

  const checkRelease = (release, where, errors, kind = 'sidecar') => {
    if (!isObject(release)) {
      errors.push(`${where}.release must be an object`);
      return;
    }
    const { gitRepo, tarballUrl, sha256, path, ref } = release;
    if (!gitRepo && !tarballUrl) errors.push(`${where}.release needs gitRepo or tarballUrl`);
    if (gitRepo !== undefined && !isHttpsUrl(gitRepo)) {
      errors.push(`${where}.release.gitRepo must be an https URL`);
    }
    if (tarballUrl !== undefined) {
      if (!isHttpsUrl(tarballUrl)) {
        errors.push(`${where}.release.tarballUrl must be an https URL`);
      }
      if (!SHA256.test(String(sha256 || ''))) {
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
  };

  const errors = [];
  if (!isObject(registry)) return ['registry must be a JSON object'];
  if (!Array.isArray(registry.packages)) return ['packages must be an array'];

  const seen = new Set();
  registry.packages.forEach((pkg, i) => {
    const where = `packages[${i}]${isObject(pkg) && pkg.id ? ` (${pkg.id})` : ''}`;
    if (!isObject(pkg)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!SIDECAR_ID.test(String(pkg.id || ''))) errors.push(`${where}.id must match ${SIDECAR_ID}`);
    if (RESERVED_IDS.has(pkg.id)) errors.push(`${where}.id is reserved`);
    if (seen.has(pkg.id)) errors.push(`${where}.id is a duplicate`);
    seen.add(pkg.id);
    if (!isNonEmptyString(pkg.name)) errors.push(`${where}.name is required`);
    if (!SEMVER.test(String(pkg.latestVersion || ''))) {
      errors.push(`${where}.latestVersion must be semver`);
    }
    if (!TIERS.has(pkg.capabilityTier)) {
      errors.push(`${where}.capabilityTier must be one of ${[...TIERS].join(', ')}`);
    }
    if (pkg.npmPackage !== undefined && !NPM_NAME.test(pkg.npmPackage)) {
      errors.push(`${where}.npmPackage is not a valid npm name`);
    }
    if (pkg.funding !== undefined && !isHttpsUrl(pkg.funding)) {
      errors.push(`${where}.funding must be an https URL`);
    }
    if (
      pkg.categories !== undefined &&
      !(Array.isArray(pkg.categories) && pkg.categories.every(isNonEmptyString))
    ) {
      errors.push(`${where}.categories must be an array of strings`);
    }
    if (pkg.license !== undefined && !(typeof pkg.license === 'string' && SPDX.test(pkg.license))) {
      errors.push(`${where}.license must be an SPDX license id or expression`);
    }
    if (pkg.homepage !== undefined && !isHttpsUrl(pkg.homepage)) {
      errors.push(`${where}.homepage must be an https URL`);
    }
    const files = pkg.workspaceTriggers?.files;
    if (files !== undefined) {
      const bad = Array.isArray(files) ? files.filter((f) => !isRelativeInside(f)) : [files];
      if (bad.length) {
        errors.push(
          `${where}.workspaceTriggers.files must be relative paths inside the workspace: ${JSON.stringify(bad)}`
        );
      }
    }
    const kind = pkg.kind ?? 'sidecar';
    if (!KINDS.has(kind)) errors.push(`${where}.kind must be "sidecar" or "plugin"`);
    if (pkg.port !== undefined) {
      if (kind !== 'plugin') errors.push(`${where}.port needs kind "plugin"`);
      if (!isObject(pkg.port) || !PORT_SOURCES.has(pkg.port.from)) {
        errors.push(`${where}.port.from must be one of ${[...PORT_SOURCES].join(', ')}`);
      }
      if (!pkg.release?.gitRepo) {
        errors.push(`${where}.release.gitRepo is required when port is set`);
      }
      if (!pkg.release?.ref) {
        errors.push(`${where}.release.ref is required when port is set`);
      }
    }
    checkRelease(pkg.release, where, errors, kind);
  });

  return errors;
}

function makeRegistryFixture(packages = []) {
  return {
    generatedAt: '2026-11-23T00:00:00Z',
    hangar: {
      id: 'hangar',
      name: 'Antigravity Hangar',
      npmPackage: 'antigravity-hangar',
      latestVersion: '1.6.0',
      release: {
        gitRepo: 'https://github.com/arthurcavallari/antigravity-hangar',
      },
    },
    featuredIds: [],
    packages,
  };
}

describe('Task 6: registry-entry & Hangar tier inference', () => {
  it('re-exports registry-entry helpers from lib/scaffolder.mjs', () => {
    assert.equal(scaffolder.inferPluginTier, inferPluginTier);
    assert.equal(scaffolder.validateRegistryEntry, validateRegistryEntry);
    assert.equal(scaffolder.buildRegistryEntry, buildRegistryEntry);
    assert.equal(scaffolder.upsertRegistryFile, upsertRegistryFile);
    assert.equal(scaffolder.openRegistryPr, openRegistryPr);
  });

  it('inferPluginTier classifies pure skills + rules as TIER_1_TELEMETRY (ignoring code markers inside markdown docs)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-tier-t1-'));
    try {
      const proj = join(tmp, 'agy-pure');
      scaffolder.scaffoldProject({
        name: 'pure',
        archetype: 'plugin',
        targetDir: proj,
        components: ['skills', 'rules'],
      });
      // Mentioning agent APIs in SKILL.md or rules markdown must NOT trigger TIER_3
      writeFileSync(
        join(proj, 'plugin', 'skills', 'pure', 'SKILL.md'),
        '---\nname: pure\ndescription: "docs"\n---\nExample: `sidecar.agent.sendMessage("hi")` and `ui/message`.\n',
        'utf8'
      );

      const res = inferPluginTier(join(proj, 'plugin'));
      assert.equal(res.tier, 'TIER_1_TELEMETRY');
      assert.deepEqual(res.reasons, []);
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('inferPluginTier classifies SessionStart/PreToolUse/PostToolUse hooks, mcp_config.json, and non-interactive sidecars as TIER_2_LOCAL_TOOLING', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-tier-t2-'));
    try {
      const proj = join(tmp, 'agy-combo');
      scaffolder.scaffoldProject({
        name: 'combo',
        archetype: 'plugin-sidecar',
        targetDir: proj,
        components: ['skills', 'mcp', 'hooks'],
      });
      // Add PreToolUse and PostToolUse hooks alongside SessionStart
      writeJsonNoBom(join(proj, 'plugin', 'hooks.json'), {
        'agy-combo': {
          SessionStart: [{ type: 'command', command: 'node scripts/session-start.mjs' }],
          PreToolUse: [{ type: 'command', command: 'node scripts/session-start.mjs' }],
          PostToolUse: [{ type: 'command', command: 'node scripts/session-start.mjs' }],
        },
      });

      const res = inferPluginTier(join(proj, 'plugin'));
      assert.equal(res.tier, 'TIER_2_LOCAL_TOOLING');
      assert.ok(res.reasons.some((r) => /hooks:/i.test(r)));
      assert.ok(res.reasons.some((r) => /MCP servers:/i.test(r)));
      assert.ok(res.reasons.some((r) => /sidecars:/i.test(r)));
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('inferPluginTier escalates Stop/PostInvocation hooks, agents/*.md, schedule, agent_permissions, malformed sidecar.json, escaping symlinks/paths, and runtime agent markers to TIER_3_AGENT_CONTROL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-tier-t3-'));
    try {
      const makeBasePlugin = (sub) => {
        const dir = join(tmp, sub);
        mkdirSync(dir, { recursive: true });
        writeJsonNoBom(join(dir, 'plugin.json'), {
          name: `agy-${sub}`,
          description: 'fixture',
          version: '1.0.0',
        });
        return dir;
      };

      // 1. Stop hook
      const stopDir = makeBasePlugin('stop-hook');
      writeJsonNoBom(join(stopDir, 'hooks.json'), {
        Stop: [{ type: 'command', command: 'node stop.mjs' }],
      });
      assert.equal(inferPluginTier(stopDir).tier, 'TIER_3_AGENT_CONTROL');

      // 2. PostInvocation hook
      const postInvDir = makeBasePlugin('post-inv');
      writeJsonNoBom(join(postInvDir, 'hooks.json'), {
        PostInvocation: [{ type: 'command', command: 'node post.mjs' }],
      });
      assert.equal(inferPluginTier(postInvDir).tier, 'TIER_3_AGENT_CONTROL');

      // 3. agents/reviewer.md
      const agentDir = makeBasePlugin('with-agent');
      mkdirSync(join(agentDir, 'agents'), { recursive: true });
      writeFileSync(join(agentDir, 'agents', 'reviewer.md'), '# Reviewer\n', 'utf8');
      const agentRes = inferPluginTier(agentDir);
      assert.equal(agentRes.tier, 'TIER_3_AGENT_CONTROL');
      assert.ok(agentRes.reasons.some((r) => r.includes('reviewer')));

      // 4. agent_permissions.allows_user_interactions: true
      const permIntDir = makeBasePlugin('perm-interact');
      mkdirSync(join(permIntDir, 'sidecars', 'panel'), { recursive: true });
      writeJsonNoBom(join(permIntDir, 'sidecars', 'panel', 'sidecar.json'), {
        command: 'node',
        args: ['launch.mjs'],
        agent_permissions: { allows_user_interactions: true },
      });
      assert.equal(inferPluginTier(permIntDir).tier, 'TIER_3_AGENT_CONTROL');

      // 5. non-empty access_grants & workspace_uris, plus builtin: "schedule"
      const permGrantsDir = makeBasePlugin('perm-grants');
      mkdirSync(join(permGrantsDir, 'sidecars', 'panel'), { recursive: true });
      writeJsonNoBom(join(permGrantsDir, 'sidecars', 'panel', 'sidecar.json'), {
        command: 'node',
        args: ['launch.mjs'],
        agent_permissions: { access_grants: ['terminal'] },
      });
      assert.equal(inferPluginTier(permGrantsDir).tier, 'TIER_3_AGENT_CONTROL');

      const permWsDir = makeBasePlugin('perm-ws');
      mkdirSync(join(permWsDir, 'sidecars', 'panel'), { recursive: true });
      writeJsonNoBom(join(permWsDir, 'sidecars', 'panel', 'sidecar.json'), {
        command: 'node',
        args: ['launch.mjs'],
        agent_permissions: { workspace_uris: ['file:///workspace'] },
      });
      assert.equal(inferPluginTier(permWsDir).tier, 'TIER_3_AGENT_CONTROL');

      const schedDir = makeBasePlugin('sched');
      mkdirSync(join(schedDir, 'sidecars', 'cron'), { recursive: true });
      writeJsonNoBom(join(schedDir, 'sidecars', 'cron', 'sidecar.json'), {
        builtin: 'schedule',
        command: 'node',
        args: ['launch.mjs'],
      });
      assert.equal(inferPluginTier(schedDir).tier, 'TIER_3_AGENT_CONTROL');

      // 6. Malformed sidecar.json
      const malformedScDir = makeBasePlugin('bad-sc');
      mkdirSync(join(malformedScDir, 'sidecars', 'broken'), { recursive: true });
      writeFileSync(join(malformedScDir, 'sidecars', 'broken', 'sidecar.json'), '{ invalid', 'utf8');
      assert.equal(inferPluginTier(malformedScDir).tier, 'TIER_3_AGENT_CONTROL');

      // 7. JS containing sidecar.agent.sendMessage( / sidecar.agent.startConversation( / ui/message
      const sendMsgDir = makeBasePlugin('js-send');
      mkdirSync(join(sendMsgDir, 'sidecars', 'chat', 'ui'), { recursive: true });
      writeJsonNoBom(join(sendMsgDir, 'sidecars', 'chat', 'sidecar.json'), {
        command: 'node',
        args: ['launch.mjs'],
      });
      writeFileSync(
        join(sendMsgDir, 'sidecars', 'chat', 'ui', 'app.js'),
        'window.sidecar.agent.sendMessage("deploy now");\n',
        'utf8'
      );
      assert.equal(inferPluginTier(sendMsgDir).tier, 'TIER_3_AGENT_CONTROL');

      const startConvDir = makeBasePlugin('js-start-conv');
      writeFileSync(
        join(startConvDir, 'helper.mjs'),
        'export const go = (sidecar) => sidecar.agent.startConversation({ prompt: "hi" });\n',
        'utf8'
      );
      assert.equal(inferPluginTier(startConvDir).tier, 'TIER_3_AGENT_CONTROL');

      const uiMsgDir = makeBasePlugin('mcp-ui-msg');
      writeJsonNoBom(join(uiMsgDir, 'mcp_config.json'), {
        mcpServers: { app: { command: 'node', args: ['server.mjs'] } },
      });
      writeFileSync(
        join(uiMsgDir, 'server.mjs'),
        'const uri = "ui://widget"; const method = "ui/message";\n',
        'utf8'
      );
      assert.equal(inferPluginTier(uiMsgDir).tier, 'TIER_3_AGENT_CONTROL');

      // 8. Path escaping pluginDir in sidecars.json & symlink escaping pluginDir
      const escapePathDir = makeBasePlugin('escape-path');
      writeJsonNoBom(join(escapePathDir, 'sidecars.json'), {
        entries: [{ path: '../outside-sidecar' }],
      });
      assert.equal(inferPluginTier(escapePathDir).tier, 'TIER_3_AGENT_CONTROL');

      const outsideTarget = join(tmp, 'outside-dir');
      mkdirSync(outsideTarget, { recursive: true });
      writeFileSync(join(outsideTarget, 'secret.txt'), 'secret', 'utf8');
      const symlinkDir = makeBasePlugin('escape-symlink');
      symlinkSync(
        outsideTarget,
        join(symlinkDir, 'escaped'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      assert.equal(inferPluginTier(symlinkDir).tier, 'TIER_3_AGENT_CONTROL');

      // 9. Quoted ${PLUGIN_ROOT}/.. escape in hook command or mcp_config.json args
      const quotedEscapeHookDir = makeBasePlugin('quoted-hook-escape');
      writeJsonNoBom(join(quotedEscapeHookDir, 'hooks.json'), {
        SessionStart: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/../outside.mjs"' }],
      });
      assert.equal(inferPluginTier(quotedEscapeHookDir).tier, 'TIER_3_AGENT_CONTROL');

      const mcpEscapeDir = makeBasePlugin('mcp-arg-escape');
      writeJsonNoBom(join(mcpEscapeDir, 'mcp_config.json'), {
        mcpServers: { bad: { command: 'node', args: ['${PLUGIN_ROOT}/../../outside.mjs'] } },
      });
      assert.equal(inferPluginTier(mcpEscapeDir).tier, 'TIER_3_AGENT_CONTROL');
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('validateRegistryEntry enforces Hangar exact regexes and constraints', () => {
    const validSidecar = {
      id: 'pulse-monitor',
      name: 'Pulse Monitor',
      npmPackage: 'antigravity-pulse-monitor',
      tagline: 'Monitors pulse metrics.',
      author: { name: 'Octocat', github: 'octocat' },
      funding: 'https://github.com/sponsors/octocat',
      latestVersion: '1.2.3',
      pricing: 'free',
      categories: ['telemetry'],
      capabilityTier: 'TIER_1_TELEMETRY',
      license: 'MIT OR Apache-2.0',
      homepage: 'https://github.com/octocat/antigravity-pulse-monitor',
      securityScan: {
        passed: true,
        hasPostInstallScripts: false,
        externalDependencies: 0,
      },
      workspaceTriggers: { files: ['package.json'] },
      release: {
        gitRepo: 'https://github.com/octocat/antigravity-pulse-monitor',
      },
    };
    assert.deepEqual(validateRegistryEntry(validSidecar), []);
    assert.deepEqual(hangarReferenceValidateRegistry(makeRegistryFixture([validSidecar])), []);

    const validPlugin = {
      id: 'agy-radar',
      name: 'Radar',
      kind: 'plugin',
      tagline: 'Radar native plugin.',
      author: { name: 'Octocat', github: 'octocat' },
      latestVersion: '1.0.0',
      pricing: 'free',
      categories: ['utilities'],
      capabilityTier: 'TIER_2_LOCAL_TOOLING',
      license: 'MIT',
      homepage: 'https://github.com/octocat/agy-radar',
      release: {
        tarballUrl:
          'https://github.com/octocat/agy-radar/releases/download/v1.0.0/agy-radar-plugin-1.0.0.tgz',
        sha256: 'a'.repeat(64),
      },
    };
    assert.deepEqual(validateRegistryEntry(validPlugin), []);
    assert.deepEqual(hangarReferenceValidateRegistry(makeRegistryFixture([validPlugin])), []);

    assert.ok(validateRegistryEntry(null).length > 0);
    assert.ok(validateRegistryEntry({ ...validSidecar, id: '../evil' }).some((e) => /id/i.test(e)));
    assert.ok(
      validateRegistryEntry({ ...validSidecar, id: 'hangar' }).some((e) => /reserved/i.test(e))
    );
    assert.ok(
      validateRegistryEntry({ ...validSidecar, id: 'sidecar-hub' }).some((e) => /reserved/i.test(e))
    );
    assert.ok(
      validateRegistryEntry({ ...validSidecar, latestVersion: 'v1.0.0' }).some((e) =>
        /semver/i.test(e)
      )
    );
    assert.ok(
      validateRegistryEntry({ ...validSidecar, npmPackage: 'UPPER_BAD' }).some((e) =>
        /npmPackage/i.test(e)
      )
    );
    assert.ok(
      validateRegistryEntry({ ...validSidecar, license: 'MIT <script>' }).some((e) =>
        /SPDX/i.test(e)
      )
    );
    assert.ok(
      validateRegistryEntry({ ...validSidecar, homepage: 'http://insecure.example.com' }).some((e) =>
        /https/i.test(e)
      )
    );
    assert.ok(
      validateRegistryEntry({
        ...validPlugin,
        release: { tarballUrl: validPlugin.release.tarballUrl, sha256: 'short' },
      }).some((e) => /sha256/i.test(e))
    );
    assert.ok(
      validateRegistryEntry({
        ...validSidecar,
        workspaceTriggers: { files: ['../../etc/passwd'] },
      }).some((e) => /workspaceTriggers/i.test(e))
    );
  });

  it('buildRegistryEntry builds valid Hangar entries for sidecar-mcp & plugin-sidecar, excludes trusted SDKs from externalDependencies, and throws when repository/gitRepo is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-build-'));
    try {
      // 1. Scaffolded sidecar-mcp with --github octocat
      const sidecarDir = join(tmp, 'antigravity-beacon');
      scaffolder.scaffoldProject({
        name: 'beacon',
        archetype: 'sidecar-mcp',
        targetDir: sidecarDir,
        author: 'Octo Author',
        github: 'octocat',
      });

      // Add sidecar_sdk alongside antigravity-sidecar-kit to verify both trusted SDKs are excluded
      const scPkgPath = join(sidecarDir, 'package.json');
      const scPkg = JSON.parse(readFileSync(scPkgPath, 'utf8'));
      scPkg.dependencies = {
        ...scPkg.dependencies,
        sidecar_sdk: '1.0.0',
      };
      writeJsonNoBom(scPkgPath, scPkg);

      const sidecarEntry = buildRegistryEntry({ repoRoot: sidecarDir, kitRoot: KIT_ROOT });
      assert.equal(sidecarEntry.id, 'beacon');
      assert.equal(sidecarEntry.npmPackage, 'antigravity-beacon');
      assert.deepEqual(sidecarEntry.author, { name: 'Octo Author', github: 'octocat' });
      assert.equal(sidecarEntry.capabilityTier, 'TIER_2_LOCAL_TOOLING');
      assert.deepEqual(sidecarEntry.securityScan, {
        passed: true,
        hasPostInstallScripts: false,
        externalDependencies: 0,
      });
      assert.deepEqual(sidecarEntry.release, {
        gitRepo: 'https://github.com/octocat/antigravity-beacon',
      });
      assert.deepEqual(validateRegistryEntry(sidecarEntry), []);
      assert.deepEqual(hangarReferenceValidateRegistry(makeRegistryFixture([sidecarEntry])), []);

      // Verify external dependency & postinstall script detection on sidecars
      writeJsonNoBom(scPkgPath, {
        ...scPkg,
        dependencies: { ...scPkg.dependencies, ws: '^8.18.0' },
        scripts: { ...scPkg.scripts, postinstall: 'node postinstall.mjs' },
      });
      const flaggedSidecarEntry = buildRegistryEntry({ repoRoot: sidecarDir, kitRoot: KIT_ROOT });
      assert.deepEqual(flaggedSidecarEntry.securityScan, {
        passed: false,
        hasPostInstallScripts: true,
        externalDependencies: 1,
      });

      // 2. Scaffolded plugin-sidecar with --github octocat
      const pluginDir = join(tmp, 'agy-orbit');
      scaffolder.scaffoldProject({
        name: 'orbit',
        archetype: 'plugin-sidecar',
        targetDir: pluginDir,
        author: 'Octo Author',
        github: 'octocat',
      });

      const pluginEntry = buildRegistryEntry({ repoRoot: pluginDir, kitRoot: KIT_ROOT });
      const builtTarball = join(pluginDir, 'dist', 'plugin', 'agy-orbit-plugin-1.0.0.tgz');
      assert.equal(existsSync(builtTarball), true, 'must build .tgz bundle automatically');
      const expectedSha = createHash('sha256').update(readFileSync(builtTarball)).digest('hex');

      assert.equal(pluginEntry.id, 'agy-orbit');
      assert.equal(pluginEntry.kind, 'plugin');
      assert.deepEqual(pluginEntry.author, { name: 'Octo Author', github: 'octocat' });
      assert.equal(pluginEntry.capabilityTier, 'TIER_2_LOCAL_TOOLING');
      assert.deepEqual(pluginEntry.release, {
        tarballUrl:
          'https://github.com/octocat/agy-orbit/releases/download/v1.0.0/agy-orbit-plugin-1.0.0.tgz',
        sha256: expectedSha,
      });
      assert.match(pluginEntry.release.sha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(validateRegistryEntry(pluginEntry), []);
      assert.deepEqual(hangarReferenceValidateRegistry(makeRegistryFixture([pluginEntry])), []);

      // 3. Missing repository / gitRepo throws clear error
      const noRepoDir = join(tmp, 'antigravity-norepo');
      scaffolder.scaffoldProject({
        name: 'norepo',
        archetype: 'sidecar-ui',
        targetDir: noRepoDir,
      });
      assert.throws(
        () => buildRegistryEntry({ repoRoot: noRepoDir, kitRoot: KIT_ROOT }),
        /repository|gitRepo/i
      );
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('upsertRegistryFile refuses to clobber malformed/non-object/non-array registry.json and preserves author.verified + custom fields on update', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-upsert-'));
    try {
      const candidate = {
        id: 'context-monitor',
        name: 'Context & Quota Monitor',
        npmPackage: 'antigravity-context-monitor',
        tagline: 'Live context telemetry.',
        author: { name: 'Arthur Cavallari', github: 'arthurcavallari' },
        latestVersion: '1.8.0',
        pricing: 'free',
        categories: ['utilities'],
        capabilityTier: 'TIER_2_LOCAL_TOOLING',
        license: 'MIT',
        homepage: 'https://github.com/arthurcavallari/antigravity-context-monitor',
        workspaceTriggers: { files: ['package.json'] },
        release: {
          tarballUrl:
            'https://github.com/arthurcavallari/antigravity-context-monitor/releases/download/v1.8.0/context-monitor-1.8.0.tgz',
          sha256: 'b'.repeat(64),
        },
      };

      // 1. Corrupt JSON, empty file, array root, and non-array packages must throw without modifying disk
      const badCases = [
        ['corrupt.json', '{ "hangar": { "broken": true '],
        ['empty.json', '   \n'],
        ['array-root.json', '[]\n'],
        ['bad-packages.json', '{"hangar":{"id":"hangar"},"packages":{"not":"array"}}\n'],
      ];
      for (const [filename, rawContent] of badCases) {
        const badPath = join(tmp, filename);
        writeFileSync(badPath, rawContent, 'utf8');
        assert.throws(() => upsertRegistryFile(badPath, candidate));
        assert.equal(
          readFileSync(badPath, 'utf8'),
          rawContent,
          `${filename} must remain untouched on disk after error`
        );
      }

      // 2. Preserves author.verified: true, funding, custom categories, and custom workspaceTriggers on update
      const regPath = join(tmp, 'registry.json');
      const initialRegistry = makeRegistryFixture([
        {
          id: 'context-monitor',
          name: 'Context & Quota Monitor',
          npmPackage: 'antigravity-context-monitor',
          tagline: 'Old tagline.',
          author: {
            name: 'Arthur Cavallari',
            github: 'arthurcavallari',
            verified: true,
          },
          funding: 'https://github.com/sponsors/arthurcavallari',
          latestVersion: '1.7.0',
          pricing: 'free',
          categories: ['telemetry', 'productivity'],
          capabilityTier: 'TIER_1_TELEMETRY',
          workspaceTriggers: { files: ['*'] },
          release: {
            tarballUrl:
              'https://github.com/arthurcavallari/antigravity-context-monitor/releases/download/v1.7.0/context-monitor-1.7.0.tgz',
            sha256: 'a'.repeat(64),
          },
        },
      ]);
      initialRegistry.featuredIds = ['context-monitor'];
      writeJsonNoBom(regPath, initialRegistry);

      const updated = upsertRegistryFile(regPath, candidate);
      assert.equal(updated.action, 'updated');
      assert.equal(updated.entry.latestVersion, '1.8.0');
      assert.equal(updated.entry.release.sha256, 'b'.repeat(64));
      assert.equal(updated.entry.author.verified, true);
      assert.equal(updated.entry.funding, 'https://github.com/sponsors/arthurcavallari');
      assert.deepEqual(updated.entry.categories, ['telemetry', 'productivity']);
      assert.deepEqual(updated.entry.workspaceTriggers, { files: ['*'] });

      // 3. Appends cleanly when new
      const newEntry = {
        id: 'agy-nova',
        name: 'Nova',
        kind: 'plugin',
        tagline: 'Nova plugin.',
        author: { name: 'Octocat', github: 'octocat' },
        latestVersion: '1.0.0',
        pricing: 'free',
        categories: ['devops'],
        capabilityTier: 'TIER_1_TELEMETRY',
        license: 'MIT',
        homepage: 'https://github.com/octocat/agy-nova',
        release: {
          tarballUrl:
            'https://github.com/octocat/agy-nova/releases/download/v1.0.0/agy-nova-plugin-1.0.0.tgz',
          sha256: 'c'.repeat(64),
        },
      };
      const inserted = upsertRegistryFile(regPath, newEntry);
      assert.equal(inserted.action, 'inserted');

      const finalReg = JSON.parse(readFileSync(regPath, 'utf8'));
      assert.equal(finalReg.packages.length, 2);
      assert.equal(finalReg.packages[0].author.verified, true);
      assert.equal(finalReg.packages[1].id, 'agy-nova');
      assert.deepEqual(hangarReferenceValidateRegistry(finalReg), []);

      // 4. Explicit non-default categories/workspaceTriggers/funding override cleanly
      const explicitUpdate = upsertRegistryFile(regPath, {
        ...candidate,
        funding: 'https://github.com/sponsors/new-sponsor',
        categories: ['security'],
        workspaceTriggers: { files: ['Cargo.toml'] },
      });
      assert.equal(explicitUpdate.action, 'updated');
      assert.equal(explicitUpdate.entry.author.verified, true);
      assert.equal(explicitUpdate.entry.funding, 'https://github.com/sponsors/new-sponsor');
      assert.deepEqual(explicitUpdate.entry.categories, ['security']);
      assert.deepEqual(explicitUpdate.entry.workspaceTriggers, { files: ['Cargo.toml'] });
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('openRegistryPr verifies gh auth status, forks/clones into temp dir, updates registry.json, commits on registry/<id>-<version>, and opens PR', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-pr-'));
    try {
      const pluginDir = join(tmp, 'agy-comet');
      scaffolder.scaffoldProject({
        name: 'comet',
        archetype: 'plugin',
        targetDir: pluginDir,
        components: ['skills'],
        author: 'Comet Dev',
        github: 'octocat',
      });

      // 1. Fails early if gh auth status fails
      assert.throws(
        () =>
          openRegistryPr({
            repoRoot: pluginDir,
            kitRoot: KIT_ROOT,
            execFn: (cmd, args) => {
              if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
                throw new Error('not logged into any GitHub hosts');
              }
              return '';
            },
          }),
        /gh auth status|not logged in/i
      );

      // 2. Full PR creation flow with stub execFn
      const calls = [];
      let committedRegistry = null;
      let observedCloneDir = '';

      const res = openRegistryPr({
        repoRoot: pluginDir,
        hangarRepo: 'arthurcavallari/antigravity-hangar',
        kitRoot: KIT_ROOT,
        execFn: (cmd, args, opts) => {
          calls.push({ cmd, args, cwd: opts?.cwd || '' });
          if (cmd === 'gh' && args[0] === 'repo' && (args[1] === 'fork' || args[1] === 'clone')) {
            const dashIdx = args.indexOf('--');
            const targetCloneDir =
              args[1] === 'fork' && dashIdx !== -1 ? args[dashIdx + 1] : args[3];
            observedCloneDir = targetCloneDir;
            mkdirSync(targetCloneDir, { recursive: true });
            writeJsonNoBom(join(targetCloneDir, 'registry.json'), makeRegistryFixture([]));
            return '';
          }
          if (cmd === 'git' && args[0] === 'commit') {
            committedRegistry = JSON.parse(
              readFileSync(join(opts.cwd, 'registry.json'), 'utf8')
            );
            return '';
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            return 'https://github.com/arthurcavallari/antigravity-hangar/pull/42\n';
          }
          return '';
        },
      });

      assert.equal(res.branch, 'registry/agy-comet-1.0.0');
      assert.equal(res.prUrl, 'https://github.com/arthurcavallari/antigravity-hangar/pull/42');

      // Verify sequence of commands
      assert.deepEqual(calls[0].args.slice(0, 2), ['auth', 'status']);
      assert.equal(calls[0].cmd, 'gh');
      assert.ok(
        calls.some(
          (c) =>
            c.cmd === 'gh' &&
            c.args[0] === 'repo' &&
            (c.args[1] === 'fork' || c.args[1] === 'clone') &&
            c.args.includes('arthurcavallari/antigravity-hangar')
        )
      );
      assert.ok(
        calls.some(
          (c) =>
            c.cmd === 'git' &&
            c.args[0] === 'checkout' &&
            c.args.includes('registry/agy-comet-1.0.0')
        )
      );
      assert.ok(
        calls.some((c) => c.cmd === 'git' && c.args[0] === 'add' && c.args.includes('registry.json'))
      );
      assert.ok(calls.some((c) => c.cmd === 'git' && c.args[0] === 'commit'));
      assert.ok(
        calls.some(
          (c) =>
            c.cmd === 'git' &&
            c.args[0] === 'push' &&
            c.args.includes('registry/agy-comet-1.0.0')
        )
      );
      assert.ok(
        calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')
      );

      // Verify committed registry.json passes Hangar validation and includes agy-comet
      assert.ok(committedRegistry);
      assert.equal(committedRegistry.packages.length, 1);
      assert.equal(committedRegistry.packages[0].id, 'agy-comet');
      assert.deepEqual(hangarReferenceValidateRegistry(committedRegistry), []);

      // Verify temporary clone directory was cleaned up
      assert.ok(observedCloneDir);
      assert.equal(existsSync(observedCloneDir), false, 'temporary clone directory must be cleaned up');
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Critical #1): inferPluginTier escalates sidecar ${PLUGIN_ROOT}/.., command escapes, absolute/~/ paths, --flag= & $PLUGIN_ROOT vars, and inspects in-root string hooks/mcpServers without flagging cmd /c', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-tier-crit1-'));
    try {
      const makePlug = (sub, manifestExtra = {}) => {
        const dir = join(tmp, sub);
        mkdirSync(dir, { recursive: true });
        writeJsonNoBom(join(dir, 'plugin.json'), {
          name: `agy-${sub}`,
          description: 'fixture',
          version: '1.0.0',
          ...manifestExtra,
        });
        return dir;
      };

      // 1. Nested sidecar ${PLUGIN_ROOT}/../outside.mjs and command: "../../../outside"
      const scRootVar = makePlug('sc-rootvar');
      mkdirSync(join(scRootVar, 'sidecars', 'panel'), { recursive: true });
      writeJsonNoBom(join(scRootVar, 'sidecars', 'panel', 'sidecar.json'), {
        command: 'node',
        args: ['${PLUGIN_ROOT}/../outside.mjs'],
      });
      assert.equal(inferPluginTier(scRootVar).tier, 'TIER_3_AGENT_CONTROL');

      const scCmdEsc = makePlug('sc-cmd-esc');
      mkdirSync(join(scCmdEsc, 'sidecars', 'panel'), { recursive: true });
      writeJsonNoBom(join(scCmdEsc, 'sidecars', 'panel', 'sidecar.json'), {
        command: '../../../outside',
        args: [],
      });
      assert.equal(inferPluginTier(scCmdEsc).tier, 'TIER_3_AGENT_CONTROL');

      // 2. Absolute and ~/ paths in cwd, hooks string, and mcpServers string
      for (const [idx, badCwd] of ['/tmp/outside', 'C:\\outside', '~/outside'].entries()) {
        const d = makePlug(`abs-cwd-${idx}`);
        writeJsonNoBom(join(d, 'mcp_config.json'), {
          mcpServers: { srv: { command: 'node', args: ['srv.mjs'], cwd: badCwd } },
        });
        assert.equal(inferPluginTier(d).tier, 'TIER_3_AGENT_CONTROL', `cwd=${badCwd}`);
      }

      const absHooks = makePlug('abs-hooks', { hooks: '/outside/hooks.json' });
      assert.equal(inferPluginTier(absHooks).tier, 'TIER_3_AGENT_CONTROL');

      const absMcp = makePlug('abs-mcp', { mcpServers: '/outside/mcp.json' });
      assert.equal(inferPluginTier(absMcp).tier, 'TIER_3_AGENT_CONTROL');

      // 3. Prefixed --config=${PLUGIN_ROOT}/.. and unbraced $PLUGIN_ROOT / $CLAUDE_PLUGIN_ROOT / ${GEMINI_PLUGIN_PATH}
      for (const [idx, badArg] of [
        '--config=${PLUGIN_ROOT}/../outside.json',
        '$PLUGIN_ROOT/../outside.mjs',
        '$CLAUDE_PLUGIN_ROOT/../outside.mjs',
        '${GEMINI_PLUGIN_PATH}/../outside.mjs',
      ].entries()) {
        const d = makePlug(`var-esc-${idx}`);
        writeJsonNoBom(join(d, 'mcp_config.json'), {
          mcpServers: { srv: { command: 'node', args: [badArg] } },
        });
        assert.equal(inferPluginTier(d).tier, 'TIER_3_AGENT_CONTROL', `arg=${badArg}`);
      }

      // Windows cmd /c switch in args must NOT be misclassified as a POSIX absolute path
      const cmdSwitchDir = makePlug('win-cmd-switch');
      writeJsonNoBom(join(cmdSwitchDir, 'mcp_config.json'), {
        mcpServers: { srv: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'node server.mjs'] } },
      });
      assert.equal(inferPluginTier(cmdSwitchDir).tier, 'TIER_2_LOCAL_TOOLING');

      // 4. In-root string hooks & mcpServers load and inspect target JSON (and escalate if missing/symlinked out)
      const strHooksT2 = makePlug('str-hooks-t2', { hooks: './custom/hooks.json' });
      mkdirSync(join(strHooksT2, 'custom'), { recursive: true });
      writeJsonNoBom(join(strHooksT2, 'custom', 'hooks.json'), {
        SessionStart: [{ type: 'command', command: 'node start.mjs' }],
      });
      assert.equal(inferPluginTier(strHooksT2).tier, 'TIER_2_LOCAL_TOOLING');

      const strHooksT3 = makePlug('str-hooks-t3', { hooks: './custom/hooks.json' });
      mkdirSync(join(strHooksT3, 'custom'), { recursive: true });
      writeJsonNoBom(join(strHooksT3, 'custom', 'hooks.json'), {
        Stop: [{ type: 'command', command: 'node stop.mjs' }],
      });
      assert.equal(inferPluginTier(strHooksT3).tier, 'TIER_3_AGENT_CONTROL');

      const strHooksMissing = makePlug('str-hooks-missing', { hooks: './custom/missing.json' });
      assert.equal(inferPluginTier(strHooksMissing).tier, 'TIER_3_AGENT_CONTROL');

      const strMcpT2 = makePlug('str-mcp-t2', { mcpServers: './custom/mcp.json' });
      mkdirSync(join(strMcpT2, 'custom'), { recursive: true });
      writeJsonNoBom(join(strMcpT2, 'custom', 'mcp.json'), {
        mcpServers: { local: { command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'] } },
      });
      assert.equal(inferPluginTier(strMcpT2).tier, 'TIER_2_LOCAL_TOOLING');
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Important #1): standalone sidecar tier inference upgrades runtime child_process imports to TIER_2 and ignores test/, scripts/, dist/, and setup.mjs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-sc-tier-'));
    try {
      const scDir = join(tmp, 'antigravity-gauge');
      scaffolder.scaffoldProject({
        name: 'gauge',
        archetype: 'sidecar-ui',
        targetDir: scDir,
        github: 'octocat',
      });

      // Test/build/setup files referencing child_process or sidecar.agent.sendMessage must NOT escalate
      writeFileSync(
        join(scDir, 'test', 'extra.test.mjs'),
        'import "node:child_process";\nconst x = () => sidecar.agent.sendMessage("in test");\n',
        'utf8'
      );
      mkdirSync(join(scDir, 'scripts'), { recursive: true });
      writeFileSync(
        join(scDir, 'scripts', 'release-helper.mjs'),
        'import "child_process";\nsidecar.agent.startConversation();\n',
        'utf8'
      );
      mkdirSync(join(scDir, 'dist'), { recursive: true });
      writeFileSync(join(scDir, 'dist', 'stale.mjs'), 'sidecar.agent.sendMessage("stale");\n', 'utf8');
      writeFileSync(
        join(scDir, 'setup.mjs'),
        `${readFileSync(join(scDir, 'setup.mjs'), 'utf8')}\n// import 'node:child_process'; sidecar.agent.sendMessage('setup');\n`,
        'utf8'
      );

      const entryT1 = buildRegistryEntry({ repoRoot: scDir, kitRoot: KIT_ROOT });
      assert.equal(entryT1.capabilityTier, 'TIER_1_TELEMETRY');

      // Runtime server.mjs importing node:child_process upgrades to TIER_2_LOCAL_TOOLING
      const origServer = readFileSync(join(scDir, 'server.mjs'), 'utf8');
      writeFileSync(
        join(scDir, 'server.mjs'),
        `import { execFile } from 'node:child_process';\nvoid execFile;\n${origServer}`,
        'utf8'
      );
      const entryT2 = buildRegistryEntry({ repoRoot: scDir, kitRoot: KIT_ROOT });
      assert.equal(entryT2.capabilityTier, 'TIER_2_LOCAL_TOOLING');

      // Runtime ui/app.js calling sidecar.agent.sendMessage upgrades to TIER_3_AGENT_CONTROL
      writeFileSync(
        join(scDir, 'ui', 'app.js'),
        `${readFileSync(join(scDir, 'ui', 'app.js'), 'utf8')}\nwindow.sidecar.agent.sendMessage('go');\n`,
        'utf8'
      );
      const entryT3 = buildRegistryEntry({ repoRoot: scDir, kitRoot: KIT_ROOT });
      assert.equal(entryT3.capabilityTier, 'TIER_3_AGENT_CONTROL');
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Important #2): upsertRegistryFile rejects broken hangar, featuredIds, and packages element structures without modifying disk', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-upsert-struct-'));
    try {
      const validEntry = {
        id: 'agy-nova',
        name: 'Nova',
        kind: 'plugin',
        tagline: 'Nova plugin.',
        author: { name: 'Octocat', github: 'octocat' },
        latestVersion: '1.0.0',
        pricing: 'free',
        categories: ['utilities'],
        capabilityTier: 'TIER_1_TELEMETRY',
        license: 'MIT',
        homepage: 'https://github.com/octocat/agy-nova',
        release: {
          tarballUrl:
            'https://github.com/octocat/agy-nova/releases/download/v1.0.0/agy-nova-plugin-1.0.0.tgz',
          sha256: 'd'.repeat(64),
        },
      };

      const invalidRegistries = [
        ['missing-hangar.json', '{"packages":[]}\n'],
        ['null-hangar.json', '{"hangar":null,"packages":[]}\n'],
        ['wrong-hangar-id.json', '{"hangar":{"id":"not-hangar"},"packages":[]}\n'],
        ['bad-featured.json', '{"hangar":{"id":"hangar"},"featuredIds":"bad","packages":[]}\n'],
        ['null-pkg-item.json', '{"hangar":{"id":"hangar"},"packages":[null]}\n'],
        ['bad-pkg-id.json', '{"hangar":{"id":"hangar"},"packages":[{"id":"../evil"}]}\n'],
      ];

      for (const [name, raw] of invalidRegistries) {
        const p = join(tmp, name);
        writeFileSync(p, raw, 'utf8');
        assert.throws(() => upsertRegistryFile(p, validEntry), undefined, name);
        assert.equal(readFileSync(p, 'utf8'), raw, `${name} must remain untouched`);
      }
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Important #3): openRegistryPr handles "cannot be forked", forwards env, syncs upstream remote, and passes --head <forkOwner>:<branch> on contributor forks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-pr-fix-'));
    try {
      const pluginDir = join(tmp, 'agy-flare');
      scaffolder.scaffoldProject({
        name: 'flare',
        archetype: 'plugin',
        targetDir: pluginDir,
        components: ['skills'],
        author: 'Flare Dev',
        github: 'octocat',
      });

      const customEnv = { ...process.env, GH_TOKEN: 'ghs_test_secret_token_123' };

      // Case A: Self-fork ("arthurcavallari/antigravity-hangar cannot be forked") falls back to gh repo clone and forwards env
      const selfCalls = [];
      const selfRes = openRegistryPr({
        repoRoot: pluginDir,
        hangarRepo: 'arthurcavallari/antigravity-hangar',
        kitRoot: KIT_ROOT,
        agyValidate: false,
        env: customEnv,
        execFn: (cmd, args, opts) => {
          selfCalls.push({ cmd, args, env: opts?.env });
          if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'fork') {
            throw new Error('arthurcavallari/antigravity-hangar cannot be forked');
          }
          if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
            const cloneDir = args[3];
            mkdirSync(cloneDir, { recursive: true });
            writeJsonNoBom(join(cloneDir, 'registry.json'), makeRegistryFixture([]));
            return '';
          }
          if (cmd === 'git' && args[0] === 'remote' && args[2] === 'upstream') {
            throw new Error("error: No such remote 'upstream'");
          }
          if (cmd === 'git' && args[0] === 'remote' && args[2] === 'origin') {
            return 'https://github.com/arthurcavallari/antigravity-hangar.git\n';
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            return 'https://github.com/arthurcavallari/antigravity-hangar/pull/99\n';
          }
          return '';
        },
      });

      assert.equal(selfRes.prUrl, 'https://github.com/arthurcavallari/antigravity-hangar/pull/99');
      assert.ok(selfCalls.every((c) => c.env?.GH_TOKEN === 'ghs_test_secret_token_123'));
      assert.ok(selfCalls.some((c) => c.cmd === 'gh' && c.args[0] === 'repo' && c.args[1] === 'clone'));
      const selfPrCall = selfCalls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr');
      assert.equal(selfPrCall.args.includes('--head'), false);

      // Case B: Contributor fork with pre-existing upstream remote bases off upstream/FETCH_HEAD and passes --head octocat:<branch>
      const forkCalls = [];
      const forkRes = openRegistryPr({
        repoRoot: pluginDir,
        hangarRepo: 'arthurcavallari/antigravity-hangar',
        kitRoot: KIT_ROOT,
        agyValidate: false,
        env: customEnv,
        execFn: (cmd, args) => {
          forkCalls.push({ cmd, args });
          if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'fork') {
            const dashIdx = args.indexOf('--');
            const cloneDir = args[dashIdx + 1];
            mkdirSync(cloneDir, { recursive: true });
            writeJsonNoBom(join(cloneDir, 'registry.json'), makeRegistryFixture([]));
            return '';
          }
          if (cmd === 'git' && args[0] === 'remote' && args[2] === 'upstream') {
            return 'https://github.com/arthurcavallari/antigravity-hangar.git\n';
          }
          if (cmd === 'git' && args[0] === 'remote' && args[2] === 'origin') {
            return 'git@github.com:octocat/antigravity-hangar.git\n';
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            return 'https://github.com/arthurcavallari/antigravity-hangar/pull/100\n';
          }
          return '';
        },
      });

      assert.equal(forkRes.prUrl, 'https://github.com/arthurcavallari/antigravity-hangar/pull/100');
      assert.ok(
        forkCalls.some(
          (c) => c.cmd === 'git' && c.args[0] === 'fetch' && c.args.includes('upstream')
        )
      );
      assert.ok(
        forkCalls.some(
          (c) =>
            c.cmd === 'git' &&
            c.args[0] === 'checkout' &&
            c.args.includes('registry/agy-flare-1.0.0') &&
            c.args.includes('FETCH_HEAD')
        )
      );
      const forkPrCall = forkCalls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr');
      const headIdx = forkPrCall.args.indexOf('--head');
      assert.notEqual(headIdx, -1);
      assert.equal(forkPrCall.args[headIdx + 1], 'octocat:registry/agy-flare-1.0.0');
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (C1): supports --sha256 override without clobbering outDir, fails upfront on malformed sha256 before gh, reuses existing .tgz.sha256/.tgz, and guards srcPluginDir containment', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-reg-c1-'));
    try {
      const pluginDir = join(tmp, 'agy-prism');
      scaffolder.scaffoldProject({
        name: 'prism',
        archetype: 'plugin',
        targetDir: pluginDir,
        components: ['skills', 'mcp'],
        author: 'Prism Dev',
        github: 'octocat',
      });

      const distPluginDir = join(pluginDir, 'dist', 'plugin');
      const tarPath = join(distPluginDir, 'agy-prism-plugin-1.0.0.tgz');
      const shaPath = `${tarPath}.sha256`;

      // (a) Explicit sha256 override does NOT create or clobber dist/plugin
      const overrideUpper = `  ${'AbCdEf01'.repeat(8)}  `;
      const entryOverride = buildRegistryEntry({
        repoRoot: pluginDir,
        kitRoot: KIT_ROOT,
        agyValidate: false,
        sha256: overrideUpper,
      });
      assert.equal(entryOverride.release.sha256, 'abcdef01'.repeat(8));
      assert.equal(
        existsSync(distPluginDir),
        false,
        'explicit sha256 must stage in temp dir without creating dist/plugin'
      );

      // Positional (repoDir, { gitRepo, sha256 }) form also preserves existing dist/plugin files untouched
      mkdirSync(distPluginDir, { recursive: true });
      const sentinelBytes = Buffer.from('ci-built-canonical-tarball-bytes');
      const sentinelSha = createHash('sha256').update(sentinelBytes).digest('hex');
      writeFileSync(tarPath, sentinelBytes);
      writeFileSync(shaPath, `${sentinelSha}  agy-prism-plugin-1.0.0.tgz\n`, 'utf8');

      const positionalOverride = buildRegistryEntry(pluginDir, {
        gitRepo: 'https://github.com/octocat/agy-prism-custom',
        sha256: 'f'.repeat(64),
        kitRoot: KIT_ROOT,
        agyValidate: false,
      });
      assert.equal(positionalOverride.release.sha256, 'f'.repeat(64));
      assert.equal(
        positionalOverride.release.tarballUrl,
        'https://github.com/octocat/agy-prism-custom/releases/download/v1.0.0/agy-prism-plugin-1.0.0.tgz'
      );
      assert.equal(
        Buffer.compare(readFileSync(tarPath), sentinelBytes),
        0,
        'explicit sha256 must not overwrite existing .tgz'
      );

      // (b) Malformed sha256 fails upfront BEFORE any gh commands in openRegistryPr
      for (const badSha of ['', 'not-hex', 'a'.repeat(63), 'g'.repeat(64), 12345]) {
        let ghInvoked = false;
        assert.throws(
          () =>
            openRegistryPr({
              repoRoot: pluginDir,
              sha256: badSha,
              kitRoot: KIT_ROOT,
              agyValidate: false,
              execFn: () => {
                ghInvoked = true;
                return '';
              },
            }),
          /sha256/i
        );
        assert.equal(ghInvoked, false, `execFn must not run for malformed sha256=${String(badSha)}`);
      }

      // Rejects sha256 on standalone sidecar repos where sha256 is not part of release
      const sidecarDir = join(tmp, 'antigravity-solo');
      scaffolder.scaffoldProject({
        name: 'solo',
        archetype: 'sidecar-ui',
        targetDir: sidecarDir,
        github: 'octocat',
      });
      assert.throws(
        () =>
          buildRegistryEntry({
            repoRoot: sidecarDir,
            sha256: 'a'.repeat(64),
            kitRoot: KIT_ROOT,
          }),
        /only supported for plugin/i
      );

      // (c1) Matching .tgz + .tgz.sha256 in dist/plugin returns recorded digest without rebuilding .tgz
      const reusedBoth = buildRegistryEntry({
        repoRoot: pluginDir,
        kitRoot: KIT_ROOT,
        agyValidate: false,
      });
      assert.equal(reusedBoth.release.sha256, sentinelSha);
      assert.equal(
        Buffer.compare(readFileSync(tarPath), sentinelBytes),
        0,
        'existing matching .tgz must not be rebuilt/overwritten'
      );

      // (c2) Mismatched .tgz vs .tgz.sha256 throws an error
      writeFileSync(shaPath, `${'0'.repeat(64)}  agy-prism-plugin-1.0.0.tgz\n`, 'utf8');
      assert.throws(
        () =>
          buildRegistryEntry({
            repoRoot: pluginDir,
            kitRoot: KIT_ROOT,
            agyValidate: false,
          }),
        /mismatch/i
      );

      // (c3) Downloaded .tgz.sha256 alone (without .tgz on disk) returns recorded digest without building .tgz
      removeLinkOrDir(tarPath);
      const downloadedCiSha = '9876543210abcdef'.repeat(4);
      writeFileSync(shaPath, `${downloadedCiSha.toUpperCase()} *agy-prism-plugin-1.0.0.tgz\n`, 'utf8');
      const fromShaFileOnly = buildRegistryEntry({
        repoRoot: pluginDir,
        kitRoot: KIT_ROOT,
        agyValidate: false,
      });
      assert.equal(fromShaFileOnly.release.sha256, downloadedCiSha);
      assert.equal(
        readdirSync(join(pluginDir, 'dist', 'plugin')).includes('agy-prism-plugin-1.0.0.tgz'),
        false,
        'must not build local .tgz when .tgz.sha256 exists'
      );

      // Malformed .tgz.sha256 throws
      writeFileSync(shaPath, 'corrupt-digest  agy-prism-plugin-1.0.0.tgz\n', 'utf8');
      assert.throws(
        () =>
          buildRegistryEntry({
            repoRoot: pluginDir,
            kitRoot: KIT_ROOT,
            agyValidate: false,
          }),
        /malformed/i
      );

      // (c4) Existing .tgz alone (without .tgz.sha256) hashes existing .tgz without overwriting it
      removeLinkOrDir(shaPath);
      writeFileSync(tarPath, sentinelBytes);
      const pluginPkgPath = join(pluginDir, 'package.json');
      const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf8'));
      pluginPkg.author = 'Prism <<script>bad> Dev <prism@example.com> (https://example.com)';
      writeJsonNoBom(pluginPkgPath, pluginPkg);
      const pluginJsonPath = join(pluginDir, 'plugin', 'plugin.json');
      const pluginManifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
      delete pluginManifest.author;
      writeJsonNoBom(pluginJsonPath, pluginManifest);

      const fromTarOnly = buildRegistryEntry({
        repoRoot: pluginDir,
        kitRoot: KIT_ROOT,
        agyValidate: false,
      });
      assert.equal(fromTarOnly.release.sha256, sentinelSha);
      assert.equal(fromTarOnly.author.name, 'Prism Dev');
      assert.equal(Buffer.compare(readFileSync(tarPath), sentinelBytes), 0);

      // (d) Guards srcPluginDir against repo escape and symlinks
      const outsidePlugin = join(tmp, 'outside-plugin');
      mkdirSync(outsidePlugin, { recursive: true });
      writeJsonNoBom(join(outsidePlugin, 'plugin.json'), {
        name: 'agy-escaped',
        description: 'escaped',
        version: '1.0.0',
      });

      const escapeRepo = join(tmp, 'agy-escape-reg');
      scaffolder.scaffoldProject({
        name: 'escape-reg',
        archetype: 'plugin',
        targetDir: escapeRepo,
        components: ['skills'],
        github: 'octocat',
      });
      const escapePkgPath = join(escapeRepo, 'package.json');
      const escapePkg = JSON.parse(readFileSync(escapePkgPath, 'utf8'));
      writeJsonNoBom(escapePkgPath, {
        ...escapePkg,
        agyPlugin: { ...escapePkg.agyPlugin, pluginDir: '../outside-plugin' },
      });
      assert.throws(
        () => buildRegistryEntry({ repoRoot: escapeRepo, kitRoot: KIT_ROOT, agyValidate: false }),
        /escapes/i
      );

      removeLinkOrDir(join(escapeRepo, 'plugin'));
      symlinkSync(
        outsidePlugin,
        join(escapeRepo, 'plugin'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      writeJsonNoBom(escapePkgPath, escapePkg);
      assert.throws(
        () => buildRegistryEntry({ repoRoot: escapeRepo, kitRoot: KIT_ROOT, agyValidate: false }),
        /symbolic link/i
      );
    } finally {
      removeLinkOrDir(tmp);
    }
  });
});
