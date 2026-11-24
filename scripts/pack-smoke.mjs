#!/usr/bin/env node
/**
 * @fileoverview Packs the kit, installs the tarball into an empty project, and exercises
 * the published surface (bins via npx, sidecar + plugin archetypes, build-plugin, every exports subpath, shipped file list).
 * Unit tests import lib/ directly and cannot catch packaging mistakes; this does.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'kit-pack-smoke-'));

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

try {
  const [{ filename }] = JSON.parse(
    run(`npm pack --ignore-scripts --json --pack-destination "${work}"`, ROOT)
  );
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' })
  );
  run(`npm install --ignore-scripts --no-audit --no-fund "${join(work, filename)}"`, app);

  const installed = join(app, 'node_modules', pkg.name);
  assert.equal(existsSync(join(installed, 'test')), false, 'test/ must not be published');

  // Every bin resolves (npx == npm exec), including create-agy and agy-kit
  for (const bin of Object.keys(pkg.bin)) {
    assert.match(
      run(`npm exec --no -- ${bin} --help`, app),
      /init <sidecar-name>/,
      `npx ${bin} --help`
    );
  }

  run(`npm exec --no -- ${pkg.name} init demo --dir demo -y`, app);
  for (const rel of [
    'package.json',
    'sidecar.json',
    'hub-manifest.json',
    'server.mjs',
    'setup.mjs',
    'ui/index.html',
  ]) {
    assert.equal(existsSync(join(app, 'demo', rel)), true, `scaffolded ${rel}`);
  }

  // Exercise plugin archetype + build-plugin from the installed tarball (verifies workflow assets & lib/cli/*)
  run(
    'npm exec --no -- agy-kit init demo-plug --archetype plugin --components skills,mcp --github octocat --dir demo-plug -y',
    app
  );
  const builtJson = JSON.parse(
    run('npm exec --no -- agy-kit build-plugin --dir demo-plug --no-agy-validate --json', app)
  );
  assert.equal(builtJson.pluginName, 'agy-demo-plug');
  assert.equal(existsSync(builtJson.tarball), true, 'packed kit builds plugin tarball');

  // Every exports subpath loads from the installed package
  // ./cli is an entrypoint: importing it runs the CLI, so it is exercised through the bins instead
  const importable = Object.keys(pkg.exports).filter((subpath) => subpath !== './cli');
  for (const subpath of importable) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    run(`node --input-type=module -e "await import('${specifier}')"`, app);
  }

  run(
    `node --input-type=module -e "import assert from 'node:assert/strict'; import { StandaloneSidecarApp, createSidecarApp } from '${pkg.name}/server'; import { startStdioMcpBridge } from '${pkg.name}/state-sync'; assert.equal(typeof StandaloneSidecarApp, 'function'); assert.equal(typeof createSidecarApp, 'function'); assert.equal(typeof startStdioMcpBridge, 'function');"`,
    app
  );

  console.log(`[pack-smoke] ${filename}: bins, archetypes, and ${importable.length} exports OK`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
