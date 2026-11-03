import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_NOTIFY_CHARS,
  MCP_CONV_META_KEY,
  StateSync,
  extractConversationId,
  isStandaloneAgentApiBinary,
  registerStateSyncRoutes,
  removeServerInfo,
  runAgentApiAsync,
  sanitizeConversationId,
  verifySidecarToken,
  writeServerInfo,
} from '../lib/state-sync.mjs';
import vm from 'node:vm';
import { AGY_CLIENT_JS } from '../lib/shell.mjs';

describe('antigravity-sidecar-kit/state-sync SSE, mutate, notify, and MCP engine', () => {
  it('writeServerInfo and removeServerInfo atomically manage server_info.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-srvinfo-'));
    try {
      const infoPath = writeServerInfo({ sidecarId: 'demo-sc', port: 54321, dataRoot: dir });
      assert.equal(existsSync(infoPath), true);
      const parsed = JSON.parse(readFileSync(infoPath, 'utf8'));
      assert.equal(parsed.port, 54321);
      assert.equal(parsed.pid, process.pid);
      assert.equal(typeof parsed.startedAt, 'number');

      removeServerInfo({ sidecarId: 'demo-sc', dataRoot: dir });
      assert.equal(existsSync(infoPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('StateSync supports global and conversation-scoped state, resists prototype pollution, and handles notify/MCP', async () => {
    const notifications = [];
    const sync = new StateSync({
      sidecarId: 'test-sync',
      perConversation: true,
      initialState: (convId) => ({ convId, count: 0, nested: { a: 1, b: 2 } }),
      notifyAgent: async (msg, meta) => {
        notifications.push({ msg, meta });
        return { ok: true };
      },
      mcpTools: [
        {
          name: 'bump_counter',
          description: 'Increment counter for the conversation',
          inputSchema: { type: 'object', properties: { delta: { type: 'number' } } },
          handler: async (args, { conversationId, sync: s }) => {
            const cur = s.getState(conversationId);
            const next = s.mutate({ count: cur.count + (args.delta || 1) }, { conversationId });
            return { count: next.count, conversationId };
          },
        },
      ],
    });

    try {
      // Conversation-scoped initial state
      assert.deepEqual(sync.getState('conv-1'), { convId: 'conv-1', count: 0, nested: { a: 1, b: 2 } });

      // Prototype pollution attempt in /api/mutate
      const maliciousPatch = JSON.parse(
        '{"count":5,"nested":{"b":null,"c":3},"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}'
      );
      const mutRes = await sync.handleMutate({
        conversationId: 'conv-1',
        patch: maliciousPatch,
      });
      assert.equal(mutRes.ok, true);
      assert.equal(({}).polluted, undefined);
      assert.deepEqual(sync.getState('conv-1'), {
        convId: 'conv-1',
        count: 5,
        nested: { a: 1, c: 3 },
      });
      // conv-2 remains isolated
      assert.equal(sync.getState('conv-2').count, 0);

      // /api/notify validation, truncation, and deduplication
      const emptyNotify = await sync.handleNotify({ message: '   ' });
      assert.equal(emptyNotify.ok, false);

      const longMsg = 'x'.repeat(MAX_NOTIFY_CHARS + 500);
      const firstNotify = await sync.handleNotify({ conversationId: 'conv-1', message: longMsg });
      assert.equal(firstNotify.ok, true);
      assert.equal(firstNotify.truncated, true);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].msg.length, MAX_NOTIFY_CHARS + 1);

      const dupNotify = await sync.handleNotify({ conversationId: 'conv-1', message: longMsg });
      assert.equal(dupNotify.ok, true);
      assert.equal(dupNotify.deduplicated, true);
      assert.equal(notifications.length, 1);

      const missingConvNotify = await sync.handleNotify({ message: 'no conv' });
      assert.equal(missingConvNotify.ok, false);

      const newConvNotify = await sync.handleNotify({ conversationId: '_new', message: 'new conv' });
      assert.equal(newConvNotify.ok, false);

      // Default agentApiFn path resolves projectId via get-conversation-metadata and surfaces errors
      const apiCalls = [];
      let failSend = true;
      const syncAgentApi = new StateSync({
        sidecarId: 'agentapi-sync',
        agentApiFn: async (args, opts) => {
          apiCalls.push({ args, opts });
          if (args[0] === 'get-conversation-metadata') {
            return { response: { conversationMetadata: { metadata: { projectId: 'proj-99' } } } };
          }
          if (failSend) return { error: 'agentapi send failed' };
          return { ok: true };
        },
      });
      const failedRes = await syncAgentApi.handleNotify({ conversationId: 'conv-77', message: 'Fix error', title: 'Sidecar Error' });
      assert.equal(failedRes.ok, false);
      assert.equal(failedRes.error, 'agentapi send failed');
      // Failed notification must not poison deduplication on retry
      failSend = false;
      const retryRes = await syncAgentApi.handleNotify({ conversationId: 'conv-77', message: 'Fix error', title: 'Sidecar Error' });
      assert.equal(retryRes.ok, true);
      assert.equal(retryRes.deduplicated, false);
      assert.deepEqual(apiCalls[1], {
        args: ['send-message', '--title', 'Sidecar Error', 'conv-77', 'Fix error'],
        opts: { projectId: 'proj-99' },
      });

      // /mcp JSON-RPC 2.0 protocol
      const initRes = await sync.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      assert.equal(initRes.result.serverInfo.name, 'test-sync');

      const listRes = await sync.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(listRes.result.tools.length, 2);
      assert.equal(listRes.result.tools[0].name, 'get_state');
      assert.equal(listRes.result.tools[1].name, 'bump_counter');

      const callRes = await sync.handleMcp({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'bump_counter',
          arguments: { delta: 10 },
          _meta: { [MCP_CONV_META_KEY]: 'conv-1' },
        },
      });
      assert.equal(callRes.result.structuredContent.count, 15);
      assert.equal(sync.getState('conv-1').count, 15);
    } finally {
      sync.dispose();
    }
  });

  it('registerStateSyncRoutes intercepts GET /api/events on SidecarApp HTTP server for live SSE streaming', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-sse-http-'));
    const apis = new Map();
    const fakeApp = {
      api(path, handler) {
        apis.set(path, handler);
      },
      async run() {
        const srv = createServer(async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const handler = apis.get(url.pathname);
          if (!handler) {
            res.writeHead(404).end();
            return;
          }
          const result = await handler({});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
        return srv;
      },
    };

    const sync = registerStateSyncRoutes(fakeApp, {
      sidecarId: 'sse-test',
      dataRoot: dir,
      initialState: () => ({ ready: true, items: 1 }),
    });

    const httpServer = await fakeApp.run();
    try {
      const { port } = httpServer.address();
      assert.equal(existsSync(join(dir, 'sse-test', 'server_info.json')), true);

      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const firstChunk = decoder.decode((await reader.read()).value);
      assert.match(firstChunk, /event: state\ndata: \{"ready":true,"items":1/);

      // Mutating state pushes a second SSE frame to the open stream
      sync.mutate({ items: 2 });
      const secondChunk = decoder.decode((await reader.read()).value);
      assert.match(secondChunk, /event: state\ndata: \{"ready":true,"items":2/);

      ac.abort();
    } finally {
      sync.dispose();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/events rejects unauthenticated SSE requests when ANTIGRAVITY_SIDECAR_UI_TOKEN is set and blocks non-loopback Origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-sse-auth-'));
    const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-token-123';

    const fakeApp = {
      api() {},
      async run() {
        const srv = createServer((_req, res) => res.writeHead(404).end());
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
        return srv;
      },
    };

    const sync = registerStateSyncRoutes(fakeApp, {
      sidecarId: 'sse-auth-test',
      dataRoot: dir,
      initialState: () => ({ ok: true }),
    });
    const httpServer = await fakeApp.run();
    try {
      const { port } = httpServer.address();
      const resNoToken = await fetch(`http://127.0.0.1:${port}/api/events`);
      assert.equal(resNoToken.status, 401);

      const resShortToken = await fetch(`http://127.0.0.1:${port}/api/events?token=short`);
      assert.equal(resShortToken.status, 401);

      const resBadOrigin = await fetch(`http://127.0.0.1:${port}/api/events?token=secret-token-123`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(resBadOrigin.status, 403);

      const ac = new AbortController();
      const resValid = await fetch(`http://127.0.0.1:${port}/api/events?token=secret-token-123`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
        signal: ac.signal,
      });
      assert.equal(resValid.status, 200);
      ac.abort();

      assert.equal(verifySidecarToken('secret-token-123', 'secret-token-123'), true);
      assert.equal(verifySidecarToken('short', 'secret-token-123'), false);
    } finally {
      if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
      sync.dispose();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizeConversationId rejects literal "null" and "undefined" and extractConversationId reads x-sidecar-conversation header', () => {
    assert.equal(sanitizeConversationId('null'), null);
    assert.equal(sanitizeConversationId('undefined'), null);
    assert.equal(sanitizeConversationId('_new'), null);
    assert.equal(sanitizeConversationId('none'), null);
    assert.equal(sanitizeConversationId('a..b'), null);
    assert.equal(
      extractConversationId({ req: { headers: { 'x-sidecar-conversation': 'conv-abc-123' } } }),
      'conv-abc-123'
    );
  });

  it('isStandaloneAgentApiBinary distinguishes agentapi(.exe) from agy/antigravity wrapper and handleNotify falls back to start-conversation', async () => {
    assert.equal(isStandaloneAgentApiBinary('C:\\Users\\arthu\\bin\\agentapi.exe'), true);
    assert.equal(isStandaloneAgentApiBinary('/usr/local/bin/agentapi'), true);
    assert.equal(isStandaloneAgentApiBinary('C:\\Program Files\\Antigravity\\agy.exe'), false);

    const execCalls = [];
    await runAgentApiAsync(['send-message', 'conv-1', 'hello'], {
      exePath: 'C:\\Users\\arthu\\bin\\agentapi.exe',
      execFileFn: (file, args, _opts, cb) => {
        execCalls.push({ file, args });
        cb(null, '{"ok":true}');
      },
    });
    assert.deepEqual(execCalls[0], {
      file: 'C:\\Users\\arthu\\bin\\agentapi.exe',
      args: ['send-message', 'conv-1', 'hello'],
    });

    const fallbackCalls = [];
    const sync = new StateSync({
      sidecarId: 'fallback-sync',
      agentApiFn: async (args) => {
        fallbackCalls.push(args);
        if (args[0] === 'send-message') return { error: 'Cascade expired' };
        return { ok: true };
      },
    });
    try {
      const resNew = await sync.handleNotify({
        conversationId: '_new',
        workspace: '/tmp/ws',
        message: 'Start fresh',
      });
      assert.equal(resNew.ok, true);
      assert.deepEqual(fallbackCalls[0], ['start-conversation', '--workspace', '/tmp/ws', 'Start fresh']);

      const resExpired = await sync.handleNotify({
        conversationId: 'conv-expired',
        workspace: '/tmp/ws',
        message: 'Recover expired',
      });
      assert.equal(resExpired.ok, true);
      assert.deepEqual(fallbackCalls.at(-1), ['start-conversation', '--workspace', '/tmp/ws', 'Recover expired']);
    } finally {
      sync.dispose();
    }
  });

  it('subscribeStateSyncEvents listens to named state and state_changed SSE events', async () => {
    const listeners = new Map();
    let instance = null;
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        instance = this;
      }
      addEventListener(type, fn) {
        listeners.set(type, fn);
      }
      close() {}
    }
    const sandbox = {
      EventSource: FakeEventSource,
      URL,
      URLSearchParams,
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      window: {
        location: { href: 'http://127.0.0.1:5000/?token=t1', search: '?token=t1' },
        matchMedia: () => ({ matches: true }),
      },
      document: { readyState: 'complete', documentElement: { dataset: {}, style: {} } },
    };
    sandbox.window.document = sandbox.document;
    vm.runInNewContext(AGY_CLIENT_JS, sandbox);

    const received = [];
    const sub = sandbox.window.AgyShell.subscribeStateSyncEvents({
      conversationId: 'conv-abc',
      onStateEvent: (state, version) => received.push({ state, version }),
    });
    assert.equal(typeof listeners.get('state'), 'function');
    assert.equal(typeof listeners.get('state_changed'), 'function');
    assert.equal(new URL(instance.url).searchParams.get('conversationId'), 'conv-abc');
    assert.equal(new URL(instance.url).searchParams.get('conversation'), 'conv-abc');
    listeners.get('state')({ data: JSON.stringify({ state: { ready: true }, version: 3 }) });
    assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ state: { ready: true }, version: 3 }]);
    sub.close();
  });

  it('isolates handleNotify deduplication per conversation, honors explicit _new, and enforces auth on mutate/notify/mcp (F-02, F-09)', async () => {
    const sent = [];
    const sync = new StateSync({
      sidecarId: 'dedup-sync',
      app: { config: { conversationId: 'stale-conv-999', workspace: '/app/ws' } },
      notifyAgent: async (msg, meta) => {
        sent.push({ msg, meta });
        return { ok: true };
      },
    });
    try {
      const r1 = await sync.handleNotify({ conversationId: 'conv-a', message: 'Same alert' });
      const r2 = await sync.handleNotify({ conversationId: 'conv-b', message: 'Same alert' });
      assert.equal(r1.deduplicated, false);
      assert.equal(r2.deduplicated, false);
      assert.equal(sent.length, 2);

      // Explicit _new must not fall back to stale app.config.conversationId ('stale-conv-999')
      const rNew = await sync.handleNotify({ conversationId: '_new', message: 'Fresh start' });
      assert.equal(rNew.ok, true);
      assert.equal(sent[2].meta.conversationId, '');
      assert.equal(sent[2].meta.workspace, '/app/ws');

      // Origin and token enforcement on handleMutate, handleNotify, and handleMcp
      const prevTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'tok-sec';
      try {
        const badOriginMut = sync.handleMutate({ x: 1 }, { req: { headers: { origin: 'https://evil.example' } } });
        assert.equal(badOriginMut.ok, false);
        const unauthMut = sync.handleMutate({ x: 1 }, { req: { headers: { origin: 'http://127.0.0.1:8000' } } });
        assert.equal(unauthMut.ok, false);
        const authMut = sync.handleMutate({ x: 1 }, { req: { headers: { origin: 'http://127.0.0.1:8000', 'x-sidecar-token': 'tok-sec' } } });
        assert.equal(authMut.ok, true);

        // ASK-01: Headerless ctx ({} or omitted) must still enforce ANTIGRAVITY_SIDECAR_UI_TOKEN
        const headerlessMut = sync.handleMutate({ x: 2 }, {});
        assert.equal(headerlessMut.ok, false);
        assert.equal(headerlessMut.status, 401);
        const headerlessNotify = await sync.handleNotify({ conversationId: 'conv-a', message: 'unauth' }, {});
        assert.equal(headerlessNotify.ok, false);
        assert.equal(headerlessNotify.status, 401);
        const headerlessMcp = await sync.handleMcp({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, {});
        assert.equal(headerlessMcp.status, 401);
        assert.ok(headerlessMcp.error);

        // Valid token via query or data.token succeeds even when headers are absent
        const queryTokMut = sync.handleMutate({ x: 3 }, { query: { token: 'tok-sec' } });
        assert.equal(queryTokMut.ok, true);
      } finally {
        if (prevTok === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
        else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevTok;
      }
    } finally {
      sync.dispose();
    }
  });

  it('ASK-03: per-conversation StateSync persists to brainDir even when dataDir is empty, honors stateFilename, and sanitizes sidecarId', () => {
    const tmpBrain = mkdtempSync(join(tmpdir(), 'kit-brain-ask03-'));
    const convUuid = '11111111-2222-3333-4444-555555555555';
    const sync = new StateSync({
      sidecarId: '../my-sidecar',
      perConversation: true,
      brainDir: tmpBrain,
      stateFilename: 'custom-state.json',
    });
    try {
      const res = sync.handleMutate({ conversationId: convUuid, count: 42 });
      assert.equal(res.ok, true);
      const scratchPath = join(tmpBrain, convUuid, 'scratch', 'sidecars', sync.sidecarId, 'custom-state.json');
      const dotPath = join(tmpBrain, convUuid, '.sidecar-state', `${sync.sidecarId}.json`);
      assert.equal(existsSync(scratchPath), true, 'must persist to scratch/sidecars/<sidecarId>/<stateFilename>');
      assert.equal(existsSync(dotPath), true, 'must also persist to .sidecar-state/<sidecarId>.json');
      assert.equal(sync.sidecarId.includes('..'), false, 'sidecarId must be sanitized against traversal');
    } finally {
      sync.dispose();
      rmSync(tmpBrain, { recursive: true, force: true });
    }
  });
});
