import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  CONFIG_JSON_PATH,
  DEFAULT_MCP_CONFIG_PATH,
  GLOBAL_SIDECARS_DIR,
  writeJsonNoBom,
} from '../lib/config.mjs';
import { KIT_ROOT, removeLinkOrDir } from '../lib/setup.mjs';
import * as scaffolder from '../lib/scaffolder.mjs';
import { resolveAgyExecutable, spawnResolvedExecutable } from '../lib/cli/agy-bin.mjs';
import { buildPluginProject } from '../lib/cli/build-plugin.mjs';
import { parseNpmPackJson, resolveNpmCommand, runPackSmoke } from '../lib/cli/pack-smoke.mjs';

function snapshotOptionalFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const mtimeMs = fstatSync(fd).mtimeMs;
    const content = readFileSync(fd, 'utf8');
    return { exists: true, mtimeMs, content };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { exists: false, mtimeMs: 0, content: '' };
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeStubAgy(
  binDir,
  version,
  { touchHomeMarker = false, failValidate = false, recordValidateFile = '' } = {}
) {
  mkdirSync(binDir, { recursive: true });
  const scriptBody = `#!/usr/bin/env node
'use strict';
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const home = process.env.USERPROFILE || process.env.HOME || '';
if (${JSON.stringify(touchHomeMarker)} && home) {
  try {
    writeFileSync(join(home, 'agy-probe-touched.txt'), args.join(' '), 'utf8');
  } catch {}
}
if (args.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'validate') {
  if (${JSON.stringify(recordValidateFile)}) {
    appendFileSync(${JSON.stringify(recordValidateFile)}, JSON.stringify({ args, home }) + '\\n', 'utf8');
  }
  if (${JSON.stringify(failValidate)}) {
    process.stderr.write('Validation failed: synthetic error\\n');
    process.exit(1);
  }
  process.stdout.write('Validation passed\\n');
  process.exit(0);
}
process.exit(0);
`;

  if (process.platform === 'win32') {
    const implPath = join(binDir, 'agy-stub-impl.cjs');
    const cmdPath = join(binDir, 'agy.cmd');
    writeFileSync(implPath, scriptBody, 'utf8');
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0agy-stub-impl.cjs" %*\r\n`, 'utf8');
    return cmdPath;
  }

  const binPath = join(binDir, 'agy');
  writeFileSync(binPath, scriptBody, 'utf8');
  chmodSync(binPath, 0o755);
  return binPath;
}

function stripAgyFromPath(rawPath = '') {
  const delim = process.platform === 'win32' ? ';' : ':';
  const candidates = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
  return String(rawPath)
    .split(delim)
    .filter((dir) => {
      const clean = dir.trim().replace(/^"+|"+$/g, '');
      if (!clean) return false;
      return !candidates.some((name) => existsSync(join(clean, name)));
    })
    .join(delim);
}

describe('Task 5: agy-bin, build-plugin, and pack-smoke', () => {
  it('re-exports buildPluginProject and runPackSmoke from lib/scaffolder.mjs', () => {
    assert.equal(typeof scaffolder.buildPluginProject, 'function');
    assert.equal(typeof scaffolder.runPackSmoke, 'function');
    assert.equal(scaffolder.buildPluginProject, buildPluginProject);
    assert.equal(scaffolder.runPackSmoke, runPackSmoke);
  });

  it('resolveAgyExecutable picks higher semver, isolates --version probe HOME/USERPROFILE, and returns nulls when absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-bin-test-'));
    try {
      const fakeHome = join(tmp, 'fake-home');
      const geminiBinDir = join(fakeHome, '.gemini', 'bin');
      const pathBinDir = join(tmp, 'path-bin');
      mkdirSync(fakeHome, { recursive: true });

      const geminiStub = writeStubAgy(geminiBinDir, '1.5.14', { touchHomeMarker: true });
      const pathStub = writeStubAgy(pathBinDir, '1.5.10', { touchHomeMarker: true });

      const resolved = resolveAgyExecutable({
        env: {
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          PATH: pathBinDir,
        },
      });

      assert.equal(resolved.path, geminiStub);
      assert.deepEqual(resolved.semver, [1, 5, 14]);
      assert.equal(
        existsSync(join(fakeHome, 'agy-probe-touched.txt')),
        false,
        '--version probe must use an isolated temp HOME/USERPROFILE, not caller HOME'
      );
      assert.equal(
        existsSync(join(homedir(), 'agy-probe-touched.txt')),
        false,
        '--version probe must never write to real homedir()'
      );

      // When PATH has a newer semver than ~/.gemini/bin/agy, picks PATH
      const newerPathDir = join(tmp, 'newer-path-bin');
      const newerPathStub = writeStubAgy(newerPathDir, '1.6.2', { touchHomeMarker: true });
      const resolvedNewerPath = resolveAgyExecutable({
        env: {
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          PATH: newerPathDir,
        },
      });
      assert.equal(resolvedNewerPath.path, newerPathStub);
      assert.deepEqual(resolvedNewerPath.semver, [1, 6, 2]);

      // Explicit path override
      const explicitRes = resolveAgyExecutable({
        env: { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' },
        explicitPath: pathStub,
      });
      assert.equal(explicitRes.path, pathStub);
      assert.deepEqual(explicitRes.semver, [1, 5, 10]);

      // Extensionless POSIX shebang script executes via process.execPath even when PATH is empty
      const posixHome = join(tmp, 'posix-home');
      const posixBinDir = join(posixHome, '.gemini', 'bin');
      mkdirSync(posixBinDir, { recursive: true });
      const posixBin = join(posixBinDir, 'agy');
      writeFileSync(
        posixBin,
        "#!/usr/bin/env node\n'use strict';\nif (process.argv.includes('--version')) process.stdout.write('1.5.19\\n');\n",
        'utf8'
      );
      chmodSync(posixBin, 0o755);
      const posixResolved = resolveAgyExecutable({
        env: { HOME: posixHome, PATH: '' },
        platform: 'linux',
      });
      assert.equal(posixResolved.path, posixBin);
      assert.deepEqual(posixResolved.semver, [1, 5, 19]);

      // Absent everywhere returns { path: null, semver: null }
      const emptyHome = join(tmp, 'empty-home');
      const emptyPath = join(tmp, 'empty-path');
      mkdirSync(emptyHome, { recursive: true });
      mkdirSync(emptyPath, { recursive: true });
      const absent = resolveAgyExecutable({
        env: {
          HOME: emptyHome,
          USERPROFILE: emptyHome,
          PATH: emptyPath,
        },
      });
      assert.deepEqual(absent, { path: null, semver: null });
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('buildPluginProject builds plugin & plugin-sidecar bundles, stamps version, gates agy validate on >= 1.5.13, and writes valid .tgz + .sha256', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-build-plug-'));
    try {
      // 1. Pure skills plugin (bundleKit: false) with bumped version 2.4.0
      const pureDir = join(tmp, 'agy-pure-plug');
      scaffolder.scaffoldProject({
        name: 'pure-plug',
        archetype: 'plugin',
        targetDir: pureDir,
        components: ['skills', 'mcp'],
      });
      const purePkgPath = join(pureDir, 'package.json');
      const purePkg = JSON.parse(readFileSync(purePkgPath, 'utf8'));
      purePkg.version = '2.4.0';
      writeJsonNoBom(purePkgPath, purePkg);

      // With agy 1.5.10 (< 1.5.13), agyValidate skips validation (agyValidated: false)
      const oldAgyHome = join(tmp, 'old-agy-home');
      const pathWithoutAgy = stripAgyFromPath(process.env.PATH || process.env.Path || '');
      writeStubAgy(join(oldAgyHome, '.gemini', 'bin'), '1.5.10', { failValidate: true });

      const pureBuilt = buildPluginProject({
        repoRoot: pureDir,
        tar: true,
        agyValidate: true,
        kitRoot: KIT_ROOT,
        env: { HOME: oldAgyHome, USERPROFILE: oldAgyHome, PATH: pathWithoutAgy },
      });
      assert.equal(pureBuilt.pluginName, 'agy-pure-plug');
      assert.equal(pureBuilt.version, '2.4.0');
      assert.equal(pureBuilt.bundledKit, false);
      assert.equal(pureBuilt.agyValidated, false);
      assert.equal(existsSync(join(pureBuilt.dir, 'node_modules')), false);

      const stampedPureManifest = JSON.parse(readFileSync(join(pureBuilt.dir, 'plugin.json'), 'utf8'));
      assert.equal(stampedPureManifest.version, '2.4.0');
      assert.ok(pureBuilt.tarball && existsSync(pureBuilt.tarball));
      assert.equal(basename(pureBuilt.tarball), 'agy-pure-plug-plugin-2.4.0.tgz');

      const actualSha = createHash('sha256').update(readFileSync(pureBuilt.tarball)).digest('hex');
      assert.equal(pureBuilt.sha256, actualSha);
      assert.equal(
        readFileSync(`${pureBuilt.tarball}.sha256`, 'utf8'),
        `${actualSha}  agy-pure-plug-plugin-2.4.0.tgz\n`
      );

      // 2. plugin-sidecar project (bundleKit: true, copies lib & LICENSE, runs agy >= 1.5.13 validate)
      const scPlugDir = join(tmp, 'agy-radar');
      scaffolder.scaffoldProject({
        name: 'radar',
        archetype: 'plugin-sidecar',
        targetDir: scPlugDir,
      });
      const scPkgPath = join(scPlugDir, 'package.json');
      const scPkg = JSON.parse(readFileSync(scPkgPath, 'utf8'));
      scPkg.version = '1.3.5';
      writeJsonNoBom(scPkgPath, scPkg);

      const validateLog = join(tmp, 'validate-calls.jsonl');
      const newAgyHome = join(tmp, 'new-agy-home');
      writeStubAgy(join(newAgyHome, '.gemini', 'bin'), '1.5.14', {
        recordValidateFile: validateLog,
      });

      const scBuilt = buildPluginProject({
        repoRoot: scPlugDir,
        tar: true,
        agyValidate: true,
        kitRoot: KIT_ROOT,
        env: {
          ...process.env,
          HOME: newAgyHome,
          USERPROFILE: newAgyHome,
          PATH: pathWithoutAgy,
        },
      });

      assert.equal(scBuilt.pluginName, 'agy-radar');
      assert.equal(scBuilt.version, '1.3.5');
      assert.equal(scBuilt.bundledKit, true);
      assert.equal(scBuilt.agyValidated, true);
      assert.equal(
        existsSync(join(scBuilt.dir, 'node_modules', 'antigravity-sidecar-kit', 'package.json')),
        true
      );
      assert.equal(existsSync(join(scBuilt.dir, 'lib', 'shared.mjs')), true);
      assert.equal(existsSync(join(scBuilt.dir, 'LICENSE')), true);

      const loggedCall = JSON.parse(readFileSync(validateLog, 'utf8').trim());
      assert.deepEqual(loggedCall.args.slice(0, 3), ['plugin', 'validate', '--strict']);
      assert.equal(loggedCall.args[3], scBuilt.dir);
      assert.notEqual(loggedCall.home, newAgyHome, 'agy validate must also run in isolated temp HOME');

      // Extract tarball in a clean dir using relative path and verify structure
      const extractDir = join(tmp, 'extract-radar');
      mkdirSync(extractDir, { recursive: true });
      const tarBase = basename(scBuilt.tarball);
      const copyTarget = join(extractDir, tarBase);
      writeFileSync(copyTarget, readFileSync(scBuilt.tarball));
      const untar = spawnSync('tar', ['-xzf', tarBase], { cwd: extractDir, encoding: 'utf8' });
      assert.equal(untar.status, 0, untar.stderr);
      assert.equal(
        JSON.parse(readFileSync(join(extractDir, 'agy-radar', 'plugin.json'), 'utf8')).version,
        '1.3.5'
      );
      assert.equal(
        existsSync(
          join(extractDir, 'agy-radar', 'node_modules', 'antigravity-sidecar-kit', 'package.json')
        ),
        true
      );

      // 3. When agy >= 1.5.13 exits non-zero on plugin validate --strict, buildPluginProject throws
      const failingAgyHome = join(tmp, 'failing-agy-home');
      writeStubAgy(join(failingAgyHome, '.gemini', 'bin'), '1.5.14', { failValidate: true });
      assert.throws(
        () =>
          buildPluginProject({
            repoRoot: pureDir,
            tar: false,
            agyValidate: true,
            env: { HOME: failingAgyHome, USERPROFILE: failingAgyHome, PATH: pathWithoutAgy },
          }),
        /validate|Validation failed/i
      );
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('buildPluginProject rejects copy paths and symlinks/junctions escaping repoRoot', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-build-sec-'));
    try {
      const outsideDir = join(tmp, 'outside-secret');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');

      const repoDir = join(tmp, 'agy-sec-plug');
      scaffolder.scaffoldProject({
        name: 'sec-plug',
        archetype: 'plugin',
        targetDir: repoDir,
        components: ['skills'],
      });

      // 1. Rejects agyPlugin.copy: ["../outside"] and ["../outside-secret"]
      const pkgPath = join(repoDir, 'package.json');
      const basePkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, copy: ['../outside'] },
      });
      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /escapes|outside/i
      );

      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, copy: ['../outside-secret'] },
      });
      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /escapes|outside/i
      );

      // 2. Rejects agyPlugin.pluginDir escaping repoRoot
      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, pluginDir: '../outside-secret', copy: ['LICENSE'] },
      });
      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /escapes|outside/i
      );

      // Restore valid package.json
      writeJsonNoBom(pkgPath, basePkg);

      // 3. Rejects symlink/junction inside plugin/ pointing outside repoRoot
      const escapeLink = join(repoDir, 'plugin', 'linked-outside');
      symlinkSync(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /symlink|outside/i
      );
      removeLinkOrDir(escapeLink);

      // 4. Rejects symlink/junction inside a copy[] directory pointing outside repoRoot
      const libDir = join(repoDir, 'lib');
      mkdirSync(libDir, { recursive: true });
      symlinkSync(
        outsideDir,
        join(libDir, 'escaped-sub'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, copy: ['lib', 'LICENSE'] },
      });
      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /symlink|outside/i
      );
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('runPackSmoke verifies sidecar-mcp offline npm pack/install/bins/setup without touching real ~/.gemini/config and fails when files includes test', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-pack-smoke-sc-'));
    const realConfigBefore = snapshotOptionalFile(CONFIG_JSON_PATH);
    const realMcpBefore = snapshotOptionalFile(DEFAULT_MCP_CONFIG_PATH);

    try {
      const sidecarDir = join(tmp, 'antigravity-packcheck');
      scaffolder.scaffoldProject({
        name: 'packcheck',
        archetype: 'sidecar-mcp',
        targetDir: sidecarDir,
      });

      const offlineEnv = {
        ...process.env,
        npm_config_registry: 'http://127.0.0.1:1',
        npm_config_fetch_retries: '0',
      };

      const res = await runPackSmoke({
        repoRoot: sidecarDir,
        kitRoot: KIT_ROOT,
        env: offlineEnv,
      });

      assert.equal(typeof res.npmTarball, 'string');
      assert.match(res.npmTarball, /antigravity-packcheck-1\.0\.0\.tgz$/);
      assert.equal(res.pluginTarball, null);

      // Verify real ~/.gemini/config files and sidecar junctions were never touched
      assert.deepEqual(snapshotOptionalFile(CONFIG_JSON_PATH), realConfigBefore);
      assert.deepEqual(snapshotOptionalFile(DEFAULT_MCP_CONFIG_PATH), realMcpBefore);
      assert.equal(existsSync(join(GLOBAL_SIDECARS_DIR, 'packcheck')), false);

      // Fails when package.json "files" accidentally includes "test"
      const pkgPath = join(sidecarDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const validFiles = [...pkg.files];
      pkg.files = [...validFiles, 'test'];
      writeJsonNoBom(pkgPath, pkg);

      await assert.rejects(
        () =>
          runPackSmoke({
            repoRoot: sidecarDir,
            kitRoot: KIT_ROOT,
            env: offlineEnv,
          }),
        /test/i
      );

      // Fails when a declared bin shim target is missing from the packed files
      pkg.files = validFiles;
      pkg.bin = {
        ...pkg.bin,
        'agy-packcheck-missing': './nonexistent-bin.mjs',
      };
      writeJsonNoBom(pkgPath, pkg);

      await assert.rejects(
        () =>
          runPackSmoke({
            repoRoot: sidecarDir,
            kitRoot: KIT_ROOT,
            env: offlineEnv,
          }),
        /agy-packcheck-missing|bin|ENOENT/i
      );
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('runPackSmoke verifies plugin-sidecar tarball extraction, sha256, bundled kit, and strict lint', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-pack-smoke-plug-'));
    try {
      const plugDir = join(tmp, 'agy-smoke-beacon');
      scaffolder.scaffoldProject({
        name: 'smoke-beacon',
        archetype: 'plugin-sidecar',
        targetDir: plugDir,
      });

      // Isolate agy lookup to an empty home/path so test does not depend on host agy installation
      const emptyHome = join(tmp, 'empty-home');
      const pathWithoutAgy = stripAgyFromPath(process.env.PATH || process.env.Path || '');
      mkdirSync(emptyHome, { recursive: true });
      const res = await runPackSmoke({
        repoRoot: plugDir,
        kitRoot: KIT_ROOT,
        env: {
          ...process.env,
          HOME: emptyHome,
          USERPROFILE: emptyHome,
          PATH: pathWithoutAgy,
          npm_config_registry: 'http://127.0.0.1:1',
        },
      });

      assert.equal(res.npmTarball, null);
      assert.equal(typeof res.pluginTarball, 'string');
      assert.match(res.pluginTarball, /agy-smoke-beacon-plugin-1\.0\.0\.tgz$/);
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Findings 1 & 3): npm pack ignores prepack/postpack scripts, parses bracketed stdout prefixes, and ignores yarn/pnpm npm_execpath', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-pack-reg13-'));
    const prevNpmExecPath = process.env.npm_execpath;
    try {
      // Finding 1a: parseNpmPackJson skips leading bracketed log text while preserving nested files[] array
      const noisyStdout = [
        '[build] compiling assets [1/2]',
        '[warn] notice [ok]',
        JSON.stringify(
          [
            {
              id: 'antigravity-demo@1.0.0',
              files: [{ path: 'package.json' }, { path: 'server.mjs' }],
              filename: 'antigravity-demo-1.0.0.tgz',
            },
          ],
          null,
          2
        ),
      ].join('\n');
      const parsed = parseNpmPackJson(noisyStdout, '/repo');
      assert.equal(parsed[0].filename, 'antigravity-demo-1.0.0.tgz');
      assert.throws(() => parseNpmPackJson('[not-json', '/repo'), /Unexpected npm pack/);

      // Finding 3: resolveNpmCommand rejects yarn.js / pnpm.mjs and honors explicit env.npm_execpath = ''
      const yarnScript = join(tmp, 'yarn.js');
      const pnpmScript = join(tmp, 'pnpm.mjs');
      const validNpmCli = join(tmp, 'npm-cli.js');
      writeFileSync(yarnScript, 'process.exit(99);\n', 'utf8');
      writeFileSync(pnpmScript, 'process.exit(98);\n', 'utf8');
      writeFileSync(validNpmCli, '// stub npm-cli.js\n', 'utf8');

      const yarnResolved = resolveNpmCommand({ ...process.env, npm_execpath: yarnScript });
      assert.notEqual(yarnResolved.script, yarnScript);

      const pnpmResolved = resolveNpmCommand({ ...process.env, npm_execpath: pnpmScript });
      assert.notEqual(pnpmResolved.script, pnpmScript);

      const npmCliResolved = resolveNpmCommand({ ...process.env, npm_execpath: validNpmCli });
      assert.equal(npmCliResolved.type, 'node-script');
      assert.equal(npmCliResolved.script, validNpmCli);

      process.env.npm_execpath = validNpmCli;
      const clearedResolved = resolveNpmCommand({ PATH: '', Path: '', npm_execpath: '' });
      assert.notEqual(clearedResolved.script, validNpmCli);
      if (prevNpmExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = prevNpmExecPath;

      // End-to-end Finding 1b & Finding 3: prepack/postpack poison scripts + yarn.js npm_execpath
      const sidecarDir = join(tmp, 'antigravity-hookguard');
      scaffolder.scaffoldProject({
        name: 'hookguard',
        archetype: 'sidecar-ui',
        targetDir: sidecarDir,
      });
      const pkgPath = join(sidecarDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.scripts = {
        ...pkg.scripts,
        prepack: 'node -e "process.exit(42)"',
        postpack: 'node -e "process.exit(44)"',
      };
      writeJsonNoBom(pkgPath, pkg);

      const res = await runPackSmoke({
        repoRoot: sidecarDir,
        kitRoot: KIT_ROOT,
        env: {
          ...process.env,
          npm_execpath: yarnScript,
          npm_config_registry: 'http://127.0.0.1:1',
          npm_config_fetch_retries: '0',
        },
      });
      assert.match(res.npmTarball, /antigravity-hookguard-1\.0\.0\.tgz$/);
    } finally {
      if (prevNpmExecPath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = prevNpmExecPath;
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Finding 2): buildPluginProject rejects overlapping builtDir/srcPluginDir/repoRoot before deleting source files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-build-reg2-'));
    try {
      const repoDir = join(tmp, 'agy-overlap');
      scaffolder.scaffoldProject({
        name: 'overlap',
        archetype: 'plugin',
        targetDir: repoDir,
        components: ['skills'],
      });

      // Move plugin/ to dist/agy-overlap and configure outDir: "dist" so builtDir === srcPluginDir
      const nestedSrc = join(repoDir, 'dist', 'agy-overlap');
      mkdirSync(join(repoDir, 'dist'), { recursive: true });
      cpSync(join(repoDir, 'plugin'), nestedSrc, { recursive: true });

      const pkgPath = join(repoDir, 'package.json');
      const basePkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: {
          ...basePkg.agyPlugin,
          pluginDir: 'dist/agy-overlap',
          outDir: 'dist',
        },
      });

      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /overlap/i
      );
      assert.equal(
        existsSync(join(nestedSrc, 'plugin.json')),
        true,
        'srcPluginDir must not be deleted when builtDir overlaps srcPluginDir'
      );

      // Restore standard pluginDir and verify outRoot: dirname(repoDir) (where builtDir === repoDir) is rejected
      writeJsonNoBom(pkgPath, basePkg);
      assert.throws(
        () =>
          buildPluginProject({
            repoRoot: repoDir,
            outRoot: dirname(repoDir),
            tar: false,
            agyValidate: false,
          }),
        /repository root|overlap/i
      );
      assert.equal(existsSync(pkgPath), true, 'repoDir must not be deleted when builtDir === repoDir');

      // Regression (I5): in-repo junction/symlink pointing inside plugin/ when builtDir does not yet exist
      const insidePluginSub = join(repoDir, 'plugin', 'skills');
      const junctionOut = join(repoDir, 'out-link');
      symlinkSync(
        insidePluginSub,
        junctionOut,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const wouldCreateInPlugin = join(insidePluginSub, 'agy-overlap');
      assert.equal(existsSync(wouldCreateInPlugin), false, 'precondition: builtDir does not yet exist');

      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, outDir: 'out-link' },
      });
      assert.throws(
        () => buildPluginProject({ repoRoot: repoDir, tar: false, agyValidate: false }),
        /overlap/i
      );
      assert.equal(
        existsSync(wouldCreateInPlugin),
        false,
        'buildPluginProject must reject before creating directories inside plugin/'
      );
      removeLinkOrDir(junctionOut);

      // Also verify copySafeWithinRepo skips an in-repo symlink/junction inside copy[] that resolves to realOutRoot
      writeJsonNoBom(pkgPath, {
        ...basePkg,
        agyPlugin: { ...basePkg.agyPlugin, copy: ['lib', 'LICENSE'] },
      });
      mkdirSync(join(repoDir, 'dist', 'plugin'), { recursive: true });
      mkdirSync(join(repoDir, 'lib'), { recursive: true });
      writeFileSync(join(repoDir, 'lib', 'helper.mjs'), 'export const ok = 1;\n', 'utf8');
      symlinkSync(
        join(repoDir, 'dist', 'plugin'),
        join(repoDir, 'lib', 'loop-to-out'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const cleanBuilt = buildPluginProject({
        repoRoot: repoDir,
        tar: false,
        agyValidate: false,
      });
      assert.equal(existsSync(join(cleanBuilt.dir, 'lib', 'helper.mjs')), true);
      assert.equal(existsSync(join(cleanBuilt.dir, 'lib', 'loop-to-out')), false);
    } finally {
      removeLinkOrDir(tmp);
    }
  });

  it('regression (Finding 4): literal % paths, unexpanded %TEMP%, and trailing backslashes survive .cmd execution', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agy-pct-reg4-'));
    try {
      const pctWorkspace = join(tmp, 'feat%2Fbranch');
      const repoDir = join(pctWorkspace, 'agy-pct-plug');
      scaffolder.scaffoldProject({
        name: 'pct-plug',
        archetype: 'plugin',
        targetDir: repoDir,
        components: ['skills'],
      });

      const validateLog = join(tmp, 'pct-validate.jsonl');
      const agyHome = join(pctWorkspace, 'agy-home');
      writeStubAgy(join(agyHome, '.gemini', 'bin'), '1.5.14', {
        recordValidateFile: validateLog,
      });
      const pathWithoutAgy = stripAgyFromPath(process.env.PATH || process.env.Path || '');

      const built = buildPluginProject({
        repoRoot: repoDir,
        tar: false,
        agyValidate: true,
        env: {
          ...process.env,
          HOME: agyHome,
          USERPROFILE: agyHome,
          PATH: pathWithoutAgy,
        },
      });

      assert.equal(built.agyValidated, true);
      assert.ok(built.dir.includes('feat%2Fbranch'));
      const logged = JSON.parse(readFileSync(validateLog, 'utf8').trim());
      assert.equal(logged.args[3], built.dir, 'literal %2F in builtDir must not become %%2F');

      if (process.platform === 'win32') {
        const echoImpl = join(pctWorkspace, 'echo-args.mjs');
        const echoCmd = join(pctWorkspace, 'echo-args.cmd');
        writeFileSync(
          echoImpl,
          'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
          'utf8'
        );
        writeFileSync(
          echoCmd,
          `@echo off\r\n"${process.execPath}" "%~dp0echo-args.mjs" %*\r\n`,
          'utf8'
        );
        const trickyArgs = [
          'C:\\workspace\\feat%2Fbranch\\dist\\plugin\\agy-foo',
          'literal-%TEMP%-token',
          'C:\\dir with spaces\\trailing\\',
          '',
          'amp&pipe|caret^paren(1)',
        ];
        const run = spawnResolvedExecutable(
          echoCmd,
          trickyArgs,
          { encoding: 'utf8', env: process.env, windowsHide: true },
          'win32'
        );
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout), trickyArgs);
      }
    } finally {
      removeLinkOrDir(tmp);
    }
  });
});
