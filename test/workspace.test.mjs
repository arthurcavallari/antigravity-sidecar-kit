import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWorkspacePath,
  extractWorkspaceName,
  matchesWorkspaceRule,
  resolveActiveWorkspace,
} from '../lib/workspace.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('antigravity-sidecar-kit/workspace normalization, glob matching, and <= 300 line audit', () => {
  it('normalizes percent-encoded Windows file:// URIs, supports lowercase flag, and matches rules', () => {
    assert.equal(normalizeWorkspacePath('file:///c%3A/Projects/App/'), 'c:/Projects/App');
    assert.equal(
      normalizeWorkspacePath('file:///C:/Users/dev/Repo', { lowercase: true }),
      'c:/users/dev/repo'
    );
    assert.equal(extractWorkspaceName('c:/Projects/services'), 'services');

    assert.equal(matchesWorkspaceRule('c:/Projects/App', ['*']), true);
    assert.equal(matchesWorkspaceRule('c:/Projects/App/packages/api', ['c:/Projects/App']), true);
    assert.equal(matchesWorkspaceRule('c:/Users/dev/backend-api', ['*backend*']), true);
    assert.equal(matchesWorkspaceRule('c:/Users/dev/frontend', ['c:/Projects/App']), false);
  });

  it('resolves active workspace from trajectories sorted by lastUserViewTime', () => {
    const resolved = resolveActiveWorkspace({
      trajectoriesResponse: {
        trajectorySummaries: {
          'conv-1': {
            annotations: { lastUserViewTime: '2026-10-17T05:00:00Z' },
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/Old' }],
          },
          'conv-2': {
            annotations: { lastUserViewTime: '2026-10-17T08:00:00Z' },
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/Projects/Current' }],
          },
        },
      },
    });
    assert.equal(resolved.workspacePath, 'c:/Projects/Current');
    assert.equal(resolved.workspaceName, 'Current');
    assert.equal(resolved.conversationId, 'conv-2');
  });

  it('every source file in antigravity-sidecar-kit strictly obeys the <= 300 line limit', () => {
    const walk = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === '.idea') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          out.push(...walk(full));
        } else if (/\.(mjs|js|css|html|json)$/.test(entry) && entry !== 'package-lock.json') {
          out.push(full);
        }
      }
      return out;
    };

    const files = walk(REPO_ROOT);
    assert.ok(files.length >= 12);
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 300, `File ${file} has ${lines} lines (limit <= 300)`);
    }
  });
});
