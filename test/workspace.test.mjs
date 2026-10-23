import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspacePath,
  extractWorkspaceName,
  matchesWorkspaceRule,
  resolveActiveWorkspace,
} from '../lib/workspace.mjs';

describe('antigravity-sidecar-kit/workspace normalization and glob matching', () => {
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

  it('keeps POSIX roots absolute and handles UNC URIs and single-character globs', () => {
    assert.equal(normalizeWorkspacePath('file:///home/dev/app'), '/home/dev/app');
    assert.equal(normalizeWorkspacePath('file:///Users/dev/My%20App/'), '/Users/dev/My App');
    assert.equal(normalizeWorkspacePath('/home/dev/app/'), '/home/dev/app');
    assert.equal(normalizeWorkspacePath('file:///'), '/');
    assert.equal(normalizeWorkspacePath('file://server/share/repo'), '//server/share/repo');
    assert.equal(normalizeWorkspacePath('C:\\Projects\\App\\'), 'c:/Projects/App');

    assert.equal(matchesWorkspaceRule('file:///home/dev/app/web', ['/home/dev/app']), true);
    assert.equal(matchesWorkspaceRule('/home/dev/app', ['file:///home/dev/app/']), true);
    assert.equal(matchesWorkspaceRule('/home/dev/app2', ['/home/dev/app?']), true);
    assert.equal(matchesWorkspaceRule('/home/dev/ap', ['/home/dev/app?']), false);

    const started = process.hrtime.bigint();
    assert.equal(normalizeWorkspacePath(`a${'/'.repeat(200_000)}b`), `a${'/'.repeat(200_000)}b`);
    assert.equal(normalizeWorkspacePath(`a${'/'.repeat(200_000)}`), 'a');
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200, 'normalizing took too long');
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
});
