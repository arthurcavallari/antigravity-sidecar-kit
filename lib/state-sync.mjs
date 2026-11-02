/** @fileoverview Dual-mode Global & Conversation-Scoped StateSync engine (SSE /api/events, /api/mutate, /api/notify, /mcp). */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { SIDECAR_DATA_ROOT, removeServerInfo, writeJsonAtomic, writeServerInfo } from './config.mjs';

export { removeServerInfo, writeJsonAtomic, writeServerInfo };
export const MCP_CONV_META_KEY = 'antigravity.google/conversation_id';
export const DEFAULT_WATCH_INTERVAL_MS = 300;
export const DEFAULT_IDLE_EVICTION_MS = 60_000;
export const MAX_NOTIFY_CHARS = 4_000;
const DEBOUNCE_MS = 50, [ERR_REQ, ERR_METHOD, ERR_PARAMS, ERR_INTERNAL] = [-32600, -32601, -32602, -32603];
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v), SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const inflightMetadata = new Map();

export function runAgentApiAsync(args = [], { projectId = process.env.ANTIGRAVITY_PROJECT_ID, exePath = process.env.ANTIGRAVITY_AGENTAPI_EXE, timeoutMs = 15_000, execFileFn = execFile } = {}) {
    const isMeta = args[0] === 'get-conversation-metadata' && args[1];
    if (isMeta && inflightMetadata.has(args[1])) return inflightMetadata.get(args[1]);
    const env = { ...process.env, ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}) };
    const file = exePath || 'agentapi', execArgs = exePath ? ['agentapi', ...args] : args;
    const promise = new Promise((resolve) => {
        execFileFn(file, execArgs, { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
            if (err) {
                resolve({ error: err.message || String(err) });
                return;
            }
            const trimmed = String(stdout || '').trim();
            if (!trimmed) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(trimmed));
            } catch {
                resolve({ raw: trimmed });
            }
        });
    }).finally(() => {
        if (isMeta) inflightMetadata.delete(args[1]);
    });
    if (isMeta) inflightMetadata.set(args[1], promise);
    return promise;
}

export function mergeStatePatch(base, patch) {
    if (!isObj(patch)) return structuredClone(patch);
    const next = isObj(base) ? structuredClone(base) : {};
    for (const [k, v] of Object.entries(patch)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (v === null) delete next[k]; else next[k] = mergeStatePatch(next[k], v);
    }
    return next;
}

export function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export function extractConversationId(payload, ctx) {
    for (const src of [payload, payload?.arguments, ctx?.query, payload?.query]) {
        if (!isObj(src)) continue;
        for (const k of ['conversationId', 'conversation_id']) if (typeof src[k] === 'string' && src[k].trim()) return src[k].trim();
    }
    const metaId = isObj(payload?._meta) ? payload._meta[MCP_CONV_META_KEY] : undefined;
    return typeof metaId === 'string' && metaId.trim() ? metaId.trim() : '';
}

const GET_STATE_TOOL = { name: 'get_state', description: "Returns this sidecar's current state and version.", inputSchema: { type: 'object', properties: {} } };

export class StateSync {
    constructor(dataDirOrOptions, app, maybeOptions = {}) {
        const options = isObj(dataDirOrOptions) ? dataDirOrOptions : maybeOptions;
        this.sidecarId = options.sidecarId || options.sidecarName || 'sidecar';
        this.sidecarName = this.sidecarId;
        this.dataDir = typeof dataDirOrOptions === 'string' ? dataDirOrOptions : options.dataDir || (options.dataRoot ? join(options.dataRoot, this.sidecarId) : '');
        this.app = isObj(dataDirOrOptions) ? options.app : app;
        this.ResponseClass = options.ResponseClass || null;
        this.stateFilename = options.stateFilename || 'state.json';
        this.initialStateFn = typeof options.initialState === 'function' ? options.initialState : null;
        const initVal = this.initialStateFn ? this.initialStateFn('') : (options.initialState ?? options.defaultState);
        this.defaultState = isObj(initVal) ? structuredClone(initVal) : {};
        this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
        this.idleEvictionMs = options.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS;
        this.conversationScoped = Boolean(options.conversationScoped ?? options.perConversation);
        this.brainDir = options.brainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
        this.agentApiFn = options.agentApiFn || runAgentApiAsync;
        this.notifyAgentFn = options.notifyAgent || null;
        this.toolRegistry = new Map((options.mcpTools || []).map((t) => {
            const def = t.definition || { name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } };
            return [def.name, { definition: def, handler: t.handler }];
        }));
        this.convStates = new Map();
        this.running = false;
        this.watcher = null;
        this.pollTimer = null;
        this.debounceTimer = null;
        const statePath = this.dataDir ? (isAbsolute(this.stateFilename) ? this.stateFilename : join(this.dataDir, this.stateFilename)) : '';
        this.globalState = this.#createEntry('', statePath);
        if (!this.conversationScoped && statePath) this.#initGlobalState();
    }

    #createEntry(convId, statePath) {
        const seed = this.initialStateFn ? this.initialStateFn(convId) : this.defaultState;
        return {
            convId,
            statePath,
            currentState: structuredClone(isObj(seed) ? seed : {}),
            currentVersion: 0,
            lastMtimeMs: null,
            lastDiskContent: null,
            lastNotification: null,
            lastPollTs: Date.now(),
            sseClients: new Set()
        };
    }

    #initGlobalState() {
        const p = this.globalState.statePath;
        if (existsSync(p)) {
            try {
                const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, ''), parsed = raw.trim() ? JSON.parse(raw) : {};
                this.globalState.lastMtimeMs = statSync(p).mtimeMs;
                this.globalState.lastDiskContent = raw;
                if (isObj(parsed) && Object.keys(parsed).length > 0) {
                    this.globalState.currentState = parsed;
                    this.globalState.currentVersion = deepEqual(parsed, this.defaultState) ? 0 : 1;
                }
            } catch {
            }
        } else if (this.dataDir) {
            try {
                this.#writeEntryFile(this.globalState, this.globalState.currentState);
            } catch {
            }
        }
    }

    #writeEntryFile(entry, state) {
        if (!entry.statePath) return;
        entry.lastDiskContent = writeJsonAtomic(entry.statePath, state);
        entry.lastMtimeMs = statSync(entry.statePath).mtimeMs;
    }

    #resolveScopedEntry(convId, { createParent = true } = {}) {
        const clean = String(convId || '').trim();
        if (!clean || !SAFE_SEGMENT.test(clean)) return null;
        const convDir = join(this.brainDir, clean);
        if (!createParent && !existsSync(convDir)) return null;
        const statePath = this.dataDir ? join(convDir, 'scratch', 'sidecars', this.sidecarName, 'state.json') : '', now = Date.now();
        let entry = this.convStates.get(clean);
        const isNew = !entry, wasIdle = entry && entry.sseClients.size === 0 && now - entry.lastPollTs > this.idleEvictionMs;
        if (!entry) {
            entry = this.#createEntry(clean, statePath);
            this.convStates.set(clean, entry);
        } else entry.lastPollTs = now;
        if (isNew || wasIdle) this.#checkEntryFile(entry, isNew);
        return entry;
    }

    resolveEntry(convId) {
        return this.conversationScoped ? this.#resolveScopedEntry(convId, { createParent: true }) : this.globalState;
    }

    getState(convId = '') {
        const e = this.resolveEntry(convId) || this.globalState;
        return structuredClone(e.currentState);
    }

    mutate(patch, { conversationId = '', replace = false } = {}) {
        return this.applyEntryMutation(this.resolveEntry(conversationId) || this.globalState, patch, { source: 'api', replace })[0];
    }

    start() {
        if (this.running) return this;
        this.running = true;
        if (!this.conversationScoped && this.globalState.statePath) {
            this.#checkEntryFile(this.globalState, false);
            const watchDir = dirname(this.globalState.statePath), targetBase = this.globalState.statePath.split(/[\\/]/).pop();
            try {
                mkdirSync(watchDir, { recursive: true });
                this.watcher = watch(watchDir, (_, filename) => {
                    if (!filename || filename === targetBase) {
                        if (this.debounceTimer) clearTimeout(this.debounceTimer);
                        this.debounceTimer = setTimeout(() => this.#checkEntryFile(this.globalState, true), DEBOUNCE_MS);
                        this.debounceTimer.unref?.();
                    }
                });
                this.watcher.unref?.();
                this.watcher.on('error', () => {
                });
            } catch {
            }
        }
        this.pollTimer = setInterval(() => {
            const now = Date.now();
            if (!this.conversationScoped) this.#checkEntryFile(this.globalState, false);
            for (const [id, entry] of this.convStates.entries()) {
                if (entry.sseClients.size === 0 && now - entry.lastPollTs > this.idleEvictionMs) this.convStates.delete(id);
                else this.#checkEntryFile(entry, false);
            }
        }, this.watchIntervalMs);
        this.pollTimer.unref?.();
        return this;
    }

    stop() {
        this.running = false;
        try {
            this.watcher?.close();
        } catch {
        }
        this.watcher = null;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        for (const c of this.globalState.sseClients) {
            try {
                c.end();
            } catch {
            }
        }
        this.globalState.sseClients.clear();
        for (const e of this.convStates.values()) {
            for (const c of e.sseClients) {
                try {
                    c.end();
                } catch {
                }
            }
            e.sseClients.clear();
        }
        this.convStates.clear();
    }

    dispose() {
        this.stop();
    }

    #checkEntryFile(entry, force = false) {
        if (!this.running && !force) return;
        const p = entry.statePath;
        if (!p || !existsSync(p)) return;
        try {
            const mtime = statSync(p).mtimeMs;
            if (!force && mtime === entry.lastMtimeMs) return;
            const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
            if (!raw.trim()) return;
            if (force || mtime !== entry.lastMtimeMs || raw !== entry.lastDiskContent) {
                const parsed = JSON.parse(raw);
                this.applyEntryMutation(entry, isObj(parsed) ? parsed : { data: parsed }, { source: 'watcher', replace: true });
                entry.lastMtimeMs = mtime;
                entry.lastDiskContent = raw;
            }
        } catch {
        }
    }

    applyEntryMutation(entry, patch, { source = 'frontend', replace = false } = {}) {
        if (source !== 'watcher') this.#checkEntryFile(entry, false);
        const { conversationId: _a, conversation_id: _b, ...clean } = isObj(patch) ? patch : {};
        const next = replace ? structuredClone(clean) : mergeStatePatch(entry.currentState, clean);
        if (!deepEqual(next, entry.currentState)) {
            if (source !== 'watcher') this.#writeEntryFile(entry, next);
            entry.currentState = next;
            entry.currentVersion += 1;
            this.broadcastEntryState(entry);
            if (source !== 'frontend') entry.lastNotification = null;
        }
        return [structuredClone(entry.currentState), entry.currentVersion];
    }

    formatSseEvent(entry) {
        return `event: state\ndata: ${JSON.stringify({ ...entry.currentState, _version: entry.currentVersion, version: entry.currentVersion, state: entry.currentState })}\n\n`;
    }

    broadcastEntryState(entry) {
        if (entry.sseClients.size === 0) return;
        const payload = this.formatSseEvent(entry);
        for (const res of entry.sseClients) {
            if (res.writableEnded || res.destroyed) {
                entry.sseClients.delete(res);
                continue;
            }
            try {
                res.write(payload);
            } catch {
                entry.sseClients.delete(res);
            }
        }
    }

    #reply(obj, status = 200) {
        return this.ResponseClass ? new this.ResponseClass(JSON.stringify(obj), { contentType: 'application/json', status }) : obj;
    }

    handleEvents(data, ctx = {}) {
        const res = ctx?.res;
        if (!res) return this.#reply({ error: 'SSE requires ServerResponse stream' }, 400);
        const entry = this.resolveEntry(extractConversationId(data, ctx));
        if (!entry) return this.#reply({ error: 'Invalid or missing conversationId' }, 400);
        res.socket?.setNoDelay?.(true);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(this.formatSseEvent(entry));
        entry.sseClients.add(res);
        const cleanup = () => {
            entry.sseClients.delete(res);
            entry.lastPollTs = Date.now();
        };
        res.once('close', cleanup);
        res.once('error', cleanup);
    }

    handleMutate(data, ctx = {}) {
        if (!isObj(data)) return this.#reply({ ok: false, error: 'Payload must be a JSON object' }, 400);
        const convId = extractConversationId(data, ctx), entry = this.resolveEntry(convId);
        if (!entry) return this.#reply({ ok: false, error: `Missing or unknown conversationId (${convId})` }, 400);
        const payload = isObj(data.patch) ? data.patch : data;
        const [state, version] = this.applyEntryMutation(entry, payload, { source: 'frontend', replace: Boolean(data.replace) });
        return this.#reply({ ok: true, version, state });
    }

    async handleNotify(data, ctx = {}) {
        if (!isObj(data) || typeof data.message !== 'string' || !data.message.trim()) return this.#reply({ ok: false, error: 'message must be a non-empty string' }, 400);
        const rawMsg = data.message.trim(), truncated = rawMsg.length > MAX_NOTIFY_CHARS, msg = truncated ? `${rawMsg.slice(0, MAX_NOTIFY_CHARS)}\u2026` : rawMsg;
        const rawConv = extractConversationId(data, ctx) || this.app?.config?.conversationId || '', convId = rawConv && rawConv !== '_new' ? rawConv : '';
        if (!convId || !SAFE_SEGMENT.test(convId)) return this.#reply({ ok: false, error: 'Missing or invalid conversationId' }, 400);
        const entry = this.resolveEntry(convId) || this.globalState, isDuplicate = entry.lastNotification === msg;
        if (!isDuplicate) {
            const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Sidecar State';
            let res;
            if (this.notifyAgentFn) res = await this.notifyAgentFn(msg, { conversationId: convId, title });
            else {
                let projectId = data.projectId || this.app?.config?.projectId || '';
                if (!projectId) {
                    const m = await this.agentApiFn(['get-conversation-metadata', convId]);
                    const meta = (m?.response?.conversationMetadata || m?.response?.conversation_metadata)?.metadata;
                    projectId = meta?.projectId || meta?.project_id || '';
                }
                res = await this.agentApiFn(['send-message', '--title', title, convId, msg], { projectId });
            }
            if (res?.error) return this.#reply({ ok: false, error: String(res.error) }, 502);
            entry.lastNotification = msg;
        }
        return this.#reply({ ok: true, truncated, deduplicated: isDuplicate });
    }

    async handleMcp(data, ctx = {}) {
        if (!isObj(data)) return this.#reply({ jsonrpc: '2.0', id: null, error: { code: ERR_REQ, message: 'Invalid Request' } }, 400);
        const id = data.id ?? null, method = typeof data.method === 'string' ? data.method : '', params = isObj(data.params) ? data.params : {};
        if (method === 'notifications/initialized') return this.#reply({ jsonrpc: '2.0', id, result: {} });
        if (method === 'initialize') return this.#reply({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: this.sidecarName, version: '1.0.0' } }
        });
        if (method === 'tools/list') return this.#reply({ jsonrpc: '2.0', id, result: { tools: [GET_STATE_TOOL, ...[...this.toolRegistry.values()].map((t) => t.definition)] } });
        if (method !== 'tools/call') return this.#reply({ jsonrpc: '2.0', id, error: { code: ERR_METHOD, message: `Method not found: ${method}` } });
        const convId = extractConversationId(params, ctx) || this.app?.config?.conversationId || '', entry = this.resolveEntry(convId) || this.globalState;
        if (this.conversationScoped && !convId) return this.#reply({ jsonrpc: '2.0', id, error: { code: ERR_PARAMS, message: 'Missing conversationId' } });
        const name = typeof params.name === 'string' ? params.name : '';
        if (name === GET_STATE_TOOL.name) return this.#reply({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify({ version: entry.currentVersion, state: entry.currentState }) }] }
        });
        const tool = this.toolRegistry.get(name);
        if (!tool) return this.#reply({ jsonrpc: '2.0', id, error: { code: ERR_METHOD, message: `Unknown tool: ${name}` } });
        try {
            const out = await tool.handler(isObj(params.arguments) ? params.arguments : {}, { currentState: structuredClone(entry.currentState), conversationId: convId, sync: this });
            if (out?.error) return this.#reply({ jsonrpc: '2.0', id, error: out.error });
            if (out?.patch) this.applyEntryMutation(entry, out.patch, { source: 'mcp' });
            const structured = out?.result ?? out ?? { ok: true };
            return this.#reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
        } catch (err) {
            return this.#reply({ jsonrpc: '2.0', id, error: { code: ERR_INTERNAL, message: err?.message || String(err) } });
        }
    }
}

export function registerStateSyncRoutes(app, options = {}) {
    const sidecarId = options.sidecarId || options.sidecarName || 'sidecar';
    const dataDir = options.dataDir || (options.dataRoot ? join(options.dataRoot, sidecarId) : join(SIDECAR_DATA_ROOT, sidecarId));
    const sync = new StateSync(dataDir, app, { ...options, sidecarId, dataDir });
    app.api('/api/events', (data, ctx) => sync.handleEvents(data, ctx), 'GET');
    app.api('/api/mutate', (data, ctx) => sync.handleMutate(data, ctx), 'POST');
    app.api('/api/notify', (data, ctx) => sync.handleNotify(data, ctx), 'POST');
    app.api('/mcp', (data, ctx) => sync.handleMcp(data, ctx), 'POST');
    const attachHttpServer = (server) => {
        if (!server || server._stateSyncAttached) return server;
        server._stateSyncAttached = true;
        const listeners = server.listeners('request');
        server.removeAllListeners('request');
        server.on('request', (req, res) => {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            if (req.method === 'GET' && url.pathname === '/api/events') {
                const query = Object.fromEntries(url.searchParams.entries());
                sync.handleEvents(query, { req, res, query });
                return;
            }
            for (const fn of listeners) fn.call(server, req, res);
        });
        const port = server.address?.()?.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
        if (dataDir && port) {
            try {
                writeServerInfo(dataDir, { port, token: process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null });
            } catch {
            }
        }
        sync.start();
        return server;
    };
    if (typeof app.run === 'function') {
        const origRun = app.run.bind(app);
        app.run = async (...args) => attachHttpServer(await origRun(...args));
    }
    sync.onServerStarted = (target) => attachHttpServer(target?.getHttpServer?.() || target);
    const origStop = sync.stop.bind(sync);
    sync.stop = () => {
        origStop();
        if (dataDir) removeServerInfo(dataDir);
    };
    return sync;
}
