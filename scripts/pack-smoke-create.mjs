#!/usr/bin/env node
/**
 * @fileoverview Packs the kit and both create-* launcher wrappers (`create-antigravity-sidecar` and
 * `create-agy`), installs all tarballs offline into an empty project, and checks that both bins
 * scaffold valid projects via the kit CLI. Installing the kit from its tarball with an npm override
 * means this works offline and before the matching kit version is published on the registry.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_SIDECAR = join(ROOT, 'packages', 'create-antigravity-sidecar');
const WRAPPER_AGY = join(ROOT, 'packages', 'create-agy');
const work = mkdtempSync(join(tmpdir(), 'kit-pack-create-'));

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const pack = (cwd) =>
  join(
    work,
    JSON.parse(run(`npm pack --ignore-scripts --json --pack-destination "${work}"`, cwd))[0]
      .filename
  );

try {
  const kitTgz = pack(ROOT);
  const wrapperTgz = pack(WRAPPER_SIDECAR);
  const createAgyTgz = pack(WRAPPER_AGY);

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'smoke',
        private: true,
        type: 'module',
        overrides: {
          'antigravity-sidecar-kit': `file:../${basename(kitTgz)}`,
        },
      },
      null,
      2
    )
  );
  run(
    `npm install --ignore-scripts --no-audit --no-fund "../${basename(kitTgz)}" "../${basename(wrapperTgz)}" "../${basename(createAgyTgz)}"`,
    app
  );

  assert.match(
    run('npm exec --no -- create-antigravity-sidecar --help', app),
    /init <sidecar-name>/
  );
  run('npm exec --no -- create-antigravity-sidecar demo --dir demo -y', app);
  for (const rel of ['package.json', 'sidecar.json', 'server.mjs', 'setup.mjs', 'ui/index.html']) {
    assert.equal(existsSync(join(app, 'demo', rel)), true, `scaffolded sidecar ${rel}`);
  }

  assert.match(run('npm exec --no -- create-agy --help', app), /init <sidecar-name>/);
  run(
    'npm exec --no -- create-agy demo-plug --archetype plugin --components skills,mcp --github octocat --dir demo-plug -y',
    app
  );
  for (const rel of [
    'package.json',
    'plugin/plugin.json',
    'plugin/skills/demo-plug/SKILL.md',
    'plugin/mcp_config.json',
    'plugin/mcp/server.mjs',
  ]) {
    assert.equal(existsSync(join(app, 'demo-plug', rel)), true, `scaffolded plugin ${rel}`);
  }

  console.log(
    '[pack-smoke-create] create-antigravity-sidecar and create-agy scaffold projects via the kit CLI'
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
