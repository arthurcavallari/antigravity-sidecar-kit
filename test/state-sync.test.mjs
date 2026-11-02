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
  registerStateSyncRoutes,
  removeServerInfo,
  writeServerInfo,
} from '../lib/state-sync.mjs';

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
});
