#!/usr/bin/env node
/**
 * @fileoverview CLI entrypoint for antigravity-sidecar-kit / create-antigravity-sidecar / agy-sidecar-kit.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { scaffoldSidecarProject } from '../lib/scaffolder.mjs';
import { lintPluginOrSidecar } from '../lib/manifest-validator.mjs';

const USAGE = [
  'Usage:',
  '  npx antigravity-sidecar-kit init <sidecar-name> [--dir <target-dir>] [--force]',
  '  npx antigravity-sidecar-kit lint [--fix] [--json] [--strict] [dir]',
].join('\n');

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

if (rawArgs[0] === 'lint') {
  let fix = false;
  let json = false;
  let strict = false;
  let dir = '';
  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--fix') {
      fix = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice(6);
    } else if (arg === '--dir' && rawArgs[i + 1]) {
      dir = rawArgs[++i];
    } else if (!arg.startsWith('-') && !dir) {
      dir = arg;
    }
  }
  const res = lintPluginOrSidecar(resolve(dir || process.cwd()), { fix, strict });
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
  process.exit(process.exitCode || 0);
}

let name = '';
let targetDir = '';
let force = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === 'init') continue;
  if (arg === '--force' || arg === '-f') {
    force = true;
    continue;
  }
  if (arg.startsWith('--dir=')) {
    targetDir = arg.slice(6);
    continue;
  }
  if (arg === '--dir' && rawArgs[i + 1]) {
    targetDir = rawArgs[++i];
    continue;
  }
  if (!arg.startsWith('-') && !name) {
    name = arg;
  }
}

if (!name) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const res = scaffoldSidecarProject({ name, targetDir, force });
  const rel = relative(process.cwd(), res.outDir);
  const cdPath = !rel ? '.' : rel.startsWith('..') || isAbsolute(rel) ? res.outDir : rel;
  console.log(`[antigravity-sidecar-kit] Scaffolded ${res.pkgName} at ${res.outDir}`);
  console.log('\nNext steps:');
  console.log(`  cd ${cdPath.includes(' ') ? `"${cdPath}"` : cdPath}`);
  console.log('  npm install');
  console.log('  npm run setup');
} catch (err) {
  console.error(`[antigravity-sidecar-kit] Error: ${err.message}`);
  process.exit(1);
}
