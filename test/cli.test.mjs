import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHubManifest } from '../lib/scaffolder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'cli.mjs');

describe('antigravity-sidecar-kit CLI', () => {
  it('exposes all CLI bins and syncs both create-* wrapper packages to the kit version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.bin[pkg.name], 'bin/cli.mjs');
    assert.equal(pkg.bin['create-antigravity-sidecar'], 'bin/cli.mjs');
    assert.equal(pkg.bin['create-agy'], 'bin/cli.mjs');
    assert.equal(pkg.bin['agy-sidecar-kit'], 'bin/cli.mjs');
    assert.equal(pkg.bin['agy-kit'], 'bin/cli.mjs');

    const sidecarWrapperPkg = JSON.parse(
      readFileSync(join(ROOT, 'packages', 'create-antigravity-sidecar', 'package.json'), 'utf8')
    );
    assert.equal(sidecarWrapperPkg.dependencies['antigravity-sidecar-kit'], `^${pkg.version}`);

    const createAgyDir = join(ROOT, 'packages', 'create-agy');
    const createAgyPkg = JSON.parse(readFileSync(join(createAgyDir, 'package.json'), 'utf8'));
    assert.equal(createAgyPkg.name, 'create-agy');
    assert.equal(createAgyPkg.bin['create-agy'], 'bin/cli.mjs');
    assert.equal(createAgyPkg.dependencies['antigravity-sidecar-kit'], `^${pkg.version}`);
    assert.equal(existsSync(join(createAgyDir, 'bin', 'cli.mjs')), true);
    assert.equal(existsSync(join(createAgyDir, 'README.md')), true);
    assert.equal(existsSync(join(createAgyDir, 'LICENSE')), true);
    assert.equal(existsSync(join(ROOT, '.github', 'workflows', 'publish-create-agy.yml')), true);

    const publishYml = readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
    assert.match(publishYml, /packages\/create-antigravity-sidecar\/package\.json/);
    assert.match(publishYml, /packages\/create-agy\/package\.json/);

    assert.equal(existsSync(join(ROOT, 'package-lock.json')), true);
  });

  it('prints usage with all 4 archetypes and 5 subcommands for --help, exits 1 without a name', () => {
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /npx antigravity-sidecar-kit init/);
    assert.match(help.stdout, /init <sidecar-name>/);
    for (const archetype of ['sidecar-ui', 'sidecar-mcp', 'plugin', 'plugin-sidecar']) {
      assert.match(help.stdout, new RegExp(`\\b${archetype}\\b`), `help mentions ${archetype}`);
    }
    for (const subcmd of ['init', 'lint', 'pack-smoke', 'build-plugin', 'registry-entry']) {
      assert.match(help.stdout, new RegExp(`\\b${subcmd}\\b`), `help mentions ${subcmd}`);
    }

    const missing = spawnSync(process.execPath, [CLI, 'init'], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
  });

  it('scaffolds a project into --dir and prints next steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-cli-'));
    try {
      const outDir = join(dir, 'demo');
      const out = execFileSync(process.execPath, [CLI, 'init', 'demo', '--dir', outDir], {
        encoding: 'utf8',
      });
      assert.match(out, /npm install/);
      for (const rel of ['package.json', 'sidecar.json', 'hub-manifest.json', 'server.mjs', 'setup.mjs', 'ui/index.html']) {
        assert.equal(existsSync(join(outDir, rel)), true, rel);
      }
      const kitPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      const generatedPkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(generatedPkg.dependencies['antigravity-sidecar-kit'], `^${kitPkg.version}`);
      const generatedServer = readFileSync(join(outDir, 'server.mjs'), 'utf8');
      assert.doesNotMatch(generatedServer, /import \{ SidecarApp, Response \} from 'sidecar_sdk'/);
      assert.match(generatedServer, /await import\('sidecar_sdk'\)\.catch\(\(\) => null\)/);
      assert.match(generatedServer, /createSidecarApp/);
      assert.match(generatedServer, /setupSidecarServer/);
      assert.match(generatedServer, /exitWithLanguageServer/);

      const again = spawnSync(process.execPath, [CLI, 'init', 'demo', '--dir', outDir], { encoding: 'utf8' });
      assert.equal(again.status, 1, 'refuses to overwrite without --force');

      const sidebarDir = join(dir, 'sidebar-demo');
      execFileSync(
        process.execPath,
        [CLI, 'init', 'sidebar-demo', '--dir', sidebarDir, '--entrypoint', 'sidebar', '--hide-title-bar'],
        { encoding: 'utf8' }
      );
      const sidebarManifest = JSON.parse(readFileSync(join(sidebarDir, 'sidecar.json'), 'utf8'));
      assert.deepEqual(sidebarManifest.ui_config.views, [
        {
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
          path: '/',
          title: 'Sidebar Demo',
          title_bar_style: 'SIDECAR_UI_TITLE_BAR_STYLE_HIDDEN',
        },
      ]);
      const lintSidebar = spawnSync(process.execPath, [CLI, 'lint', '--json', sidebarDir], { encoding: 'utf8' });
      assert.equal(lintSidebar.status, 0);
      assert.equal(JSON.parse(lintSidebar.stdout).valid, true);

      const badEp = spawnSync(
        process.execPath,
        [CLI, 'init', 'bad-ep', '--dir', join(dir, 'bad-ep'), '--entrypoint=bogus'],
        { encoding: 'utf8' }
      );
      assert.equal(badEp.status, 1);

      const emptyEp = spawnSync(
        process.execPath,
        [CLI, 'init', 'empty-ep', '--dir', join(dir, 'empty-ep'), '--entrypoint'],
        { encoding: 'utf8' }
      );
      assert.equal(emptyEp.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generateHubManifest emits tagline, non-empty categories, and author object', () => {
    const manifest = JSON.parse(generateHubManifest({ id: 'demo-sidecar', title: 'Demo Sidecar' }));
    assert.equal(typeof manifest.tagline, 'string');
    assert.ok(manifest.tagline.length > 0);
    assert.equal(typeof manifest.author, 'object');
    assert.equal(typeof manifest.author.name, 'string');
    assert.ok(Array.isArray(manifest.categories) && manifest.categories.length > 0);
    assert.deepEqual(manifest.workspaceTriggers.files, ['package.json']);
  });

  it('supports `lint [--fix] [--json] [dir]` subcommand and exits 1 on errors until fixed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-cli-lint-'));
    try {
      writeFileSync(
        join(dir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { figma: { url: 'https://mcp.figma.com/mcp' } } }, null, 2)
      );

      const failRun = spawnSync(process.execPath, [CLI, 'lint', '--json', dir], { encoding: 'utf8' });
      assert.equal(failRun.status, 1);
      const failJson = JSON.parse(failRun.stdout);
      assert.equal(failJson.valid, false);
      assert.ok(failJson.errors.some((e) => e.ruleId === 'FIGMA-MCP-01'));

      const fixRun = spawnSync(process.execPath, [CLI, 'lint', '--fix', '--json', `--dir=${dir}`], { encoding: 'utf8' });
      assert.equal(fixRun.status, 0);
      const fixJson = JSON.parse(fixRun.stdout);
      assert.equal(fixJson.valid, true);
      assert.ok(fixJson.fixedCount >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires init (archetype plugin), lint, build-plugin, pack-smoke, and registry-entry end-to-end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-cli-e2e-'));
    try {
      const plugDir = join(dir, 'my-plug');
      const initRun = spawnSync(
        process.execPath,
        [
          CLI,
          'init',
          'my-plug',
          '--archetype',
          'plugin',
          '--components',
          'skills,mcp,hooks',
          '--github',
          'octocat',
          '--dir',
          plugDir,
          '-y',
        ],
        { encoding: 'utf8' }
      );
      assert.equal(initRun.status, 0, initRun.stderr || initRun.stdout);
      for (const rel of [
        'package.json',
        'plugin/plugin.json',
        'plugin/skills/my-plug/SKILL.md',
        'plugin/mcp_config.json',
        'plugin/mcp/server.mjs',
        'plugin/hooks.json',
        'plugin/scripts/session-start.mjs',
      ]) {
        assert.equal(existsSync(join(plugDir, rel)), true, `expected ${rel}`);
      }

      // Repo-root lint inspects nested plugin/ directory automatically
      const rootLint = spawnSync(
        process.execPath,
        [CLI, 'lint', '--strict', '--json', '--dir', plugDir],
        { encoding: 'utf8' }
      );
      assert.equal(rootLint.status, 0, rootLint.stderr || rootLint.stdout);
      assert.equal(JSON.parse(rootLint.stdout).valid, true);

      // build-plugin --dir <tmp> --json
      const buildRun = spawnSync(
        process.execPath,
        [CLI, 'build-plugin', '--dir', plugDir, '--json'],
        { encoding: 'utf8' }
      );
      assert.equal(buildRun.status, 0, buildRun.stderr || buildRun.stdout);
      const built = JSON.parse(buildRun.stdout);
      assert.equal(built.pluginName, 'agy-my-plug');
      assert.equal(typeof built.tarball, 'string');
      assert.equal(existsSync(built.tarball), true);
      assert.match(built.sha256, /^[0-9a-f]{64}$/);
      assert.equal(
        built.sha256,
        createHash('sha256').update(readFileSync(built.tarball)).digest('hex')
      );

      // registry-entry --dir <tmp> --write <tmpRegistry> creates then updates packages[0]
      const tmpRegistry = join(dir, 'registry.json');
      const regCreate = spawnSync(
        process.execPath,
        [CLI, 'registry-entry', '--dir', plugDir, '--write', tmpRegistry],
        { encoding: 'utf8' }
      );
      assert.equal(regCreate.status, 0, regCreate.stderr || regCreate.stdout);
      const regAfterCreate = JSON.parse(readFileSync(tmpRegistry, 'utf8'));
      assert.equal(regAfterCreate.packages.length, 1);
      assert.equal(regAfterCreate.packages[0].id, 'agy-my-plug');
      assert.equal(regAfterCreate.packages[0].kind, 'plugin');
      assert.equal(
        regAfterCreate.packages[0].release.sha256,
        createHash('sha256').update(readFileSync(built.tarball)).digest('hex')
      );

      const regUpdate = spawnSync(
        process.execPath,
        [CLI, 'registry-entry', '--dir', plugDir, '--write', tmpRegistry],
        { encoding: 'utf8' }
      );
      assert.equal(regUpdate.status, 0, regUpdate.stderr || regUpdate.stdout);
      const regAfterUpdate = JSON.parse(readFileSync(tmpRegistry, 'utf8'));
      assert.equal(regAfterUpdate.packages.length, 1);
      assert.equal(regAfterUpdate.packages[0].id, 'agy-my-plug');

      // pack-smoke --dir <tmp> --json
      const smokeRun = spawnSync(
        process.execPath,
        [CLI, 'pack-smoke', '--dir', plugDir, '--json'],
        { encoding: 'utf8' }
      );
      assert.equal(smokeRun.status, 0, smokeRun.stderr || smokeRun.stdout);
      const smokeJson = JSON.parse(smokeRun.stdout);
      assert.equal(smokeJson.npmTarball, null);
      assert.equal(typeof smokeJson.pluginTarball, 'string');

      // Launcher-style default init (no `init` keyword, as invoked by `npm create agy <name> ...`)
      const directDir = join(dir, 'direct-plug');
      const directInit = spawnSync(
        process.execPath,
        [CLI, 'direct-plug', '--archetype', 'plugin', '--dir', directDir, '-y'],
        { encoding: 'utf8' }
      );
      assert.equal(directInit.status, 0, directInit.stderr || directInit.stdout);
      assert.equal(existsSync(join(directDir, 'plugin', 'plugin.json')), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with code 130 without stack trace when interactive prompt is cancelled', () => {
    const cancelRun = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'process.stdin.isTTY = true; process.stdout.isTTY = true; await import("./bin/cli.mjs");',
      ],
      {
        cwd: ROOT,
        input: '\x03',
        encoding: 'utf8',
      }
    );
    assert.equal(cancelRun.status, 130, `stderr=${cancelRun.stderr}`);
    assert.doesNotMatch(cancelRun.stderr, /PromptCancelledError|at /);
  });
});
