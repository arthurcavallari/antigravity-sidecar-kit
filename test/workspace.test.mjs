import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspacePath,
  extractWorkspaceName,
  matchesWorkspaceRule,
  resolveActiveWorkspace,
  isRealConversationId,
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

  // On a switch, Antigravity stamps the previous and the next conversation with the same
  // lastUserViewTime, so a frame's own ?conversationId= is the only reliable answer.
  const switched = {
    trajectorySummaries: {
      'conv-prev': {
        lastUserInputTime: '2026-10-24T04:27:09Z',
        annotations: { lastUserViewTime: '2026-10-24T04:31:00Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/Projects/Prev' }],
      },
      'conv-open': {
        lastUserInputTime: '2026-10-23T04:50:29Z',
        annotations: { lastUserViewTime: '2026-10-24T04:30:00Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/Projects/Open' }],
      },
    },
  };

  it("returns the frame's own conversation even when another one has a newer view time", () => {
    const resolved = resolveActiveWorkspace({
      clientWorkspaceUris: ['file:///c:/Projects/Prev'],
      requestedConversationId: 'conv-open',
      trajectoriesResponse: switched,
    });
    assert.deepEqual(resolved, {
      workspacePath: 'c:/Projects/Open',
      workspaceName: 'Open',
      source: 'conversation',
      conversationId: 'conv-open',
    });
  });

  it("keeps a conversation that isn't listed yet, with the pushed workspace instead of another conversation's", () => {
    const resolved = resolveActiveWorkspace({
      clientWorkspaceUris: ['file:///c:/Projects/Fresh'],
      requestedConversationId: 'conv-brand-new',
      trajectoriesResponse: switched,
    });
    assert.equal(resolved.conversationId, 'conv-brand-new');
    assert.equal(resolved.workspacePath, 'c:/Projects/Fresh');
    assert.equal(resolved.source, 'host_push');

    const noPush = resolveActiveWorkspace({ requestedConversationId: 'conv-brand-new', trajectoriesResponse: switched });
    assert.equal(noPush.conversationId, 'conv-brand-new');
    assert.equal(noPush.workspaceName, 'Global');
  });

  it('treats _new as a new-conversation pane: no conversation, just the pushed workspace', () => {
    assert.equal(isRealConversationId('_new'), false);
    assert.equal(isRealConversationId(''), false);
    assert.equal(isRealConversationId('conv-open'), true);

    const resolved = resolveActiveWorkspace({
      clientWorkspaceUris: ['file:///c:/Projects/Open'],
      requestedConversationId: '_new',
      trajectoriesResponse: switched,
    });
    assert.deepEqual(resolved, {
      workspacePath: 'c:/Projects/Open',
      workspaceName: 'Open',
      source: 'new_conversation',
      conversationId: '',
    });
  });

  it('answers each frame independently, so windows on different conversations never affect each other', () => {
    const ask = (id) =>
      resolveActiveWorkspace({ requestedConversationId: id, trajectoriesResponse: switched }).conversationId;
    assert.deepEqual(['conv-open', 'conv-prev', 'conv-open', 'conv-prev'].map(ask), [
      'conv-open',
      'conv-prev',
      'conv-open',
      'conv-prev',
    ]);
    // Without an id it can only guess, and the guess is the newest view time
    assert.equal(ask(''), 'conv-prev');
  });
});
