#!/usr/bin/env node
/**
 * @fileoverview CLI entrypoint for create-antigravity-sidecar / agy-sidecar-kit.
 */

import { scaffoldSidecarProject } from '../lib/scaffolder.mjs';

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

if (!name || rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log('Usage: agy-sidecar-kit init <sidecar-name> [--dir <target-dir>] [--force]');
  process.exit(name ? 0 : 1);
}

try {
  const res = scaffoldSidecarProject({ name, targetDir, force });
  console.log(`[antigravity-sidecar-kit] Scaffolded ${res.pkgName} at ${res.outDir}`);
} catch (err) {
  console.error(`[antigravity-sidecar-kit] Error: ${err.message}`);
  process.exit(1);
}
