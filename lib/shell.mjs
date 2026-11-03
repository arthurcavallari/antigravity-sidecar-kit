/**
 * @fileoverview AGY design-token stylesheet (AGY_SHELL_CSS) and client runtime (AGY_CLIENT_JS)
 * loaded from real files in lib/ui/shell/.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'shell');

export const AGY_SHELL_CSS = readFileSync(join(SHELL_DIR, 'shell.css'), 'utf8');

export const AGY_CLIENT_JS = [
  readFileSync(join(SHELL_DIR, 'theme-client.js'), 'utf8'),
  readFileSync(join(SHELL_DIR, 'sync-client.js'), 'utf8'),
].join('\n');
