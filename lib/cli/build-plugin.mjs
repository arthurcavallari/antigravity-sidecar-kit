/**
 * @fileoverview Builds self-contained Antigravity plugin bundles (`.tgz` + `.sha256`) with path/symlink
 * containment checks, optional `antigravity-sidecar-kit` bundling, strict manifest linting, and `agy >= 1.5.13` validation.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../config.mjs';
import { lintPluginOrSidecar } from '../manifest-validator.mjs';
import { bundleSidecarKit, KIT_ROOT, removeLinkOrDir } from '../setup.mjs';
import { compareSemver, resolveAgyExecutable, spawnAgyIsolated } from './agy-bin.mjs';

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_VERSION_RE = /^[a-z0-9][a-z0-9._+-]*$/i;
const MIN_AGY_VALIDATE_SEMVER = Object.freeze([1, 5, 13]);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isWithinRoot(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isStrictSubpath(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
}

function assertContainedRepoRelPath(resolvedRepo, realRepoRoot, rawRel, label) {
  if (typeof rawRel !== 'string' || !rawRel.trim() || rawRel.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path inside the repository.`);
  }
  const target = resolve(resolvedRepo, rawRel);
  if (!isStrictSubpath(resolvedRepo, target)) {
    throw new Error(`${label} "${rawRel}" escapes repository root (${resolvedRepo}).`);
  }

  const rel = relative(resolvedRepo, target);
  const parts = rel.split(sep).filter(Boolean);
  let cursor = resolvedRepo;
  for (const segment of parts) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) {
      let brokenStat = null;
      try {
        brokenStat = lstatSync(cursor);
      } catch {
        brokenStat = null;
      }
      if (brokenStat?.isSymbolicLink()) {
        throw new Error(`Refusing to follow broken symlink "${cursor}" in ${label}.`);
      }
      break;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      const realSeg = realpathSync.native(cursor);
      if (!isWithinRoot(realRepoRoot, realSeg)) {
        throw new Error(
          `Symlink "${cursor}" in ${label} points outside repository root (${realSeg}).`
        );
      }
    }
  }

  return { target, cleanRel: rel };
}

function resolveRealPathWithMissingTail(targetPath) {
  const resolvedTarget = resolve(targetPath);
  let cur = resolvedTarget;
  const missingSegments = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) {
      return resolvedTarget;
    }
    missingSegments.unshift(basename(cur));
    cur = parent;
  }
  const realBase = realpathSync.native(cur);
  return missingSegments.length > 0 ? join(realBase, ...missingSegments) : realBase;
}

function copySafeWithinRepo(
  src,
  dest,
  realRepoRoot,
  { skipDir = '', realOutRoot = '', realBuiltDir = '' } = {}
) {
  const resolvedSkip = skipDir ? resolve(skipDir) : '';

  const walk = (from, to, openDirs) => {
    if (resolvedSkip && resolve(from) === resolvedSkip) return;

    let stat = lstatSync(from);
    let resolvedReal = null;
    if (stat.isSymbolicLink()) {
      try {
        resolvedReal = realpathSync.native(from);
      } catch {
        throw new Error(`Refusing to bundle dangling or unresolvable symlink "${from}".`);
      }
      if (!isWithinRoot(realRepoRoot, resolvedReal)) {
        throw new Error(`Symlink "${from}" points outside repository root (${resolvedReal}).`);
      }
      stat = statSync(from);
      if (stat.isDirectory() && openDirs.has(resolvedReal)) {
        throw new Error(`Symlink cycle detected while bundling "${from}".`);
      }
    }

    if (stat.isDirectory()) {
      const dirReal = resolvedReal ?? realpathSync.native(from);
      if (
        (realOutRoot && dirReal === realOutRoot) ||
        (realBuiltDir && dirReal === realBuiltDir)
      ) {
        return;
      }
      mkdirSync(to, { recursive: true });
      const nextOpen = new Set(openDirs);
      nextOpen.add(dirReal);
      for (const entry of readdirSync(from)) {
        walk(join(from, entry), join(to, entry), nextOpen);
      }
      return;
    }

    if (stat.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  };

  walk(src, dest, new Set());
}

/**
 * Builds an Antigravity plugin distribution directory and optional `.tgz` + `.tgz.sha256` archive.
 *
 * @param {{
 *   repoRoot?: string,
 *   outRoot?: string,
 *   tar?: boolean,
 *   agyValidate?: boolean,
 *   kitRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {{
 *   dir: string,
 *   pluginName: string,
 *   version: string,
 *   bundledKit: boolean,
 *   tarball: string | null,
 *   sha256: string | null,
 *   agyValidated: boolean,
 * }}
 */
export function buildPluginProject({
  repoRoot = process.cwd(),
  outRoot,
  tar = true,
  agyValidate = true,
  kitRoot = KIT_ROOT,
  env = process.env,
} = {}) {
  const resolvedRepo = resolve(repoRoot);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`Repository root does not exist: ${resolvedRepo}`);
  }
  const realRepoRoot = realpathSync.native(resolvedRepo);
  const pkgPath = join(resolvedRepo, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`Missing package.json in ${resolvedRepo}`);
  }

  const pkg = readJsonSafe(pkgPath, null, { strict: true });
  const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  if (!version || !SAFE_VERSION_RE.test(version)) {
    throw new Error(`Invalid or missing "version" in ${pkgPath}: ${JSON.stringify(pkg?.version)}`);
  }

  if (pkg.agyPlugin !== undefined && !isPlainObject(pkg.agyPlugin)) {
    throw new Error('package.json "agyPlugin" must be a JSON object when present.');
  }
  const agyPlugin = pkg.agyPlugin || {};
  const rawPluginDir = agyPlugin.pluginDir !== undefined ? agyPlugin.pluginDir : 'plugin';
  const rawOutDir = agyPlugin.outDir !== undefined ? agyPlugin.outDir : 'dist/plugin';
  const rawCopy = agyPlugin.copy !== undefined ? agyPlugin.copy : ['LICENSE'];

  if (!Array.isArray(rawCopy)) {
    throw new Error('package.json "agyPlugin.copy" must be an array of relative paths.');
  }

  const { target: srcPluginDir } = assertContainedRepoRelPath(
    resolvedRepo,
    realRepoRoot,
    rawPluginDir,
    'agyPlugin.pluginDir'
  );

  const srcManifestPath = join(srcPluginDir, 'plugin.json');
  if (!existsSync(srcManifestPath)) {
    throw new Error(`Missing plugin manifest at ${srcManifestPath}`);
  }
  const srcManifest = readJsonSafe(srcManifestPath, null, { strict: true });
  const pluginName = typeof srcManifest?.name === 'string' ? srcManifest.name.trim() : '';
  if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
    throw new Error(
      `Invalid plugin.json "name" in ${srcManifestPath}: expected lowercase slug matching ${PLUGIN_NAME_RE}`
    );
  }

  const effectiveOutRoot = outRoot
    ? resolve(outRoot)
    : assertContainedRepoRelPath(resolvedRepo, realRepoRoot, rawOutDir, 'agyPlugin.outDir').target;

  const builtDir = join(effectiveOutRoot, pluginName);

  const realSrcPluginDir = realpathSync.native(srcPluginDir);
  const realOutRoot = resolveRealPathWithMissingTail(effectiveOutRoot);
  const realBuiltDir = resolveRealPathWithMissingTail(builtDir);

  if (isWithinRoot(builtDir, resolvedRepo) || isWithinRoot(realBuiltDir, realRepoRoot)) {
    throw new Error(
      `Built plugin directory "${builtDir}" cannot equal or contain repository root "${resolvedRepo}".`
    );
  }

  if (
    isWithinRoot(srcPluginDir, effectiveOutRoot) ||
    isWithinRoot(srcPluginDir, builtDir) ||
    isWithinRoot(builtDir, srcPluginDir) ||
    isWithinRoot(realSrcPluginDir, realOutRoot) ||
    isWithinRoot(realSrcPluginDir, realBuiltDir) ||
    isWithinRoot(realBuiltDir, realSrcPluginDir)
  ) {
    throw new Error(
      `Built plugin directory "${builtDir}" overlaps plugin source directory "${srcPluginDir}".`
    );
  }

  const validatedCopyEntries = [];
  for (const rawEntry of rawCopy) {
    const { target: copySrc, cleanRel } = assertContainedRepoRelPath(
      resolvedRepo,
      realRepoRoot,
      rawEntry,
      'agyPlugin.copy entry'
    );
    const realCopySrc = resolveRealPathWithMissingTail(copySrc);
    if (
      isWithinRoot(copySrc, effectiveOutRoot) ||
      isWithinRoot(effectiveOutRoot, copySrc) ||
      isWithinRoot(copySrc, builtDir) ||
      isWithinRoot(builtDir, copySrc) ||
      isWithinRoot(realCopySrc, realOutRoot) ||
      isWithinRoot(realOutRoot, realCopySrc) ||
      isWithinRoot(realCopySrc, realBuiltDir) ||
      isWithinRoot(realBuiltDir, realCopySrc)
    ) {
      throw new Error(
        `agyPlugin.copy entry "${rawEntry}" overlaps output directory "${builtDir}".`
      );
    }
    if (!existsSync(copySrc)) {
      if (String(rawEntry).trim() === 'LICENSE') {
        continue;
      }
      throw new Error(`agyPlugin.copy entry "${rawEntry}" does not exist in ${resolvedRepo}.`);
    }
    validatedCopyEntries.push({ copySrc, cleanRel });
  }

  removeLinkOrDir(builtDir);
  mkdirSync(builtDir, { recursive: true });

  copySafeWithinRepo(srcPluginDir, builtDir, realRepoRoot, {
    skipDir: effectiveOutRoot,
    realOutRoot,
    realBuiltDir,
  });
  for (const { copySrc, cleanRel } of validatedCopyEntries) {
    copySafeWithinRepo(copySrc, join(builtDir, cleanRel), realRepoRoot, {
      skipDir: effectiveOutRoot,
      realOutRoot,
      realBuiltDir,
    });
  }

  const shouldBundleKit =
    agyPlugin.bundleKit === true ||
    (agyPlugin.bundleKit !== false && existsSync(join(srcPluginDir, 'sidecars')));

  if (shouldBundleKit) {
    const repoInstalledKit = join(resolvedRepo, 'node_modules', 'antigravity-sidecar-kit');
    const resolvedKitSource =
      kitRoot && resolve(kitRoot) !== resolve(KIT_ROOT)
        ? resolve(kitRoot)
        : existsSync(join(repoInstalledKit, 'package.json'))
          ? repoInstalledKit
          : kitRoot;
    if (!bundleSidecarKit(builtDir, resolvedKitSource)) {
      throw new Error(
        `Failed to bundle antigravity-sidecar-kit from "${resolvedKitSource}" into "${builtDir}".`
      );
    }
  }

  const builtManifestPath = join(builtDir, 'plugin.json');
  const builtManifest = readJsonSafe(builtManifestPath, null, { strict: true });
  writeJsonNoBom(builtManifestPath, { ...builtManifest, version });

  const lint = lintPluginOrSidecar(builtDir, { strict: true });
  if (!lint.valid) {
    const details = [...lint.errors, ...lint.warnings]
      .map((item) => `[${item.severity}] ${item.ruleId} (${item.file}): ${item.message}`)
      .join('\n  ');
    throw new Error(`Built plugin failed strict manifest lint:\n  ${details}`);
  }

  let agyValidated = false;
  if (agyValidate) {
    const agy = resolveAgyExecutable({ env });
    if (agy.path && agy.semver && compareSemver(agy.semver, MIN_AGY_VALIDATE_SEMVER) >= 0) {
      const valRun = spawnAgyIsolated(agy.path, ['plugin', 'validate', '--strict', builtDir], {
        env,
      });
      if (valRun.error || valRun.status !== 0) {
        const reason =
          valRun.error?.message || `${valRun.stderr ?? ''}\n${valRun.stdout ?? ''}`.trim();
        throw new Error(`agy plugin validate --strict failed: ${reason}`);
      }
      agyValidated = true;
    }
  }

  if (!tar) {
    return {
      dir: builtDir,
      pluginName,
      version,
      bundledKit: shouldBundleKit,
      tarball: null,
      sha256: null,
      agyValidated,
    };
  }

  const tarName = `${pluginName}-plugin-${version}.tgz`;
  const tarRun = spawnSync('tar', ['-czf', tarName, pluginName], {
    cwd: effectiveOutRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (tarRun.error || tarRun.status !== 0) {
    const reason = tarRun.error?.message || (tarRun.stderr || tarRun.stdout || '').trim();
    throw new Error(`tar archive creation failed: ${reason}`);
  }

  const tarball = join(effectiveOutRoot, tarName);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${sha256}  ${tarName}\n`, 'utf8');

  return {
    dir: builtDir,
    pluginName,
    version,
    bundledKit: shouldBundleKit,
    tarball,
    sha256,
    agyValidated,
  };
}
