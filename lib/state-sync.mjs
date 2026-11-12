/** @fileoverview Dual-mode Global & Conversation-Scoped StateSync engine (SSE /api/events, /api/mutate, /api/notify, /mcp). */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SIDECAR_DATA_ROOT, readJsonSafe, removeServerInfo, writeJsonAtomic, writeServerInfo } from './config.mjs';

export { removeServerInfo, writeJsonAtomic, writeServerInfo };
const activeRequestStore = new AsyncLocalStorage();
export function getCurrentRequestContext() {
    return activeRequestStore.getStore() || null;
}
export function runWithRequestContext(ctx, fn) {
    return activeRequestStore.run(ctx, fn);
}
export const MCP_CONV_META_KEY = 'antigravity.google/conversation_id';
export const DEFAULT_WATCH_INTERVAL_MS = 300;
export const DEFAULT_IDLE_EVICTION_MS = 60_000;
export const MAX_NOTIFY_CHARS = 4_000;
const DEBOUNCE_MS = 50;
const [ERR_REQ, ERR_METHOD, ERR_PARAMS, ERR_INTERNAL] = [-32600, -32601, -32602, -32603];
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const INVALID_CONV_IDS = new Set(['_new', 'null', 'undefined', 'none']);
const inflightMetadata = new Map();

export function isStandaloneAgentApiBinary(exePath) {
    if (typeof exePath !== 'string' || !exePath.trim()) return false;
    const base = exePath.trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
    return base === 'agentapi' || base === 'agentapi.exe';
}

export function verifySidecarToken(providedToken, expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '') {
    const expected = typeof expectedToken === 'string' ? expectedToken : '';
    if (!expected) return true;
    if (typeof providedToken !== 'string' || !providedToken) return false;
    const a = Buffer.from(providedToken, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const digestA = createHash('sha256').update(a).digest();
    const digestB = createHash('sha256').update(b).digest();
    return timingSafeEqual(digestA, digestB) && a.byteLength === b.byteLength;
}

export function isLoopbackOrigin(origin) {
    if (origin === undefined || origin === null || origin === '') return true;
    if (typeof origin !== 'string') return false;
    try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const h = u.hostname.toLowerCase();
        return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch {
        return false;
    }
}

function resolveAgentWorkspaceCwd(rawWorkspace) {
    if (typeof rawWorkspace !== 'string' || !rawWorkspace.trim()) return '';
    let candidate = rawWorkspace.trim();
    if (candidate.startsWith('file://')) {
        try {
            candidate = fileURLToPath(candidate);
        } catch {
            return '';
        }
    }
    try {
        return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : '';
    } catch {
        return '';
    }
}

export function runAgentApiAsync(
    args = [],
    {
        projectId = process.env.ANTIGRAVITY_PROJECT_ID,
        exePath = process.env.ANTIGRAVITY_AGENTAPI_EXE,
        workspace = '',
        cwd = '',
        timeoutMs = 15_000,
        execFileFn = execFile,
    } = {}
) {
    const isMeta = args[0] === 'get-conversation-metadata' && args[1];
    if (isMeta && inflightMetadata.has(args[1])) return inflightMetadata.get(args[1]);
    const env = { ...process.env, ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}) };
    const resolvedCwd = resolveAgentWorkspaceCwd(cwd || workspace);
    const file = exePath || 'agentapi';
    const execArgs = exePath && !isStandaloneAgentApiBinary(exePath) ? ['agentapi', ...args] : args;
    const execOpts = {
        encoding: 'utf8',
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
    };
    const promise = new Promise((resolve) => {
        execFileFn(file, execArgs, execOpts, (err, stdout) => {
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
        if (v === null) {
            delete next[k];
        } else {
            next[k] = mergeStatePatch(next[k], v);
        }
    }
    return next;
}

export function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export const runAgentApi = runAgentApiAsync;

export function sanitizeConversationId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || INVALID_CONV_IDS.has(trimmed.toLowerCase()) || trimmed.includes('..')) return null;
    return SAFE_SEGMENT.test(trimmed) ? trimmed : null;
}

export function extractConversationId(payload, ctx) {
    for (const q of [ctx?.query, payload?.query]) {
        if (typeof q?.get === 'function') {
            for (const k of ['conversationId', 'conversation_id', 'conversation', 'cid']) {
                const v = sanitizeConversationId(q.get(k));
                if (v) return v;
            }
        }
    }
    for (const src of [payload, payload?.arguments, ctx?.query, payload?.query, ctx?.body, payload?.body]) {
        if (!isObj(src)) continue;
        for (const k of ['conversationId', 'conversation_id', 'conversation', 'cid']) {
            const v = sanitizeConversationId(src[k]);
            if (v) return v;
        }
    }
    const headers = ctx?.req?.headers || ctx?.headers || payload?.req?.headers || payload?.headers;
    const rawHeaderVal = headers?.['x-sidecar-conversation'] ?? headers?.['X-Sidecar-Conversation'];
    const headerVal = Array.isArray(rawHeaderVal) ? rawHeaderVal[0] : rawHeaderVal;
    if (headerVal !== undefined) {
        const v = sanitizeConversationId(String(headerVal));
        if (v) return v;
    }
    const metaObj = isObj(payload?._meta) ? payload._meta : isObj(ctx?._meta) ? ctx._meta : null;
    if (metaObj) {
        const v = sanitizeConversationId(metaObj[MCP_CONV_META_KEY]);
        if (v) return v;
    }
    return null;
}

function safeParseUrl(rawUrl) {
    try {
        return new URL(typeof rawUrl === 'string' && rawUrl ? rawUrl : '/', 'http://127.0.0.1');
    } catch {
        return new URL('/', 'http://127.0.0.1');
    }
}

const GET_STATE_TOOL = { name: 'get_state', description: "Returns this sidecar's current state and version.", inputSchema: { type: 'object', properties: {} } };

export class StateSync {
    constructor(dataDirOrOptions, app, maybeOptions = {}) {
        const options = isObj(dataDirOrOptions) ? dataDirOrOptions : maybeOptions;
        const rawId = String(options.sidecarId || options.sidecarName || 'sidecar').trim();
        this.sidecarId = rawId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'sidecar';
        this.sidecarName = this.sidecarId;
        this.dataDir = typeof dataDirOrOptions === 'string' ? dataDirOrOptions : options.dataDir || (options.dataRoot ? join(options.dataRoot, this.sidecarId) : '');
        this.hasBrainPersistence = Boolean(this.dataDir || options.brainDir);
        this.uiAuthToken = options.uiAuthToken ?? options.uiToken ?? options.authToken ?? '';
        this.disableAuth = Boolean(options.disableAuth);
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
        this.mutators = isObj(options.mutators) ? options.mutators : null;
        this.resolveConversationFn = typeof options.resolveConversation === 'function' ? options.resolveConversation : null;
        this.toolRegistry = new Map((options.mcpTools || []).map((t) => {
            const def = t.definition || { name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } };
            return [def.name, { definition: def, handler: t.handler }];
        }));
        this.convStates = new Map();
        this.running = false;
        this.watcher = null;
        this.pollTimer = null;
        this.debounceTimer = null;
        this.persistOnInit = options.persistOnInit !== false;
        const statePath = this.dataDir ? (isAbsolute(this.stateFilename) ? this.stateFilename : join(this.dataDir, this.stateFilename)) : '';
        this.globalState = this.#createEntry('', statePath);
        if (!this.conversationScoped && statePath) this.#initGlobalState();
    }

    #createEntry(convId, statePath, altPath = '') {
        const seed = this.initialStateFn ? this.initialStateFn(convId) : this.defaultState;
        return {
            convId,
            statePath,
            altPath,
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
                const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
                const parsed = raw.trim() ? JSON.parse(raw) : {};
                this.globalState.lastMtimeMs = statSync(p).mtimeMs;
                this.globalState.lastDiskContent = raw;
                if (isObj(parsed) && Object.keys(parsed).length > 0) {
                    this.globalState.currentState = parsed;
                    this.globalState.currentVersion = deepEqual(parsed, this.defaultState) ? 0 : 1;
                }
            } catch {
            }
        } else if (this.dataDir && this.persistOnInit) {
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
        const clean = sanitizeConversationId(convId);
        if (!clean) return null;
        const convDir = join(this.brainDir, clean);
        if (!createParent && !existsSync(convDir)) return null;
        const safeFile = isAbsolute(this.stateFilename) ? 'state.json' : (this.stateFilename.replace(/[/\\]/g, '_').replace(/\.{2,}/g, '_') || 'state.json');
        const statePath = this.hasBrainPersistence ? join(convDir, 'scratch', 'sidecars', this.sidecarName, safeFile) : '';
        const altPath = this.hasBrainPersistence ? join(convDir, '.sidecar-state', `${this.sidecarName}.json`) : '';
        const now = Date.now();
        let entry = this.convStates.get(clean);
        const isNew = !entry;
        const wasIdle = entry && entry.sseClients.size === 0 && now - entry.lastPollTs > this.idleEvictionMs;
        if (!entry) {
            entry = this.#createEntry(clean, statePath, altPath);
            this.convStates.set(clean, entry);
        } else {
            entry.lastPollTs = now;
        }
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

    refresh(convId = '') {
        const entry = this.resolveEntry(convId);
        if (entry) this.#checkEntryFile(entry, true);
        return structuredClone((entry || this.globalState).currentState);
    }

    mutate(actionOrPatch, optsOrPayload = {}) {
        if (typeof actionOrPatch === 'string' && this.mutators) {
            const fn = Object.hasOwn(this.mutators, actionOrPatch) ? this.mutators[actionOrPatch] : null;
            if (typeof fn !== 'function') throw new Error(`Unknown mutation action: ${actionOrPatch}`);
            return Promise.resolve()
                .then(() => fn(optsOrPayload || {}))
                .then((result) => {
                    const convId = extractConversationId(optsOrPayload) || '';
                    const entry = this.resolveEntry(convId) || this.globalState;
                    this.#checkEntryFile(entry, false);
                    const prev = isObj(entry.currentState) ? structuredClone(entry.currentState) : {};
                    const lastMutationAt = Math.max(Date.now(), (Number(prev.lastMutationAt) || 0) + 1);
                    const [state] = this.applyEntryMutation(
                        entry,
                        { ...prev, lastMutationAt, lastAction: actionOrPatch, result },
                        { source: 'api', replace: true }
                    );
                    return { ...state, result };
                });
        }
        const { conversationId = '', replace = false } = isObj(optsOrPayload) ? optsOrPayload : {};
        return this.applyEntryMutation(this.resolveEntry(conversationId) || this.globalState, actionOrPatch, { source: 'api', replace })[0];
    }

    start() {
        if (this.running) return this;
        this.running = true;
        if (!this.conversationScoped && this.globalState.statePath) {
            this.#checkEntryFile(this.globalState, false);
            const watchDir = dirname(this.globalState.statePath);
            const targetBase = this.globalState.statePath.split(/[\\/]/).pop();
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
        const p =
            entry.statePath && existsSync(entry.statePath)
                ? entry.statePath
                : entry.altPath && existsSync(entry.altPath)
                  ? entry.altPath
                  : '';
        if (!p) return;
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
        if (this.ResponseClass) {
            return new this.ResponseClass(JSON.stringify(obj), { contentType: 'application/json', status });
        }
        if (status !== 200 && isObj(obj) && obj.status === undefined) {
            Object.defineProperty(obj, 'status', { value: status, enumerable: false, configurable: true, writable: true });
        }
        return obj;
    }

    #resolveCtx(ctx) {
        return (ctx && (ctx.req || ctx.res || ctx.headers || ctx.query || ctx.url)) ? ctx : (activeRequestStore.getStore() || ctx || {});
    }

    handleSse(req, res, urlObj) {
        const parsedUrl = urlObj instanceof URL ? urlObj : safeParseUrl(req?.url);
        const query = Object.fromEntries(parsedUrl.searchParams.entries());
        return this.handleEvents(query, { req, res, query });
    }

    handleEvents(data, rawCtx = {}) {
        const ctx = this.#resolveCtx(rawCtx);
        const req = ctx?.req;
        const res = ctx?.res;
        if (!res) return this.#reply({ error: 'SSE requires ServerResponse stream' }, 400);
        const headers = req?.headers || ctx?.headers;
        const origin = headers?.origin;
        if (!isLoopbackOrigin(origin)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Forbidden origin' }));
            return this.#reply({ error: 'Forbidden origin' }, 403);
        }
        const expectedToken = this.uiAuthToken || process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
        if (expectedToken) {
            const reqUrl = req?.url || (typeof ctx?.url === 'string' ? ctx.url : '');
            const urlToken =
                ctx?.query?.token ??
                ctx?.query?.get?.('token') ??
                data?.token ??
                (reqUrl ? safeParseUrl(reqUrl).searchParams.get('token') : '') ??
                '';
            const rawHeaderTok = headers?.['x-sidecar-token'] ?? headers?.['X-Sidecar-Token'];
            const headerToken = (Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : rawHeaderTok) || '';
            const provided = String(headerToken || urlToken || '');
            if (!verifySidecarToken(provided, expectedToken)) {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Unauthorized SSE connection' }));
                return this.#reply({ error: 'Unauthorized SSE connection' }, 401);
            }
        }
        const entry = this.resolveEntry(extractConversationId(data, ctx));
        if (!entry) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid or missing conversationId' }));
            return this.#reply({ error: 'Invalid or missing conversationId' }, 400);
        }
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

    #checkRequestAuth(data, rawCtx = {}) {
        if (this.disableAuth) return null;
        const ctx = this.#resolveCtx(rawCtx);
        const headers = ctx?.req?.headers || ctx?.headers || data?.headers;
        if (headers && !isLoopbackOrigin(headers.origin)) {
            return { ok: false, status: 403, error: 'Forbidden origin' };
        }
        const expectedToken = this.uiAuthToken || process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
        if (expectedToken) {
            const reqUrl = ctx?.req?.url || (typeof ctx?.url === 'string' ? ctx.url : '');
            const urlToken =
                ctx?.query?.token ??
                ctx?.query?.get?.('token') ??
                data?.token ??
                (reqUrl ? safeParseUrl(reqUrl).searchParams.get('token') : '') ??
                '';
            const rawHeaderTok = headers?.['x-sidecar-token'] ?? headers?.['X-Sidecar-Token'];
            const headerTok = Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : rawHeaderTok;
            const provided = String(headerTok || urlToken || '');
            if (!verifySidecarToken(provided, expectedToken)) {
                return { ok: false, status: 401, error: 'Unauthorized' };
            }
        }
        return null;
    }

    checkAuth(data, rawCtx = {}) {
        return this.#checkRequestAuth(data, this.#resolveCtx(rawCtx));
    }

    handleMutate(data, rawCtx = {}) {
        const ctx = this.#resolveCtx(rawCtx);
        const authErr = this.#checkRequestAuth(data, ctx);
        if (authErr) return this.#reply({ ok: false, error: authErr.error }, authErr.status);
        if (!isObj(data)) return this.#reply({ ok: false, error: 'Payload must be a JSON object' }, 400);
        if (typeof data.action === 'string' && this.mutators) {
            if (!Object.hasOwn(this.mutators, data.action) || typeof this.mutators[data.action] !== 'function') {
                return this.#reply({ ok: false, error: `Unknown mutation action: ${data.action}` }, 400);
            }
            const convId = extractConversationId(data, ctx) || '';
            const rawPayload = isObj(data.payload) ? data.payload : {};
            const payload = convId && !rawPayload.conversationId ? { ...rawPayload, conversationId: convId } : rawPayload;
            return Promise.resolve()
                .then(() => this.mutate(data.action, payload))
                .then((state) => {
                    const entry = this.resolveEntry(convId) || this.globalState;
                    return this.#reply({ ok: true, version: entry.currentVersion, state, result: state?.result });
                })
                .catch((err) => this.#reply({ ok: false, error: String(err?.message || err) }, 500));
        }
        const convId = extractConversationId(data, ctx) || '';
        const entry = this.resolveEntry(convId);
        if (!entry) return this.#reply({ ok: false, error: `Missing or unknown conversationId (${convId})` }, 400);
        const payload = isObj(data.patch) ? data.patch : data;
        const [state, version] = this.applyEntryMutation(entry, payload, { source: 'frontend', replace: Boolean(data.replace) });
        return this.#reply({ ok: true, version, state });
    }

    async handleNotify(data, rawCtx = {}) {
        const ctx = this.#resolveCtx(rawCtx);
        const authErr = this.#checkRequestAuth(data, ctx);
        if (authErr) return this.#reply({ ok: false, error: authErr.error }, authErr.status);
        if (!isObj(data) || typeof data.message !== 'string' || !data.message.trim()) return this.#reply({ ok: false, error: 'message must be a non-empty string' }, 400);
        const rawMsg = data.message.trim();
        const truncated = rawMsg.length > MAX_NOTIFY_CHARS;
        const msg = truncated ? `${rawMsg.slice(0, MAX_NOTIFY_CHARS)}\u2026` : rawMsg;
        const resolvedConv = this.resolveConversationFn ? await this.resolveConversationFn(data, ctx) : '';
        const rawExplicitConv = resolvedConv || (data.conversationId ?? data.conversation_id ?? data.conversation ?? data.cid);
        const explicitNew = typeof rawExplicitConv === 'string' && rawExplicitConv.trim().toLowerCase() === '_new';
        const convId = explicitNew
            ? ''
            : sanitizeConversationId(resolvedConv) ||
              extractConversationId(data, ctx) ||
              sanitizeConversationId(this.app?.config?.conversationId) ||
              '';
        const rawWs = typeof data.workspace === 'string' && data.workspace.trim() ? data.workspace.trim() : (typeof this.app?.config?.workspace === 'string' ? this.app.config.workspace.trim() : '');
        const workspace = rawWs && !rawWs.startsWith('-') ? rawWs : '';
        if (!convId && !workspace) return this.#reply({ ok: false, error: 'Missing or invalid conversationId' }, 400);
        const dedupKey = `${convId || 'ws:' + workspace}\0${msg}`;
        const entry = (convId ? this.resolveEntry(convId) : null) || this.globalState;
        const isDuplicate = entry.lastNotification === dedupKey;
        if (!isDuplicate) {
            const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Sidecar State';
            const severity = String(data.severity || 'info');
            const triggerTurn = data.triggerTurn !== false;
            let res;
            if (this.notifyAgentFn) {
                res = await this.notifyAgentFn(msg, { conversationId: convId, workspace, title, severity, triggerTurn });
            } else {
                let projectId = data.projectId || this.app?.config?.projectId || '';
                const safeTitle = title.startsWith('-') ? '' : title;
                const sendArgs = [
                    'send-message',
                    ...(safeTitle ? ['--title', safeTitle] : []),
                    ...(msg.startsWith('-') ? ['--', convId, msg] : [convId, msg]),
                ];
                const startArgs = [
                    'new-conversation',
                    ...(safeTitle ? ['--title', safeTitle] : []),
                    ...(msg.startsWith('-') ? ['--', msg] : [msg]),
                ];
                const startOpts = { projectId, ...(workspace ? { workspace } : {}) };
                if (convId) {
                    if (!projectId) {
                        const m = await this.agentApiFn(['get-conversation-metadata', convId]);
                        const meta = (m?.response?.conversationMetadata || m?.response?.conversation_metadata)?.metadata;
                        projectId = meta?.projectId || meta?.project_id || '';
                        startOpts.projectId = projectId;
                    }
                    res = await this.agentApiFn(sendArgs, { projectId });
                    if (res?.error && workspace) {
                        res = await this.agentApiFn(startArgs, startOpts);
                    }
                } else {
                    res = await this.agentApiFn(startArgs, startOpts);
                }
            }
            if (res?.error) return this.#reply({ ok: false, error: String(res.error) }, 502);
            entry.lastNotification = dedupKey;
        }
        return this.#reply({ ok: true, truncated, deduplicated: isDuplicate });
    }

    async handleMcp(data, rawCtx = {}) {
        const ctx = this.#resolveCtx(rawCtx);
        const authErr = this.#checkRequestAuth(data, ctx);
        if (authErr) return this.#reply({ jsonrpc: '2.0', id: data?.id ?? null, error: { code: ERR_REQ, message: authErr.error } }, authErr.status);
        if (!isObj(data)) return this.#reply({ jsonrpc: '2.0', id: null, error: { code: ERR_REQ, message: 'Invalid Request' } }, 400);
        const id = data.id ?? null;
        const method = typeof data.method === 'string' ? data.method : '';
        const params = isObj(data.params) ? data.params : {};
        if (method === 'notifications/initialized' || method.startsWith('notifications/')) return this.#reply({ jsonrpc: '2.0', id, result: {} });
        if (method === 'ping') return this.#reply({ jsonrpc: '2.0', id, result: {} });
        if (method === 'initialize') return this.#reply({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: this.sidecarName, version: '1.0.0' } }
        });
        if (method === 'tools/list') return this.#reply({ jsonrpc: '2.0', id, result: { tools: [GET_STATE_TOOL, ...[...this.toolRegistry.values()].map((t) => t.definition)] } });
        if (method !== 'tools/call') return this.#reply({ jsonrpc: '2.0', id, error: { code: ERR_METHOD, message: `Method not found: ${method}` } });
        const convId = extractConversationId(params, ctx) || this.app?.config?.conversationId || '';
        const entry = this.resolveEntry(convId) || this.globalState;
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
    const resolvedUiToken = options.uiAuthToken ?? options.uiToken ?? options.authToken ?? app?.uiToken ?? '';
    const sync = new StateSync(dataDir, app, { ...options, sidecarId, dataDir, uiAuthToken: resolvedUiToken });
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
            const url = safeParseUrl(req?.url);
            const query = Object.fromEntries(url.searchParams.entries());
            const ctx = { req, res, headers: req.headers, url: req.url, query };
            if (req.method === 'GET' && url.pathname === '/api/events') {
                activeRequestStore.run(ctx, () => sync.handleEvents(query, ctx));
                return;
            }
            if (typeof req.emit === 'function') {
                const origEmit = req.emit.bind(req);
                req.emit = (...a) => activeRequestStore.run(ctx, () => origEmit(...a));
            }
            activeRequestStore.run(ctx, () => {
                for (const fn of listeners) fn.call(server, req, res);
            });
        });
        const port = server.address?.()?.port || Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
        if (dataDir && port) {
            try {
                const infoToken = sync.uiAuthToken || app?.uiToken || process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || null;
                writeServerInfo(dataDir, { port, token: infoToken });
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function startStdioMcpBridge(options = {}) {
    const rawId = String(options.sidecarId || options.sidecarName || 'sidecar').trim();
    const sidecarId = rawId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'sidecar';
    const rawPlugin = typeof options.pluginName === 'string' ? options.pluginName.trim() : '';
    const pluginName = rawPlugin && SAFE_SEGMENT.test(rawPlugin) && !rawPlugin.includes('..') ? rawPlugin : '';
    const dataRoot = options.dataRoot || SIDECAR_DATA_ROOT;
    const primaryDataDir = options.dataDir || join(dataRoot, sidecarId);
    const pluginDataDir = pluginName ? join(dataRoot, pluginName, sidecarId, 'data') : '';
    const mcpPath = typeof options.mcpPath === 'string' && options.mcpPath.startsWith('/') ? options.mcpPath : '/mcp';
    const forwardTimeoutMs = Number(options.forwardTimeoutMs) > 0 ? Number(options.forwardTimeoutMs) : 2000;
    const fetchFn = options.fetchFn || globalThis.fetch;
    const input = options.input || process.stdin;
    const output = options.output || process.stdout;
    const exitOnClose = Boolean(options.exitOnClose);

    const infoCandidates = options.serverInfoPath
        ? [options.serverInfoPath]
        : [
              join(primaryDataDir, 'server_info.json'),
              join(primaryDataDir, 'data', 'server_info.json'),
              ...(pluginName
                  ? [
                        join(dataRoot, pluginName, sidecarId, 'server_info.json'),
                        join(pluginDataDir, 'server_info.json'),
                    ]
                  : []),
          ];

    let offlineSync = null;
    const pluginRootDir = pluginName ? join(dataRoot, pluginName, sidecarId) : '';
    const getOfflineSync = () => {
        if (offlineSync) return offlineSync;
        const resolvedDir = options.dataDir
            ? primaryDataDir
            : pluginName
              ? existsSync(pluginDataDir)
                  ? pluginDataDir
                  : existsSync(pluginRootDir)
                    ? pluginRootDir
                    : existsSync(primaryDataDir)
                      ? primaryDataDir
                      : pluginDataDir
              : primaryDataDir;
        offlineSync = new StateSync(resolvedDir, null, {
            ...options,
            sidecarId,
            dataDir: resolvedDir,
            uiAuthToken: '',
            disableAuth: true,
            persistOnInit: false,
        });
        return offlineSync;
    };

    const readLiveServerInfo = () => {
        for (const p of infoCandidates) {
            if (!existsSync(p)) continue;
            const info = readJsonSafe(p, null);
            if (!isObj(info)) continue;
            const port = Number(info.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
            const rawHost = typeof info.host === 'string' && info.host.trim() ? info.host.trim().toLowerCase() : '127.0.0.1';
            if (!LOOPBACK_HOSTS.has(rawHost)) continue;
            const urlHost = rawHost === '::1' ? '[::1]' : rawHost;
            return { urlHost, port, token: typeof info.token === 'string' ? info.token : '' };
        }
        return null;
    };

    const tryForwardOnline = async (rpcRequest) => {
        const live = readLiveServerInfo();
        if (!live || typeof fetchFn !== 'function') return null;
        const headers = { 'Content-Type': 'application/json' };
        if (live.token) headers['X-Sidecar-Token'] = live.token;
        try {
            const res = await fetchFn(`http://${live.urlHost}:${live.port}${mcpPath}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(rpcRequest),
                signal: AbortSignal.timeout(forwardTimeoutMs),
            });
            if (!res?.ok) return null;
            const parsed = await res.json();
            return isObj(parsed) && parsed.jsonrpc === '2.0' ? parsed : null;
        } catch {
            return null;
        }
    };

    const routeRequest = async (rpcRequest) => {
        if (!isObj(rpcRequest)) {
            return { jsonrpc: '2.0', id: null, error: { code: ERR_REQ, message: 'Invalid Request' } };
        }
        const isNotification = !Object.hasOwn(rpcRequest, 'id') || rpcRequest.id === undefined;
        if (isNotification) {
            await tryForwardOnline(rpcRequest);
            return null;
        }
        const forwarded = await tryForwardOnline(rpcRequest);
        if (forwarded) return forwarded;
        const sync = getOfflineSync();
        const convId = extractConversationId(isObj(rpcRequest.params) ? rpcRequest.params : {}, {});
        sync.refresh(convId || '');
        return sync.handleMcp(rpcRequest, {});
    };

    const handleLine = async (rawLine) => {
        const trimmed = typeof rawLine === 'string' ? rawLine.trim() : '';
        if (!trimmed) return;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
            return;
        }
        try {
            if (Array.isArray(parsed)) {
                if (parsed.length === 0) {
                    output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR_REQ, message: 'Invalid Request' } })}\n`);
                    return;
                }
                const replies = [];
                for (const item of parsed) {
                    const r = await routeRequest(item);
                    if (r !== null && r !== undefined) replies.push(r);
                }
                if (replies.length > 0) output.write(`${JSON.stringify(replies)}\n`);
                return;
            }
            const reply = await routeRequest(parsed);
            if (reply !== null && reply !== undefined) {
                output.write(`${JSON.stringify(reply)}\n`);
            }
        } catch (err) {
            const id = isObj(parsed) ? (parsed.id ?? null) : null;
            output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: ERR_INTERNAL, message: err?.message || String(err) } })}\n`);
        }
    };

    let queue = Promise.resolve();
    const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
    rl.on('line', (line) => {
        queue = queue.then(() => handleLine(line)).catch(() => {});
    });

    let resolveClosed;
    const closed = new Promise((r) => {
        resolveClosed = r;
    });

    rl.once('close', () => {
        queue.finally(() => {
            offlineSync?.dispose?.();
            resolveClosed();
            if (exitOnClose) process.exit(0);
        });
    });

    const close = () => {
        rl.close();
        offlineSync?.dispose?.();
    };

    return { close, closed, handleLine, routeRequest };
}
