import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  normalizeHookEnvelope,
  readHookEnvelope,
  formatHookResult,
  writeHookResult,
  createHookSessionStore,
} from '../lib/hooks.mjs';

test('normalizeHookEnvelope normalizes Antigravity call_mcp_tool, Claude Code, Cursor, and Gemini payloads', () => {
  const agy = normalizeHookEnvelope({
    conversationId: 'conv-1',
    workspacePaths: ['C:/repo'],
    toolCall: {
      name: 'call_mcp_tool',
      args: {
        ServerName: 'soc_exabeam',
        ToolName: 'exabeam_search_alerts',
        Arguments: { limit: 10 },
      },
    },
  });
  assert.equal(agy.platform, 'antigravity');
  assert.equal(agy.sessionId, 'conv-1');
  assert.equal(agy.workspaceRoot, 'C:/repo');
  assert.equal(agy.hookEvent, 'PreToolUse');
  assert.equal(agy.mcpServerName, 'soc_exabeam');
  assert.equal(agy.mcpToolName, 'exabeam_search_alerts');
  assert.equal(agy.toolName, 'mcp__soc_exabeam__exabeam_search_alerts');
  assert.deepEqual(agy.toolInput, { limit: 10 });

  // Antigravity mcp_tool with stringified JSON Arguments and snake_case keys
  const agyStrArgs = normalizeHookEnvelope({
    sessionId: 'sess-agy-2',
    invocationNum: 3,
    toolCall: {
      name: 'mcp_tool',
      args: {
        server_name: 'github',
        tool_name: 'list_issues',
        Arguments: '{"state":"open"}',
      },
    },
  });
  assert.equal(agyStrArgs.platform, 'antigravity');
  assert.equal(agyStrArgs.sessionId, 'sess-agy-2');
  assert.equal(agyStrArgs.mcpServerName, 'github');
  assert.equal(agyStrArgs.mcpToolName, 'list_issues');
  assert.equal(agyStrArgs.toolName, 'mcp__github__list_issues');
  assert.deepEqual(agyStrArgs.toolInput, { state: 'open' });

  // Cursor envelope
  const cursor = normalizeHookEnvelope({
    conversation_id: 'cur-99',
    cursor_version: '0.48.0',
    workspace_roots: ['/Users/dev/project'],
    hook_event_name: 'beforeSubmitPrompt',
    prompt: 'migrate to app router',
  });
  assert.equal(cursor.platform, 'cursor');
  assert.equal(cursor.sessionId, 'cur-99');
  assert.equal(cursor.workspaceRoot, '/Users/dev/project');
  assert.equal(cursor.hookEvent, 'UserPromptSubmit');
  assert.equal(cursor.prompt, 'migrate to app router');

  // Gemini CLI envelope
  const gemini = normalizeHookEnvelope({
    session_id: 'gem-1',
    cwd: '/tmp/gem-proj',
    hook_event_name: 'BeforeTool',
    tool_name: 'run_shell_command',
    tool_input: { command: 'npm test' },
  });
  assert.equal(gemini.platform, 'gemini');
  assert.equal(gemini.sessionId, 'gem-1');
  assert.equal(gemini.workspaceRoot, '/tmp/gem-proj');
  assert.equal(gemini.hookEvent, 'PreToolUse');
  assert.equal(gemini.toolName, 'run_shell_command');
  assert.deepEqual(gemini.toolInput, { command: 'npm test' });

  // Claude Code envelope with mcp__<server>__<tool>
  const claude = normalizeHookEnvelope(
    {
      hook_event_name: 'postToolUse',
      tool_name: 'mcp__stripe__create_customer',
      tool_input: { email: 'a@b.com' },
      tool_response: { id: 'cus_123' },
    },
    {
      CLAUDE_SESSION_ID: 'env-claude-sess',
      CLAUDE_PROJECT_DIR: '/workspace/claude-app',
    }
  );
  assert.equal(claude.platform, 'claude');
  assert.equal(claude.sessionId, 'env-claude-sess');
  assert.equal(claude.workspaceRoot, '/workspace/claude-app');
  assert.equal(claude.hookEvent, 'PostToolUse');
  assert.equal(claude.toolName, 'mcp__stripe__create_customer');
  assert.equal(claude.mcpServerName, 'stripe');
  assert.equal(claude.mcpToolName, 'create_customer');
  assert.deepEqual(claude.toolInput, { email: 'a@b.com' });
  assert.deepEqual(claude.toolResponse, { id: 'cus_123' });
});

test('normalizeHookEnvelope maps all lifecycle event aliases and env fallbacks', () => {
  assert.equal(normalizeHookEnvelope({ hook_event_name: 'BeforeAgent' }).hookEvent, 'UserPromptSubmit');
  assert.equal(normalizeHookEnvelope({ hook_event_name: 'AfterTool' }).hookEvent, 'PostToolUse');
  assert.equal(normalizeHookEnvelope({ hook_event_name: 'sessionStart' }).hookEvent, 'SessionStart');
  assert.equal(normalizeHookEnvelope({ hook_event_name: 'stop' }).hookEvent, 'Stop');
  assert.equal(normalizeHookEnvelope({ hook_event_name: 'AfterAgent' }).hookEvent, 'Stop');

  const cursorEnv = normalizeHookEnvelope({}, {
    CURSOR_TRACE_ID: 'trace-777',
    CURSOR_PROJECT_DIR: '/cursor/dir',
  });
  assert.equal(cursorEnv.sessionId, 'trace-777');
  assert.equal(cursorEnv.workspaceRoot, '/cursor/dir');
  assert.equal(cursorEnv.hookEvent, 'PreToolUse');
});

test('readHookEnvelope strips UTF-8 BOM, handles empty stdin, and enforces maxBytes', async () => {
  const bomPayload = '\uFEFF' + JSON.stringify({
    trajectoryId: 'traj-42',
    toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
  });
  const stream = Readable.from([
    Buffer.from(bomPayload.slice(0, 15), 'utf8'),
    Buffer.from(bomPayload.slice(15), 'utf8'),
  ]);
  const env = await readHookEnvelope({ stream });
  assert.equal(env.platform, 'antigravity');
  assert.equal(env.toolName, 'run_command');
  assert.deepEqual(env.toolInput, { CommandLine: 'git status' });

  const emptyEnv = await readHookEnvelope({ stream: Readable.from(['   \n  ']) });
  assert.equal(emptyEnv.platform, 'claude');
  assert.equal(emptyEnv.hookEvent, 'PreToolUse');

  const oversizedStream = Readable.from([Buffer.alloc(2048, 0x61)]);
  await assert.rejects(
    () => readHookEnvelope({ stream: oversizedStream, maxBytes: 1024 }),
    /maxBytes/i
  );
});

test('formatHookResult formats decisions, additionalContext, and updatedInput across platforms', () => {
  // Antigravity PreToolUse with no opinion returns empty string ''
  assert.equal(formatHookResult({}, { platform: 'antigravity', hookEvent: 'PreToolUse' }), '');

  // Antigravity PreToolUse force_ask
  const agyForceAsk = JSON.parse(
    formatHookResult(
      { decision: 'force_ask', reason: 'Destructive action' },
      { platform: 'antigravity', hookEvent: 'PreToolUse' }
    )
  );
  assert.equal(agyForceAsk.decision, 'force_ask');
  assert.equal(agyForceAsk.reason, 'Destructive action');

  // Claude PreToolUse maps force_ask -> ask and populates hookSpecificOutput
  const claudeOut = JSON.parse(
    formatHookResult(
      {
        decision: 'force_ask',
        reason: 'Confirm delete',
        additionalContext: '<!-- skillInjection: {} -->',
        updatedInput: { command: 'ls -la' },
      },
      { platform: 'claude', hookEvent: 'PreToolUse' }
    )
  );
  assert.equal(claudeOut.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(claudeOut.hookSpecificOutput.permissionDecisionReason, 'Confirm delete');
  assert.equal(claudeOut.hookSpecificOutput.additionalContext, '<!-- skillInjection: {} -->');
  assert.deepEqual(claudeOut.hookSpecificOutput.updatedInput, { command: 'ls -la' });

  // Cursor includes flat additional_context
  const cursorOut = JSON.parse(
    formatHookResult(
      { additionalContext: 'Cursor context payload' },
      { platform: 'cursor', hookEvent: 'UserPromptSubmit' }
    )
  );
  assert.equal(cursorOut.additional_context, 'Cursor context payload');
  assert.equal(cursorOut.hookSpecificOutput.additionalContext, 'Cursor context payload');
});

test('writeHookResult waits for slow stream drain on >64 KB payloads before resolving', async () => {
  const largeContext = 'x'.repeat(96 * 1024);
  const chunks = [];
  let flushed = false;

  const slowStream = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      setTimeout(() => {
        flushed = true;
        callback();
      }, 30);
    },
  });

  await writeHookResult(
    { additionalContext: largeContext },
    { stream: slowStream, platform: 'antigravity', hookEvent: 'PostToolUse' }
  );

  assert.equal(flushed, true);
  const written = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(written);
  assert.equal(parsed.additionalContext, largeContext);

  // Empty no-opinion PreToolUse on Antigravity writes 0 bytes
  const noopStream = new PassThrough();
  await writeHookResult({}, { stream: noopStream, platform: 'antigravity', hookEvent: 'PreToolUse' });
  assert.equal(noopStream.read(), null);
});

test('createHookSessionStore enforces atomic wx claimKey deduplication, path sanitization, state I/O, and clear()', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kit-hooks-test-'));
  try {
    const store = createHookSessionStore('../test-ns/evil', '..\\sess-123/../../x', { baseDir: tmpDir });
    assert.ok(existsSync( join(tmpDir, 'agy-hook-state') ));

    assert.equal(store.hasKey('nextjs'), false);
    assert.equal(store.claimKey('nextjs'), true);
    assert.equal(store.hasKey('nextjs'), true);
    assert.equal(store.claimKey('nextjs'), false);
    assert.deepEqual(store.listKeys(), ['nextjs']);

    // ASK-09: Keys that differ only in punctuation must not collide in seen-keys.d
    assert.equal(store.claimKey('skill:a/b'), true);
    assert.equal(store.claimKey('skill_a_b'), true, 'skill:a/b and skill_a_b must not collide');
    assert.deepEqual(store.listKeys().sort(), ['nextjs', 'skill:a/b', 'skill_a_b']);

    // ASK-09: formatHookResult populates injectSteps for Antigravity UserPromptSubmit / PreInvocation
    const agyPromptOut = JSON.parse(
      formatHookResult({ additionalContext: 'injected prompt ctx' }, { platform: 'antigravity', hookEvent: 'UserPromptSubmit' })
    );
    assert.ok(Array.isArray(agyPromptOut.injectSteps));

    store.writeState({ count: 2, active: true });
    assert.deepEqual(store.readState(), { count: 2, active: true });

    store.clear();
    assert.equal(store.hasKey('nextjs'), false);
    assert.deepEqual(store.listKeys(), []);
    assert.deepEqual(store.readState(), {});
    assert.equal(store.claimKey('nextjs'), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readHookEnvelope handles malformed JSON gracefully and createAtomicSessionStore alias is exported (F-03)', async () => {
  const hooksMod = await import('../lib/hooks.mjs');
  assert.equal(hooksMod.createAtomicSessionStore, createHookSessionStore);

  const fallbackEnv = await readHookEnvelope({ stream: Readable.from(['{malformed-json']) });
  assert.equal(fallbackEnv.hookEvent, 'PreToolUse');

  await assert.rejects(
    () => readHookEnvelope({ stream: Readable.from(['{malformed-json']), strict: true }),
    SyntaxError
  );
});
