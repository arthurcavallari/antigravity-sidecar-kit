import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

      const again = spawnSync(process.execPath, [CLI, 'init', 'demo', '--dir', outDir], { encoding: 'utf8' });
      assert.equal(again.status, 1, 'refuses to overwrite without --force');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
