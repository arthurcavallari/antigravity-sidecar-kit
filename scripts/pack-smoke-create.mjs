#!/usr/bin/env node
/**
 * @fileoverview Packs the kit and the create-antigravity-sidecar wrapper, installs both tarballs
 * into an empty project, and checks that the wrapper's bin scaffolds a project. Installing the kit
 * from its tarball means this works before the matching kit version is on the registry.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = join(ROOT, 'packages', 'create-antigravity-sidecar');
const work = mkdtempSync(join(tmpdir(), 'kit-pack-create-'));

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const pack = (cwd) => join(work, JSON.parse(run(`npm pack --json --pack-destination "${work}"`, cwd))[0].filename);

try {
  const kitTgz = pack(ROOT);
  const wrapperTgz = pack(WRAPPER);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(`npm install --no-audit --no-fund "${kitTgz}" "${wrapperTgz}"`, app);

  assert.match(run('npm exec --no -- create-antigravity-sidecar --help', app), /init <sidecar-name>/);
  run('npm exec --no -- create-antigravity-sidecar demo --dir demo', app);
  for (const rel of ['package.json', 'sidecar.json', 'server.mjs', 'setup.mjs', 'ui/index.html']) {
    assert.equal(existsSync(join(app, 'demo', rel)), true, `scaffolded ${rel}`);
  }
  console.log('[pack-smoke-create] create-antigravity-sidecar scaffolds a project via the kit CLI');
} finally {
  rmSync(work, { recursive: true, force: true });
}
