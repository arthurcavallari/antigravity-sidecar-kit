/**
 * @fileoverview Offline-capable packaging smoke verification for Antigravity standalone sidecars
 * (`npm pack` + isolated `setup.mjs` lifecycle) and native plugins (`buildPluginProject` + tarball extraction & lint).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../config.mjs';
import { lintPluginOrSidecar } from '../manifest-validator.mjs';
import { KIT_ROOT, removeLinkOrDir } from '../setup.mjs';
import { extractEnvPath, normalizeChildEnv, spawnResolvedExecutable } from './agy-bin.mjs';
import { buildPluginProject } from './build-plugin.mjs';

const FORBIDDEN_PUBLISHED_DIRS = Object.freeze(['test', '.github', 'docs', 'dist']);

export function resolveNpmCommand(env = process.env, platform = process.platform) {
  const hasExplicitKey = Boolean(env && typeof env === 'object' && Object.hasOwn(env, 'npm_execpath'));
  const rawNpmExecPath = hasExplicitKey
    ? env.npm_execpath
    : env?.npm_execpath !== undefined
      ? env.npm_execpath
      : process.env.npm_execpath;
  const npmExecPath = typeof rawNpmExecPath === 'string' ? rawNpmExecPath.trim() : '';
  if (
    npmExecPath &&
    /^npm(?:-cli)?\.m?js$/i.test(basename(npmExecPath)) &&
    existsSync(npmExecPath)
  ) {
    return { type: 'node-script', script: resolve(npmExecPath) };
  }

  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { type: 'node-script', script: candidate };
    }
  }

  if (platform === 'win32') {
    const rawPath = extractEnvPath(env);
    for (const entry of rawPath.split(';')) {
      let clean = entry.trim();
      let start = 0;
      let end = clean.length;
      while (start < end && clean.charCodeAt(start) === 34) start++;
      while (end > start && clean.charCodeAt(end - 1) === 34) end--;
      clean = clean.slice(start, end);
      if (!clean) continue;
      const npmCmd = join(clean, 'npm.cmd');
      if (existsSync(npmCmd)) {
        return { type: 'resolved-exec', execPath: npmCmd };
      }
    }
  }

  return { type: 'bare', command: 'npm' };
}

function runNpm(args, { cwd, env = process.env, platform = process.platform } = {}) {
  const explicitNpmExecOverride =
    env && typeof env === 'object' && Object.hasOwn(env, 'npm_execpath')
      ? { npm_execpath: String(env.npm_execpath ?? '') }
      : {};
  const childEnv = normalizeChildEnv(env, explicitNpmExecOverride, platform);
  const runner = resolveNpmCommand(childEnv, platform);
  const opts = {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  };

  let res;
  if (runner.type === 'node-script') {
    res = spawnSync(process.execPath, [runner.script, ...args], opts);
  } else if (runner.type === 'resolved-exec') {
    res = spawnResolvedExecutable(runner.execPath, args, opts, platform);
  } else {
    res = spawnSync(runner.command, args, opts);
  }

  if (res.error || res.status !== 0) {
    const output = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
    throw new Error(`npm ${args[0]} failed: ${res.error?.message || output || `exit ${res.status}`}`);
  }
  return res.stdout;
}

export function parseNpmPackJson(stdout, sourceDir = '') {
  const text = String(stdout ?? '').trim();
  const closeIdx = text.lastIndexOf(']');
  if (closeIdx !== -1) {
    for (
      let openIdx = text.indexOf('[');
      openIdx !== -1 && openIdx < closeIdx;
      openIdx = text.indexOf('[', openIdx + 1)
    ) {
      try {
        const candidate = JSON.parse(text.slice(openIdx, closeIdx + 1));
        if (
          Array.isArray(candidate) &&
          candidate.length > 0 &&
          candidate[0] &&
          typeof candidate[0] === 'object' &&
          typeof candidate[0].filename === 'string' &&
          candidate[0].filename.trim()
        ) {
          return candidate;
        }
      } catch {
        // Skip non-JSON '[' in leading log lines (e.g. "[build] done").
      }
    }
  }
  throw new Error(
    `Unexpected npm pack --json output${sourceDir ? ` for ${sourceDir}` : ''}: ${text}`
  );
}

function packNpmArchive(sourceDir, destDir, env) {
  mkdirSync(destDir, { recursive: true });
  const stdout = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', destDir], {
    cwd: sourceDir,
    env,
  });
  const parsed = parseNpmPackJson(stdout, sourceDir);
  const filename = parsed[0].filename;
  let tgzPath = join(destDir, filename);
  if (!existsSync(tgzPath)) {
    const fallbackPath = join(destDir, filename.replace(/^@/, '').replace(/\//, '-'));
    if (existsSync(fallbackPath)) tgzPath = fallbackPath;
  }
  if (!existsSync(tgzPath)) {
    throw new Error(`Packed tarball missing on disk: ${tgzPath}`);
  }
  return tgzPath;
}

function deriveSidecarId(installedDir, pkgName) {
  const hub = readJsonSafe(join(installedDir, 'hub-manifest.json'), null);
  if (hub && typeof hub === 'object' && typeof hub.id === 'string' && hub.id.trim()) {
    return hub.id.trim();
  }
  const unscoped = String(pkgName || 'sidecar').replace(/^@[^/]+\//, '');
  return unscoped.replace(/^antigravity-sidecar-|^antigravity-|^agy-/i, '').trim() || 'sidecar';
}

function pathExistsOrDanglingLink(targetPath) {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies npm packaging (`pkg.private !== true`) and/or native plugin packaging (`plugin/plugin.json` or `pkg.agyPlugin`)
 * inside an isolated temporary workspace without touching the user's real `~/.gemini/config` or hitting the npm registry.
 *
 * @param {{
 *   repoRoot?: string,
 *   kitRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Promise<{ npmTarball: string | null, pluginTarball: string | null }>}
 */
export async function runPackSmoke({
  repoRoot = process.cwd(),
  kitRoot = KIT_ROOT,
  env = process.env,
} = {}) {
  const resolvedRepo = resolve(repoRoot);
  const pkgPath = join(resolvedRepo, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`Missing package.json in ${resolvedRepo}`);
  }
  const pkg = readJsonSafe(pkgPath, null, { strict: true });
  if (!pkg || typeof pkg.name !== 'string' || !pkg.name.trim()) {
    throw new Error(`Invalid package.json "name" in ${pkgPath}`);
  }

  const repoInstalledKit = join(resolvedRepo, 'node_modules', 'antigravity-sidecar-kit');
  const effectiveKitRoot =
    kitRoot && resolve(kitRoot) !== resolve(KIT_ROOT)
      ? resolve(kitRoot)
      : existsSync(join(repoInstalledKit, 'package.json'))
        ? repoInstalledKit
        : kitRoot;

  const hasPlugin =
    Boolean(pkg.agyPlugin) || existsSync(join(resolvedRepo, 'plugin', 'plugin.json'));

  if (pkg.private === true && !hasPlugin) {
    throw new Error(
      `Nothing to pack-smoke in ${resolvedRepo}: package.json has "private": true and no plugin manifest.`
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'agy-pack-smoke-'));
  let npmTarball = null;
  let pluginTarball = null;

  try {
    if (pkg.private !== true) {
      const fakeHome = join(work, 'fake-home');
      mkdirSync(fakeHome, { recursive: true });
      const isolatedNpmEnv = normalizeChildEnv(env, {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        APPDATA: join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
        XDG_CONFIG_HOME: join(fakeHome, '.config'),
        HANGAR_DATA_DIR: join(fakeHome, '.gemini', 'hangar'),
        SIDECAR_HUB_DATA_DIR: '',
        ANTIGRAVITY_APP_DATA_DIR: join(fakeHome, '.gemini', 'antigravity'),
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
        ANTIGRAVITY_LS_ADDRESS: '',
        ANTIGRAVITY_CSRF_TOKEN: '',
        ...(env && typeof env === 'object' && Object.hasOwn(env, 'npm_execpath')
          ? { npm_execpath: String(env.npm_execpath ?? '') }
          : {}),
      });

      const isKitSelf =
        pkg.name === 'antigravity-sidecar-kit' ||
        resolve(resolvedRepo) === resolve(effectiveKitRoot);

      const needsKitOverride =
        !isKitSelf &&
        Boolean(
          pkg.dependencies?.['antigravity-sidecar-kit'] ||
            pkg.optionalDependencies?.['antigravity-sidecar-kit'] ||
            pkg.peerDependencies?.['antigravity-sidecar-kit']
        );

      let kitTgz = null;
      if (needsKitOverride && effectiveKitRoot && existsSync(join(effectiveKitRoot, 'package.json'))) {
        kitTgz = packNpmArchive(effectiveKitRoot, join(work, 'kit-pack'), isolatedNpmEnv);
      }

      npmTarball = packNpmArchive(resolvedRepo, join(work, 'repo-pack'), isolatedNpmEnv);

      const appDir = join(work, 'app');
      mkdirSync(appDir, { recursive: true });
      writeJsonNoBom(join(appDir, 'package.json'), {
        name: 'agy-pack-smoke-consumer',
        private: true,
        type: 'module',
        ...(kitTgz
          ? {
              overrides: {
                'antigravity-sidecar-kit': `file:../kit-pack/${basename(kitTgz)}`,
              },
            }
          : {}),
      });

      const relRepoTarball = `../repo-pack/${basename(npmTarball)}`;
      runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', relRepoTarball], {
        cwd: appDir,
        env: isolatedNpmEnv,
      });

      const installedDir = join(appDir, 'node_modules', ...pkg.name.split('/'));
      if (!existsSync(join(installedDir, 'package.json'))) {
        throw new Error(`Installed package not found at ${installedDir}`);
      }

      for (const forbidden of FORBIDDEN_PUBLISHED_DIRS) {
        if (existsSync(join(installedDir, forbidden))) {
          throw new Error(
            `Published npm tarball for "${pkg.name}" must not contain "${forbidden}/" (check package.json "files").`
          );
        }
      }

      const binNames =
        typeof pkg.bin === 'string' && pkg.bin.trim()
          ? [pkg.name.split('/').pop()]
          : pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)
            ? Object.keys(pkg.bin)
            : [];

      for (const binName of binNames) {
        const shimPath = join(
          appDir,
          'node_modules',
          '.bin',
          process.platform === 'win32' ? `${binName}.cmd` : binName
        );
        if (!existsSync(shimPath)) {
          throw new Error(`Missing .bin shim "${binName}" at ${shimPath}`);
        }
      }

      const setupScript = join(installedDir, 'setup.mjs');
      if (existsSync(setupScript)) {
        const installRun = spawnSync(process.execPath, ['setup.mjs', '--skip-tests'], {
          cwd: installedDir,
          env: isolatedNpmEnv,
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
        });
        if (installRun.error || installRun.status !== 0) {
          const out = `${installRun.stderr ?? ''}\n${installRun.stdout ?? ''}`.trim();
          throw new Error(
            `setup.mjs --skip-tests failed: ${installRun.error?.message || out || `exit ${installRun.status}`}`
          );
        }

        const sidecarId = deriveSidecarId(installedDir, pkg.name);
        const sidecarLink = join(fakeHome, '.gemini', 'config', 'sidecars', sidecarId);
        if (!existsSync(sidecarLink)) {
          throw new Error(
            `setup.mjs --skip-tests did not create expected sidecar link at ${sidecarLink}`
          );
        }

        const uninstallRun = spawnSync(process.execPath, ['setup.mjs', '--uninstall'], {
          cwd: installedDir,
          env: isolatedNpmEnv,
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
        });
        if (uninstallRun.error || uninstallRun.status !== 0) {
          const out = `${uninstallRun.stderr ?? ''}\n${uninstallRun.stdout ?? ''}`.trim();
          throw new Error(
            `setup.mjs --uninstall failed: ${uninstallRun.error?.message || out || `exit ${uninstallRun.status}`}`
          );
        }

        if (existsSync(sidecarLink) || pathExistsOrDanglingLink(sidecarLink)) {
          throw new Error(`setup.mjs --uninstall did not remove sidecar link at ${sidecarLink}`);
        }
      }
    }

    if (hasPlugin) {
      const pluginOutDir = join(work, 'plugin-out');
      const built = buildPluginProject({
        repoRoot: resolvedRepo,
        outRoot: pluginOutDir,
        tar: true,
        kitRoot: effectiveKitRoot,
        env,
      });

      if (!built.tarball || !existsSync(built.tarball)) {
        throw new Error('buildPluginProject did not produce a plugin tarball.');
      }
      pluginTarball = built.tarball;

      const shaFile = `${built.tarball}.sha256`;
      if (!existsSync(shaFile)) {
        throw new Error(`Missing plugin checksum file: ${shaFile}`);
      }

      const tarBase = basename(built.tarball);
      const actualSha = createHash('sha256').update(readFileSync(built.tarball)).digest('hex');
      const expectedShaLine = `${actualSha}  ${tarBase}\n`;
      const recordedShaLine = readFileSync(shaFile, 'utf8');
      if (actualSha !== built.sha256 || recordedShaLine !== expectedShaLine) {
        throw new Error(
          `SHA-256 mismatch for ${tarBase}: expected "${expectedShaLine.trim()}", got "${recordedShaLine.trim()}"`
        );
      }

      const extractDir = join(work, 'plugin-extract');
      mkdirSync(extractDir, { recursive: true });
      copyFileSync(built.tarball, join(extractDir, tarBase));

      const untar = spawnSync('tar', ['-xzf', tarBase], {
        cwd: extractDir,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (untar.error || untar.status !== 0) {
        const reason = untar.error?.message || (untar.stderr || untar.stdout || '').trim();
        throw new Error(`tar extraction failed for ${tarBase}: ${reason}`);
      }

      const extractedPluginDir = join(extractDir, built.pluginName);
      const extractedManifestPath = join(extractedPluginDir, 'plugin.json');
      if (!existsSync(extractedManifestPath)) {
        throw new Error(`Extracted plugin archive is missing ${extractedManifestPath}`);
      }

      const extractedManifest = readJsonSafe(extractedManifestPath, null, { strict: true });
      if (extractedManifest.version !== pkg.version) {
        throw new Error(
          `Extracted plugin.json version "${extractedManifest.version}" does not match package.json version "${pkg.version}".`
        );
      }

      if (
        built.bundledKit &&
        !existsSync(
          join(extractedPluginDir, 'node_modules', 'antigravity-sidecar-kit', 'package.json')
        )
      ) {
        throw new Error(
          `Extracted plugin "${built.pluginName}" is missing bundled node_modules/antigravity-sidecar-kit/package.json.`
        );
      }

      const lint = lintPluginOrSidecar(extractedPluginDir, { strict: true });
      if (!lint.valid) {
        const details = [...lint.errors, ...lint.warnings]
          .map((item) => `[${item.severity}] ${item.ruleId} (${item.file}): ${item.message}`)
          .join('\n  ');
        throw new Error(`Extracted plugin failed strict manifest lint:\n  ${details}`);
      }
    }

    return { npmTarball, pluginTarball };
  } finally {
    removeLinkOrDir(work);
  }
}
