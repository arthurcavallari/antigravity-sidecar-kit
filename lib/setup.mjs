/**
 * @fileoverview Cross-machine sidecar setup, ephemeral _npx copy-with-SDK-bundling,
 * NTFS junction/symlink linker, config.json enabler, and Language Server hot-reloader.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_JSON_PATH,
  GLOBAL_SIDECARS_DIR,
  HANGAR_PACKAGES_DIR,
  readJsonSafe,
  updateAgySidecarConfig,
} from './config.mjs';
import { callLsRpc, getLsConfig, killSidecarProcessByPortOrPid } from './rpc.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
export const KIT_ROOT = resolve(__dirname, '..');

export function removeLinkOrDir(targetPath) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    return false;
  }
  try {
    if (stat.isSymbolicLink()) {
      unlinkSync(targetPath);
    } else {
      rmSync(targetPath, { recursive: true, force: true });
    }
  } catch {
    rmSync(targetPath, { recursive: true, force: true });
  }
  return true;
}

/**
 * True when targetPath is a real directory rather than a symlink or junction
 * (Windows junctions report isSymbolicLink() === true).
 */
export function isRealDirectory(targetPath) {
  try {
    const stat = lstatSync(targetPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertNotInPlaceCheckout(linkPath, sourceRealPath, force) {
  if (force || !isRealDirectory(linkPath)) return;
  if (realpathSync(linkPath) === sourceRealPath) return;
  const err = new Error(
    `Refusing to replace ${linkPath}: it is a real directory (an in-place checkout?), not a link. ` +
      'Run setup from inside that directory, move it away, or re-run with --force to replace it.'
  );
  err.code = 'EINPLACECHECKOUT';
  throw err;
}

export function createSidecarLink(sourceDir, linkPath, { force = false } = {}) {
  mkdirSync(resolve(linkPath, '..'), { recursive: true });
  const resolvedSource = realpathSync(resolve(sourceDir));
  let alreadyLinked = false;
  if (existsSync(linkPath)) {
    try {
      alreadyLinked = realpathSync(linkPath) === resolvedSource;
    } catch {
      alreadyLinked = false;
    }
  }
  if (!alreadyLinked) {
    assertNotInPlaceCheckout(linkPath, resolvedSource, force);
    removeLinkOrDir(linkPath);
    symlinkSync(resolvedSource, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return resolvedSource;
}

/**
 * Path of `src` relative to `root` as '' (the root itself) or '/a/b', for cpSync filters.
 * Slicing by string length breaks when Windows hands the filter a differently-cased or
 * short-name form of the root, so compare as paths and fall back to canonical real paths.
 */
function pathFromRoot(root, src) {
  let rel = relative(root, src);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    try {
      rel = relative(realpathSync.native(root), realpathSync.native(src));
    } catch {
      // keep the first answer
    }
  }
  rel = rel.replace(/\\/g, '/');
  return rel ? `/${rel}` : '';
}

export function bundleSidecarKit(targetDir, kitRoot = KIT_ROOT) {
  if (!targetDir || !kitRoot || !existsSync(join(kitRoot, 'package.json'))) return false;
  const targetKitDir = join(targetDir, 'node_modules', 'antigravity-sidecar-kit');
  mkdirSync(join(targetDir, 'node_modules'), { recursive: true });
  cpSync(kitRoot, targetKitDir, {
    recursive: true,
    filter: (src) => !/^\/(\.git|node_modules|test)(\/|$)/.test(pathFromRoot(kitRoot, src)),
  });
  return true;
}

/**
 * Copies out of ephemeral _npx / node_modules directories into ~/.gemini/hangar/packages/<id>@<version>
 * while preserving or injecting node_modules/antigravity-sidecar-kit so the permanent copy can resolve it.
 */
export function resolvePermanentLinkSource(
  repoRoot,
  { sidecarId = '', version = '', packagesDir = HANGAR_PACKAGES_DIR, kitRoot = KIT_ROOT } = {}
) {
  const resolvedRoot = realpathSync(resolve(repoRoot));
  if (!/[\\/]_npx[\\/]|[\\/]node_modules[\\/]/i.test(resolvedRoot)) {
    return resolvedRoot;
  }
  const pkgJson = readJsonSafe(join(resolvedRoot, 'package.json'), {});
  const droppedDeps = Object.keys(pkgJson.dependencies || {}).filter(
    (dep) => dep !== 'antigravity-sidecar-kit'
  );
  if (droppedDeps.length > 0) {
    console.warn(
      `[antigravity-sidecar-kit] Warning: the permanent copy only bundles antigravity-sidecar-kit; ` +
        `these dependencies will be missing at runtime: ${droppedDeps.join(', ')}`
    );
  }
  const cleanVer = String(version || pkgJson.version || '1.0.0').replace(/[^a-z0-9._-]+/gi, '') || '1.0.0';
  const id =
    sidecarId ||
    String(pkgJson.name || 'sidecar')
      .replace(/^antigravity-sidecar-|^antigravity-|^agy-/i, '')
      .trim();
  const destDir = join(packagesDir, `${id}@${cleanVer}`);
  mkdirSync(packagesDir, { recursive: true });
  rmSync(destDir, { recursive: true, force: true });

  cpSync(resolvedRoot, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = pathFromRoot(resolvedRoot, src);
      if (!rel) return true;
      if (/^\/\.git(\/|$)/.test(rel)) return false;
      if (/^\/node_modules(\/|$)/.test(rel)) {
        if (rel === '/node_modules') return true;
        if (/^\/node_modules\/antigravity-sidecar-kit(\/|$)/.test(rel)) {
          const subRel = rel.slice('/node_modules/antigravity-sidecar-kit'.length);
          return !/^\/(\.git|node_modules)(\/|$)/.test(subRel);
        }
        return false;
      }
      return true;
    },
  });

  // If npm hoisted antigravity-sidecar-kit in _npx/<hash>/node_modules/antigravity-sidecar-kit,
  // copy kitRoot into destDir/node_modules/antigravity-sidecar-kit so runtime imports succeed.
  const bundledKitPkg = join(destDir, 'node_modules', 'antigravity-sidecar-kit', 'package.json');
  if (!existsSync(bundledKitPkg)) {
    bundleSidecarKit(destDir, kitRoot);
  }

  return realpathSync(destDir);
}

async function notifyManageSidecar(sidecarId, action, rpcOptions = {}) {
  const { lsAddress, csrfToken } = getLsConfig({ ...rpcOptions, sidecarId });
  if (!lsAddress || !csrfToken) {
    return {
      notified: false,
      reason: `linked & enabled in config.json — select ${sidecarId} in the Antigravity Auxiliary Pane`,
    };
  }
  const body = await callLsRpc('ManageSidecar', { action, sidecarId }, { ...rpcOptions, sidecarId });
  return { notified: true, body };
}

export async function runSidecarSetup({
  sidecarId,
  repoRoot,
  version = '',
  requiredFiles = ['sidecar.json', 'server.mjs'],
  testFiles = [],
  onBeforeSetup,
  onUninstall,
  args = process.argv.slice(2),
  globalSidecarsDir = GLOBAL_SIDECARS_DIR,
  configJsonPath = CONFIG_JSON_PATH,
  packagesDir = HANGAR_PACKAGES_DIR,
  rpcOptions = {},
  execFn = execFileSync,
  restartDelayMs = 350,
} = {}) {
  if (!sidecarId) throw new Error('sidecarId is required');
  if (!repoRoot) throw new Error('repoRoot is required');

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    throw new Error(
      `Node.js >= 20.0.0 is required (current: ${process.version}). Switch Node versions (e.g. "nvm use 22") and try again.`
    );
  }

  const resolvedRepoRoot = realpathSync(resolve(repoRoot));
  const junctionPath = join(globalSidecarsDir, sidecarId);
  const cliArgs = new Set(args);
  const isUninstall = cliArgs.has('--uninstall');
  const skipTests = cliArgs.has('--skip-tests');
  const force = cliArgs.has('--force');

  console.log(`[${sidecarId}] Repository root: ${resolvedRepoRoot}`);

  if (isUninstall) {
    if (isRealDirectory(junctionPath) && realpathSync(junctionPath) === resolvedRepoRoot) {
      console.log(`[${sidecarId}] Preserving in-place repository directory at ${junctionPath}.`);
    } else if (isRealDirectory(junctionPath) && !force) {
      console.log(
        `[${sidecarId}] Not removing ${junctionPath}: it is a real directory, not a link (re-run with --force to delete it).`
      );
    } else {
      removeLinkOrDir(junctionPath);
    }

    // Prune permanent copies made by earlier npx installs, but never the directory we are running from
    const entries = existsSync(packagesDir) ? readdirSync(packagesDir) : [];
    for (const entry of entries) {
      if (!entry.startsWith(`${sidecarId}@`)) continue;
      const entryPath = join(packagesDir, entry);
      try {
        if (realpathSync(entryPath) === resolvedRepoRoot) continue;
      } catch {
        // dangling entry; safe to remove
      }
      removeLinkOrDir(entryPath);
    }

    if (typeof onUninstall === 'function') {
      await onUninstall({
        sidecarId,
        repoRoot: resolvedRepoRoot,
        configJsonPath,
        globalSidecarsDir,
        removeLinkOrDir,
      });
    }

    updateAgySidecarConfig(sidecarId, false, configJsonPath, { createIfMissing: false });
    await notifyManageSidecar(sidecarId, 'SIDECAR_ACTION_DISABLE', rpcOptions).catch(() => {});
    console.log(`[${sidecarId}] Uninstalled cleanly.`);
    return { uninstalled: true, sidecarId };
  }

  for (const rel of requiredFiles) {
    const full = isAbsolute(rel) ? rel : join(resolvedRepoRoot, rel);
    if (!existsSync(full)) {
      throw new Error(`Missing required file: ${full}`);
    }
  }

  // Fail before running hooks, tests, or the npx copy if we would have to delete a real checkout
  assertNotInPlaceCheckout(junctionPath, resolvedRepoRoot, force);

  if (typeof onBeforeSetup === 'function') {
    await onBeforeSetup({
      sidecarId,
      repoRoot: resolvedRepoRoot,
      configJsonPath,
      globalSidecarsDir,
      removeLinkOrDir,
    });
  }

  if (!skipTests && Array.isArray(testFiles) && testFiles.length > 0) {
    console.log(`[${sidecarId}] Running unit tests...`);
    const resolvedTests = testFiles.map((f) => (isAbsolute(f) ? f : join(resolvedRepoRoot, f)));
    execFn(process.execPath, ['--test', ...resolvedTests], {
      cwd: resolvedRepoRoot,
      stdio: 'inherit',
    });
  }

  const targetSourceDir = resolvePermanentLinkSource(resolvedRepoRoot, {
    sidecarId,
    version,
    packagesDir,
  });
  createSidecarLink(targetSourceDir, junctionPath, { force });
  console.log(`[${sidecarId}] Linked ${junctionPath} -> ${realpathSync(junctionPath)}`);

  updateAgySidecarConfig(sidecarId, true, configJsonPath, { createIfMissing: true });

  let rpcRes = await notifyManageSidecar(sidecarId, 'SIDECAR_ACTION_RESTART', rpcOptions).catch(
    (err) => ({ notified: false, reason: err.message })
  );
  if (!rpcRes.notified) {
    if (restartDelayMs > 0) await new Promise((r) => setTimeout(r, restartDelayMs));
    rpcRes = await notifyManageSidecar(sidecarId, 'SIDECAR_ACTION_ENABLE', rpcOptions).catch(
      (err) => ({ notified: false, reason: err.message })
    );
  }
  if (!rpcRes.notified) {
    const killed = killSidecarProcessByPortOrPid(sidecarId, { execFn, ...rpcOptions });
    if (killed.restarted) {
      rpcRes = { notified: true, viaProcessRestart: killed.method };
    }
  }
  console.log(
    rpcRes.notified
      ? `[${sidecarId}] Enabled and restarted (${rpcRes.viaProcessRestart || 'Language Server RPC'}).`
      : `[${sidecarId}] Setup complete (${rpcRes.reason || 'ready'}).`
  );
  return { uninstalled: false, sidecarId, linkedTo: targetSourceDir, rpcRes };
}
