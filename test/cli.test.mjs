import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateHubManifest } from '../lib/scaffolder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'cli.mjs');

describe('antigravity-sidecar-kit CLI', () => {
  it('exposes a bin named after the package so `npx antigravity-sidecar-kit` resolves', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.bin[pkg.name], 'bin/cli.mjs');
  });

  it('prints usage and exits 0 for --help, exits 1 without a name', () => {
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /npx antigravity-sidecar-kit init/);

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
      assert.match(generatedServer, /import \{ SidecarApp, Response \} from 'sidecar_sdk'/);
      assert.match(generatedServer, /createAgyCssHandler\(\{ ResponseClass: Response \}\)/);
      assert.match(generatedServer, /import \{ exitWithLanguageServer \} from 'antigravity-sidecar-kit\/lifecycle'/);
      assert.match(generatedServer, /await app\.run\(\);\n[^\n]*\nexitWithLanguageServer\(\{ app \}\);/);

      const again = spawnSync(process.execPath, [CLI, 'init', 'demo', '--dir', outDir], { encoding: 'utf8' });
      assert.equal(again.status, 1, 'refuses to overwrite without --force');
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
});
