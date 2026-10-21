#!/usr/bin/env node
/**
 * @fileoverview Packs the kit, installs the tarball into an empty project, and exercises
 * the published surface (bins via npx, every exports subpath, shipped file list).
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
  const [{ filename }] = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, ROOT));
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(`npm install --no-audit --no-fund "${join(work, filename)}"`, app);

  const installed = join(app, 'node_modules', pkg.name);
  assert.equal(existsSync(join(installed, 'test')), false, 'test/ must not be published');

  // Every bin resolves (npx == npm exec), including the one named after the package
  for (const bin of Object.keys(pkg.bin)) {
    assert.match(run(`npm exec --no -- ${bin} --help`, app), /init <sidecar-name>/, `npx ${bin} --help`);
  }

  run(`npm exec --no -- ${pkg.name} init demo --dir demo`, app);
  for (const rel of ['package.json', 'sidecar.json', 'hub-manifest.json', 'server.mjs', 'setup.mjs', 'ui/index.html']) {
    assert.equal(existsSync(join(app, 'demo', rel)), true, `scaffolded ${rel}`);
  }

  // Every exports subpath loads from the installed package
  for (const subpath of Object.keys(pkg.exports)) {
    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    run(`node --input-type=module -e "await import('${specifier}')"`, app);
  }

  console.log(`[pack-smoke] ${filename}: bins, scaffold, and ${Object.keys(pkg.exports).length} exports OK`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
