#!/usr/bin/env node
/**
 * @fileoverview CLI entrypoint for antigravity-sidecar-kit / create-antigravity-sidecar / agy-sidecar-kit.
 */

import { isAbsolute, relative } from 'node:path';
import { scaffoldSidecarProject } from '../lib/scaffolder.mjs';

const USAGE = 'Usage: npx antigravity-sidecar-kit init <sidecar-name> [--dir <target-dir>] [--force]';

const rawArgs = process.argv.slice(2);
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
  if (arg === '--dir' && rawArgs[i + 1]) {
    targetDir = rawArgs[++i];
    continue;
  }
  if (!arg.startsWith('-') && !name) {
    name = arg;
  }
}

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
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
