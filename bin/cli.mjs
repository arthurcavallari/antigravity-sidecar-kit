#!/usr/bin/env node
/**
 * @fileoverview CLI entrypoint for antigravity-sidecar-kit / create-agy / create-antigravity-sidecar / agy-sidecar-kit / agy-kit.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJsonSafe, writeJsonNoBom } from '../lib/config.mjs';
import { buildPluginProject } from '../lib/cli/build-plugin.mjs';
import { runPackSmoke } from '../lib/cli/pack-smoke.mjs';
import { PromptCancelledError, resolveInitOptions } from '../lib/cli/prompts.mjs';
import {
  buildRegistryEntry,
  openRegistryPr,
  upsertRegistryFile,
} from '../lib/cli/registry-entry.mjs';
import { lintPluginOrSidecar } from '../lib/manifest-validator.mjs';
import { scaffoldProject } from '../lib/scaffolder.mjs';

const KIT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const USAGE = [
  'Usage:',
  '  npm create agy [<name>] [--archetype <sidecar-ui|sidecar-mcp|plugin|plugin-sidecar>] [options]',
  '  npx antigravity-sidecar-kit init <sidecar-name> [--archetype <sidecar-ui|sidecar-mcp|plugin|plugin-sidecar>] [-d, --dir <path>] [--pkg-name <name>] [--title <title>] [--description <text>] [--entrypoint <aux_pane|sidebar|full_pane>] [--hide-title-bar] [--components <skills,mcp,rules,hooks,agents>] [--author <name>] [--github <owner>] [--no-ci] [--yes|-y] [--force|-f]',
  '  npx antigravity-sidecar-kit lint [--fix] [--json] [--strict] [--dir <dir>] [dir]',
  '  npx antigravity-sidecar-kit build-plugin [--dir <dir>] [--out <out-dir>] [--no-tar] [--no-agy-validate] [--json] [dir]',
  '  npx antigravity-sidecar-kit pack-smoke [--dir <dir>] [--json] [dir]',
  '  npx antigravity-sidecar-kit registry-entry [--dir <dir>] [--sha256 <64-hex>] [--write <registry.json>] [--pr] [--hangar-repo <owner/repo>] [--no-agy-validate] [--json] [dir]',
  '',
  'Archetypes:',
  '  sidecar-ui       Standalone Auxiliary Pane webview sidecar (default)',
  '  sidecar-mcp      Standalone Auxiliary Pane sidecar + stdio MCP server',
  '  plugin           Native Antigravity plugin bundle (skills, mcp, rules, hooks, agents)',
  '  plugin-sidecar   Native Antigravity plugin + companion sidecar',
].join('\n');

function readFlagValue(args, index, flagName, { allowEmpty = false } = {}) {
  const arg = args[index];
  if (arg.startsWith(`${flagName}=`)) {
    const val = arg.slice(flagName.length + 1);
    if (!allowEmpty && !val.trim()) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { matched: true, value: val, nextIndex: index };
  }
  if (arg === flagName) {
    if (index + 1 >= args.length) {
      throw new Error(`Missing value for ${flagName}`);
    }
    const val = args[index + 1];
    if (!allowEmpty && !val.trim()) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { matched: true, value: val, nextIndex: index + 1 };
  }
  return { matched: false, value: '', nextIndex: index };
}

function runLint(args) {
  let fix = false;
  let json = false;
  let strict = false;
  let dir = '';

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    const dirFlag = readFlagValue(args, i, '--dir');
    if (dirFlag.matched) {
      dir = dirFlag.value;
      i = dirFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}" for lint`);
    }
    if (!dir) {
      dir = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}" for lint`);
    }
  }

  const targetDir = resolve(dir || process.cwd());
  let res = lintPluginOrSidecar(targetDir, { fix, strict });

  const addLintError = (ruleId, file, message) => {
    const errors = [...res.errors, { severity: 'error', ruleId, file, message }];
    res = {
      valid: false,
      errors,
      warnings: res.warnings,
      fixedCount: res.fixedCount,
    };
  };

  if (
    !existsSync(join(targetDir, 'plugin.json')) &&
    !existsSync(join(targetDir, 'sidecar.json'))
  ) {
    const pkgPath = join(targetDir, 'package.json');
    let pkg = null;
    let pkgReadFailed = false;
    if (existsSync(pkgPath)) {
      try {
        pkg = readJsonSafe(pkgPath, null, { strict: true });
      } catch (err) {
        pkgReadFailed = true;
        addLintError(
          'JSON-PARSE-01',
          'package.json',
          `Invalid JSON in package.json: ${err?.message || String(err)}`
        );
      }
    }

    if (!pkgReadFailed) {
      const hasAgyPlugin = pkg !== null && pkg.agyPlugin !== undefined;
      if (
        hasAgyPlugin &&
        (!pkg.agyPlugin || typeof pkg.agyPlugin !== 'object' || Array.isArray(pkg.agyPlugin))
      ) {
        addLintError(
          'AGY-PLUGIN-DIR-01',
          'package.json',
          'package.json "agyPlugin" must be a JSON object.'
        );
      } else {
        const defaultPluginExists = (() => {
          try {
            const p = join(targetDir, 'plugin');
            const st = lstatSync(p);
            return st.isSymbolicLink() || existsSync(join(p, 'plugin.json'));
          } catch {
            return false;
          }
        })();

        if (hasAgyPlugin || defaultPluginExists) {
          const rawPluginDir =
            hasAgyPlugin && pkg.agyPlugin.pluginDir !== undefined
              ? pkg.agyPlugin.pluginDir
              : 'plugin';

          if (
            typeof rawPluginDir !== 'string' ||
            !rawPluginDir.trim() ||
            rawPluginDir.includes('\0') ||
            isAbsolute(rawPluginDir) ||
            /^[a-z]:/i.test(rawPluginDir)
          ) {
            addLintError(
              'AGY-PLUGIN-DIR-01',
              'package.json',
              `Invalid agyPlugin.pluginDir ${JSON.stringify(rawPluginDir)}: expected a non-empty relative path inside ${targetDir}.`
            );
          } else {
            const resolvedPluginDir = resolve(targetDir, rawPluginDir);
            const relPluginDir = relative(targetDir, resolvedPluginDir);
            if (
              !relPluginDir ||
              relPluginDir === '.' ||
              relPluginDir.startsWith('..') ||
              isAbsolute(relPluginDir)
            ) {
              addLintError(
                'AGY-PLUGIN-DIR-01',
                'package.json',
                `agyPlugin.pluginDir "${rawPluginDir}" escapes repository root (${targetDir}).`
              );
            } else {
              let symlinkSegment = '';
              let cur = targetDir;
              for (const part of relPluginDir.split(sep).filter(Boolean)) {
                cur = join(cur, part);
                try {
                  if (lstatSync(cur).isSymbolicLink()) {
                    symlinkSegment = cur;
                    break;
                  }
                } catch {
                  break;
                }
              }

              const realTargetDir = existsSync(targetDir) ? realpathSync.native(targetDir) : targetDir;
              const realPluginDir = existsSync(resolvedPluginDir)
                ? realpathSync.native(resolvedPluginDir)
                : '';
              const realRel = realPluginDir ? relative(realTargetDir, realPluginDir) : '';
              const escapesViaRealpath = Boolean(
                realPluginDir &&
                  (!realRel || realRel === '.' || realRel.startsWith('..') || isAbsolute(realRel))
              );

              if (symlinkSegment || escapesViaRealpath) {
                addLintError(
                  'AGY-PLUGIN-DIR-01',
                  'package.json',
                  `Plugin directory "${rawPluginDir}" must not be or traverse a symbolic link.`
                );
              } else if (
                !existsSync(resolvedPluginDir) ||
                !existsSync(join(resolvedPluginDir, 'plugin.json'))
              ) {
                addLintError(
                  'AGY-PLUGIN-DIR-01',
                  'package.json',
                  `Configured plugin directory "${rawPluginDir}" is missing plugin.json (${join(resolvedPluginDir, 'plugin.json')}).`
                );
              } else {
                const relPosix = relPluginDir.replace(/\\/g, '/');
                const sub = lintPluginOrSidecar(resolvedPluginDir, { fix, strict });
                const prefixItem = (item) => ({
                  ...item,
                  file: item.file ? `${relPosix}/${item.file}` : relPosix,
                });
                const errors = [...res.errors, ...sub.errors.map(prefixItem)];
                const warnings = [...res.warnings, ...sub.warnings.map(prefixItem)];
                const fixedCount = res.fixedCount + sub.fixedCount;
                const valid = strict
                  ? errors.length === 0 && warnings.length === 0
                  : errors.length === 0;
                res = { valid, errors, warnings, fixedCount };
              }
            }
          }
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const err of res.errors) {
      console.error(`[ERROR] ${err.ruleId} (${err.file}): ${err.message}`);
    }
    for (const warn of res.warnings) {
      console.warn(`[WARN] ${warn.ruleId} (${warn.file}): ${warn.message}`);
    }
    console.log(
      `[antigravity-sidecar-kit] Lint ${res.valid ? 'passed' : 'failed'}: ${res.errors.length} error(s), ${res.warnings.length} warning(s), ${res.fixedCount} fixed.`
    );
  }
  if (!res.valid) {
    process.exitCode = 1;
  }
}

function runBuildPlugin(args) {
  let dir = '';
  let outDir = '';
  let tar = true;
  let agyValidate = true;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-tar') {
      tar = false;
      continue;
    }
    if (arg === '--no-agy-validate') {
      agyValidate = false;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    const dirFlag = readFlagValue(args, i, '--dir');
    if (dirFlag.matched) {
      dir = dirFlag.value;
      i = dirFlag.nextIndex;
      continue;
    }
    const outFlag = readFlagValue(args, i, '--out');
    if (outFlag.matched) {
      outDir = outFlag.value;
      i = outFlag.nextIndex;
      continue;
    }
    const outDirFlag = readFlagValue(args, i, '--out-dir');
    if (outDirFlag.matched) {
      outDir = outDirFlag.value;
      i = outDirFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}" for build-plugin`);
    }
    if (!dir) {
      dir = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}" for build-plugin`);
    }
  }

  const res = buildPluginProject({
    repoRoot: resolve(dir || process.cwd()),
    ...(outDir ? { outRoot: resolve(outDir) } : {}),
    tar,
    agyValidate,
  });

  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(
      `[antigravity-sidecar-kit] Built plugin ${res.pluginName}@${res.version} -> ${res.dir}`
    );
    if (res.tarball) {
      console.log(`[antigravity-sidecar-kit] Archive: ${res.tarball} (sha256: ${res.sha256})`);
    }
  }
}

async function runPackSmokeCli(args) {
  let dir = '';
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const dirFlag = readFlagValue(args, i, '--dir');
    if (dirFlag.matched) {
      dir = dirFlag.value;
      i = dirFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}" for pack-smoke`);
    }
    if (!dir) {
      dir = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}" for pack-smoke`);
    }
  }

  const res = await runPackSmoke({
    repoRoot: resolve(dir || process.cwd()),
  });

  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const targets = [
      res.npmTarball ? 'npm tarball' : '',
      res.pluginTarball ? 'plugin tarball' : '',
    ]
      .filter(Boolean)
      .join(' + ');
    console.log(`[antigravity-sidecar-kit] Pack smoke passed (${targets}).`);
  }
}

function createEmptyHangarRegistry() {
  return {
    generatedAt: new Date().toISOString(),
    hangar: {
      id: 'hangar',
      name: 'Antigravity Hangar',
      npmPackage: 'antigravity-hangar',
      latestVersion: '1.6.0',
      release: {
        gitRepo: 'https://github.com/arthurcavallari/antigravity-hangar',
      },
    },
    featuredIds: [],
    packages: [],
  };
}

function runRegistryEntry(args) {
  let dir = '';
  let writePath = '';
  let pr = false;
  let hangarRepo = '';
  let sha256;
  let agyValidate = true;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pr') {
      pr = true;
      continue;
    }
    if (arg === '--no-agy-validate') {
      agyValidate = false;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    const dirFlag = readFlagValue(args, i, '--dir');
    if (dirFlag.matched) {
      dir = dirFlag.value;
      i = dirFlag.nextIndex;
      continue;
    }
    const shaFlag = readFlagValue(args, i, '--sha256');
    if (shaFlag.matched) {
      sha256 = shaFlag.value;
      i = shaFlag.nextIndex;
      continue;
    }
    const writeFlag = readFlagValue(args, i, '--write');
    if (writeFlag.matched) {
      writePath = writeFlag.value;
      i = writeFlag.nextIndex;
      continue;
    }
    const repoFlag = readFlagValue(args, i, '--hangar-repo');
    if (repoFlag.matched) {
      hangarRepo = repoFlag.value;
      i = repoFlag.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}" for registry-entry`);
    }
    if (!dir) {
      dir = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}" for registry-entry`);
    }
  }

  const repoRoot = resolve(dir || process.cwd());

  if (pr) {
    if (writePath) {
      const entry = buildRegistryEntry({
        repoRoot,
        agyValidate,
        ...(sha256 !== undefined ? { sha256 } : {}),
      });
      const resolvedWrite = resolve(writePath);
      if (!existsSync(resolvedWrite)) {
        writeJsonNoBom(resolvedWrite, createEmptyHangarRegistry());
      }
      upsertRegistryFile(resolvedWrite, entry);
    }
    const prRes = openRegistryPr({
      repoRoot,
      ...(hangarRepo ? { hangarRepo } : {}),
      ...(sha256 !== undefined ? { sha256 } : {}),
      agyValidate,
    });
    if (json) {
      console.log(JSON.stringify(prRes, null, 2));
    } else {
      console.log(
        `[antigravity-sidecar-kit] Opened Hangar registry PR (${prRes.branch}): ${prRes.prUrl}`
      );
    }
    return;
  }

  const entry = buildRegistryEntry({
    repoRoot,
    agyValidate,
    ...(sha256 !== undefined ? { sha256 } : {}),
  });
  if (writePath) {
    const resolvedWrite = resolve(writePath);
    if (!existsSync(resolvedWrite)) {
      writeJsonNoBom(resolvedWrite, createEmptyHangarRegistry());
    }
    const upserted = upsertRegistryFile(resolvedWrite, entry);
    if (json) {
      console.log(JSON.stringify(upserted, null, 2));
    } else {
      console.log(
        `[antigravity-sidecar-kit] Registry entry ${upserted.action} for ${upserted.entry.id}@${upserted.entry.latestVersion} in ${resolvedWrite}`
      );
    }
    return;
  }

  console.log(JSON.stringify(entry, null, 2));
}

async function runInit(args, startIndex) {
  const parsedFlags = {};
  let endOfOptions = false;

  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions) {
      if (!parsedFlags.name) {
        parsedFlags.name = arg;
      } else {
        throw new Error(`Unexpected argument "${arg}"`);
      }
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      parsedFlags.force = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsedFlags.yes = true;
      continue;
    }
    if (arg === '--hide-title-bar') {
      parsedFlags.hideTitleBar = true;
      continue;
    }
    if (arg === '--no-ci') {
      parsedFlags.ci = false;
      continue;
    }
    if (arg === '--ci') {
      parsedFlags.ci = true;
      continue;
    }

    const archFlag = readFlagValue(args, i, '--archetype');
    if (archFlag.matched) {
      parsedFlags.archetype = archFlag.value;
      i = archFlag.nextIndex;
      continue;
    }
    const shortArchFlag = readFlagValue(args, i, '-a');
    if (shortArchFlag.matched) {
      parsedFlags.archetype = shortArchFlag.value;
      i = shortArchFlag.nextIndex;
      continue;
    }

    const dirFlag = readFlagValue(args, i, '--dir');
    if (dirFlag.matched) {
      parsedFlags.targetDir = dirFlag.value;
      i = dirFlag.nextIndex;
      continue;
    }
    const shortDirFlag = readFlagValue(args, i, '-d');
    if (shortDirFlag.matched) {
      parsedFlags.targetDir = shortDirFlag.value;
      i = shortDirFlag.nextIndex;
      continue;
    }

    const pkgNameFlag = readFlagValue(args, i, '--pkg-name');
    if (pkgNameFlag.matched) {
      parsedFlags.pkgName = pkgNameFlag.value;
      i = pkgNameFlag.nextIndex;
      continue;
    }

    const nameFlag = readFlagValue(args, i, '--name');
    if (nameFlag.matched) {
      parsedFlags.name = nameFlag.value;
      i = nameFlag.nextIndex;
      continue;
    }

    const titleFlag = readFlagValue(args, i, '--title');
    if (titleFlag.matched) {
      parsedFlags.title = titleFlag.value;
      i = titleFlag.nextIndex;
      continue;
    }

    const descFlag = readFlagValue(args, i, '--description', { allowEmpty: true });
    if (descFlag.matched) {
      parsedFlags.description = descFlag.value;
      i = descFlag.nextIndex;
      continue;
    }

    const epFlag = readFlagValue(args, i, '--entrypoint');
    if (epFlag.matched) {
      parsedFlags.entrypoint = epFlag.value;
      i = epFlag.nextIndex;
      continue;
    }

    const compFlag = readFlagValue(args, i, '--components', { allowEmpty: true });
    if (compFlag.matched) {
      parsedFlags.components = compFlag.value;
      i = compFlag.nextIndex;
      continue;
    }

    const authorFlag = readFlagValue(args, i, '--author');
    if (authorFlag.matched) {
      parsedFlags.author = authorFlag.value;
      i = authorFlag.nextIndex;
      continue;
    }

    const ghFlag = readFlagValue(args, i, '--github', { allowEmpty: true });
    if (ghFlag.matched) {
      parsedFlags.github = ghFlag.value;
      i = ghFlag.nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}"`);
    }

    if (!parsedFlags.name) {
      parsedFlags.name = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  let resolved;
  try {
    resolved = await resolveInitOptions(parsedFlags);
  } catch (err) {
    if (
      (!parsedFlags.name || !String(parsedFlags.name).trim()) &&
      /project name is required/i.test(err?.message || '')
    ) {
      err.showUsage = true;
    }
    throw err;
  }
  const res = scaffoldProject(resolved);
  const rel = relative(process.cwd(), res.outDir);
  const cdPath = !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? res.outDir : rel;
  const quotedCd = cdPath.includes(' ') ? `"${cdPath}"` : cdPath;
  const isPlugin = res.archetype === 'plugin' || res.archetype === 'plugin-sidecar';
  const label = isPlugin ? res.pluginName : res.pkgName;

  console.log(`[antigravity-sidecar-kit] Scaffolded ${label} (${res.archetype}) at ${res.outDir}`);
  console.log('\nNext steps:');
  console.log(`  cd ${quotedCd}`);
  console.log('  npm install');
  if (isPlugin) {
    console.log('  npm run build:plugin');
    console.log(`  agy plugin install ./dist/plugin/${res.pluginName}`);
  } else {
    console.log('  npm run setup');
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const stopIdx = rawArgs.indexOf('--');
  const scanArgs = stopIdx === -1 ? rawArgs : rawArgs.slice(0, stopIdx);

  if (scanArgs.includes('--help') || scanArgs.includes('-h')) {
    console.log(USAGE);
    return;
  }

  if (rawArgs.length === 1 && (rawArgs[0] === '--version' || rawArgs[0] === '-v')) {
    console.log(KIT_VERSION);
    return;
  }

  const sub = rawArgs[0];
  if (sub === 'lint') {
    runLint(rawArgs);
    return;
  }
  if (sub === 'build-plugin') {
    runBuildPlugin(rawArgs);
    return;
  }
  if (sub === 'pack-smoke') {
    await runPackSmokeCli(rawArgs);
    return;
  }
  if (sub === 'registry-entry') {
    runRegistryEntry(rawArgs);
    return;
  }

  await runInit(rawArgs, sub === 'init' ? 1 : 0);
}

main().catch((err) => {
  if (err instanceof PromptCancelledError || err?.code === 'PROMPT_CANCELLED') {
    process.exitCode = err.exitCode || 130;
    return;
  }
  console.error(`[antigravity-sidecar-kit] Error: ${err?.message || String(err)}`);
  if (err?.showUsage) {
    console.error(USAGE);
  }
  process.exitCode = 1;
});
