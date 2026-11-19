/**
 * @fileoverview Static UI asset and Antigravity stylesheet route factories for SidecarApp.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHostStylesheet } from './theme.mjs';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from './shell.mjs';
import {
  ALL_AGY_UI_MODULES,
  buildAgyUiCss,
  buildAgyUiJs,
  readModuleCss,
  readModuleJs,
} from './ui.mjs';
import {
  getCurrentRequestContext,
  isLoopbackOrigin,
  registerStateSyncRoutes,
  runAgentApiAsync,
  runWithRequestContext,
  verifySidecarToken,
} from './state-sync.mjs';
export { getCurrentRequestContext };

export function enforceSidecarToken(rawCtx = {}, expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '') {
  const ctx = (rawCtx && (rawCtx.req || rawCtx.headers || rawCtx.query || rawCtx.url)) ? rawCtx : (getCurrentRequestContext() || rawCtx || {});
  const headers = ctx?.req?.headers || ctx?.headers;
  const origin = headers?.origin;
  if (!isLoopbackOrigin(origin)) return false;
  if (!expectedToken) return true;
  const rawHeaderTok = headers?.['x-sidecar-token'] ?? headers?.['X-Sidecar-Token'];
  const headerTok = Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : rawHeaderTok;
  const reqUrl = ctx?.req?.url || (typeof ctx?.url === 'string' ? ctx.url : '');
  let urlTok = '';
  if (reqUrl) {
    try {
      urlTok = new URL(reqUrl, 'http://127.0.0.1').searchParams.get('token') || '';
    } catch {}
  }
  const provided =
    headerTok ||
    ctx?.query?.token ||
    ctx?.query?.get?.('token') ||
    urlTok ||
    '';
  return verifySidecarToken(String(provided), expectedToken);
}

export class FallbackResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

let SdkResponse = FallbackResponse;
try {
  const sdk = await import('sidecar_sdk');
  if (sdk?.Response) SdkResponse = sdk.Response;
} catch (err) {
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    console.warn(
      `[antigravity-sidecar-kit] Could not import sidecar_sdk (${err?.message || err}); ` +
        'pass { ResponseClass: Response } to createAssetHandler/createAgyCssHandler.'
    );
  }
}

const DEFAULT_BOOT_TS = Date.now();
const LOCAL_ASSET_ATTR = /(\s(?:src|href))=(["'])(\/(?!\/)[^"'?#]*)(\?[^"'#]*)?(#[^"']*)?\2/g;

function createSingleAssetHandler(uiDir, relPath, contentType = 'application/octet-stream', options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const bootTs = options.bootTs ?? DEFAULT_BOOT_TS;
  const forbidden = () =>
    new ResponseClass('Forbidden', { status: 403, contentType: 'text/plain; charset=utf-8' });
  return (reqData = {}) => {
    const cleanRel = String(relPath ?? '');
    if (!cleanRel || cleanRel.includes('\0')) return forbidden();
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(resolve(uiDir));
    } catch {
      return new ResponseClass('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
    }
    const candidate = resolve(canonicalRoot, cleanRel);
    if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + sep)) {
      return forbidden();
    }
    let st;
    try {
      st = lstatSync(candidate);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return new ResponseClass('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
      }
      return forbidden();
    }
    if (st.isSymbolicLink() || st.nlink !== 1 || !st.isFile()) {
      return forbidden();
    }
    let target;
    try {
      target = realpathSync(candidate);
      const targetStat = lstatSync(target);
      if (
        (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) ||
        targetStat.isSymbolicLink() ||
        targetStat.nlink !== 1 ||
        !targetStat.isFile()
      ) {
        return forbidden();
      }
    } catch {
      return forbidden();
    }
    const uiToken = options.uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? '';
    const convId =
      options.conversationId ?? reqData?.conversationId ?? reqData?.query?.conversationId ?? '';
    const raw = readFileSync(target, 'utf-8');
    const convQuery = convId ? `&conversationId=${encodeURIComponent(convId)}` : '';
    const tokenParams = `token=${encodeURIComponent(uiToken)}&v=${bootTs}${convQuery}`;
    const body =
      cleanRel.endsWith('.html') && uiToken
        ? raw.replace(LOCAL_ASSET_ATTR, (_, attr, quote, path, existingQuery = '', fragment = '') => {
            const sepChar = existingQuery ? `${existingQuery}&` : '?';
            return `${attr}=${quote}${path}${sepChar}${tokenParams}${fragment}${quote}`;
          })
        : raw;
    return new ResponseClass(body, { contentType, status: 200 });
  };
}

export function createAssetHandler(uiDir, relPathOrMap, contentType, options = {}) {
  if (relPathOrMap && typeof relPathOrMap === 'object' && !Array.isArray(relPathOrMap)) {
    const mapOptions = contentType && typeof contentType === 'object' ? contentType : options;
    const handlers = {};
    for (const [routePath, entry] of Object.entries(relPathOrMap)) {
      const [relPath, mime = 'application/octet-stream', itemOpts = {}] = Array.isArray(entry)
        ? entry
        : [entry?.relPath || entry?.file || '', entry?.contentType || 'application/octet-stream', entry || {}];
      handlers[routePath] = createSingleAssetHandler(uiDir, relPath, mime, {
        ...mapOptions,
        ...itemOpts,
      });
    }
    return handlers;
  }
  return createSingleAssetHandler(uiDir, relPathOrMap, contentType, options);
}

export function createAgyCssHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  return async () => {
    const css = await fetchHostStylesheet(options);
    return new ResponseClass(css, { contentType: 'text/css; charset=utf-8' });
  };
}

export function createShellCssHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  return () => new ResponseClass(AGY_SHELL_CSS, { contentType: 'text/css; charset=utf-8' });
}

export function createShellClientHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  return () => new ResponseClass(AGY_CLIENT_JS, { contentType: 'text/javascript; charset=utf-8' });
}

export function createUiCssHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const defaultModules = options.modules || options.uiModules || 'all';
  return (reqData = {}) => {
    const reqModules = reqData?.modules || reqData?.query?.modules || defaultModules;
    return new ResponseClass(buildAgyUiCss(reqModules), {
      contentType: 'text/css; charset=utf-8',
    });
  };
}

export function createUiJsHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const defaultModules = options.modules || options.uiModules || 'all';
  return (reqData = {}) => {
    const reqModules = reqData?.modules || reqData?.query?.modules || defaultModules;
    return new ResponseClass(buildAgyUiJs(reqModules), {
      contentType: 'text/javascript; charset=utf-8',
    });
  };
}

export function registerUiRoutes(app, options = {}) {
  if (!app || typeof app.page !== 'function') return;
  const ResponseClass = options.ResponseClass || SdkResponse;
  app.page('/ui.css', createUiCssHandler(options));
  app.page('/ui.js', createUiJsHandler(options));
  for (const mod of ALL_AGY_UI_MODULES) {
    app.page(
      `/ui/${mod}.css`,
      () => new ResponseClass(readModuleCss(mod), { contentType: 'text/css; charset=utf-8' })
    );
    app.page(
      `/ui/${mod}.js`,
      () => new ResponseClass(readModuleJs(mod), { contentType: 'text/javascript; charset=utf-8' })
    );
  }
}

export function setupSidecarServer(
  app,
  {
    uiDir = join(process.cwd(), 'ui'),
    assets,
    registerUi = true,
    enableUiRoutes,
    uiModules,
    corsOrigins,
    host,
    bodyLimitBytes,
    enableStateSync,
    stateSyncOptions,
    ...options
  } = {}
) {
  if (!app || typeof app.page !== 'function') return { app, sync: null };
  if (corsOrigins !== undefined) app.corsOrigins = corsOrigins;
  if (host !== undefined) app.host = host;
  if (bodyLimitBytes !== undefined) app.bodyLimitBytes = bodyLimitBytes;

  const uiOpts = uiModules !== undefined ? { ...options, modules: uiModules } : options;
  const agyCssHandler = createAgyCssHandler(options);
  app.page('/agy.css', agyCssHandler);
  app.page('/compiled_tailwind.css', agyCssHandler);
  app.page('/shell.css', createShellCssHandler(options));
  app.page('/shell.js', createShellClientHandler(options));
  if (enableUiRoutes ?? registerUi) {
    registerUiRoutes(app, uiOpts);
  }
  const effectiveAssets =
    assets !== undefined
      ? assets
      : {
          '/': ['index.html', 'text/html; charset=utf-8'],
          '/ui.html': ['index.html', 'text/html; charset=utf-8'],
        };
  if (uiDir && effectiveAssets && typeof effectiveAssets === 'object') {
    const assetHandlers = createAssetHandler(uiDir, effectiveAssets, options);
    for (const [routePath, handler] of Object.entries(assetHandlers)) {
      app.page(routePath, handler);
    }
  }
  let sync = null;
  const shouldEnableSync = enableStateSync !== undefined ? Boolean(enableStateSync) : Boolean(stateSyncOptions);
  if (shouldEnableSync && typeof app.api === 'function') {
    sync = registerStateSyncRoutes(app, stateSyncOptions || {});
  }
  return { app, sync };
}

const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const FALLBACK_PRELOAD_JS = `(function(){
  const p = new URLSearchParams(location.search);
  const t = p.get('token');
  const c = p.get('conversationId');
  let wsUris = [];
  let hasWs = false;
  let resolveInitWs;
  const wsListeners = new Set();
  const initWsPromise = new Promise((r) => { resolveInitWs = r; });
  const pm = (msg) => { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', (ev) => {
      const d = ev && ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'theme-change' && d.payload && d.payload.cssVariables && document.documentElement) {
        for (const [k, v] of Object.entries(d.payload.cssVariables)) {
          document.documentElement.style.setProperty(k, v);
        }
      } else if (d.type === 'workspace-change') {
        const pl = d.payload || {};
        const next = Array.isArray(pl.workspaceUris) ? [...pl.workspaceUris] : Array.isArray(pl.uris) ? [...pl.uris] : [];
        const changed = !hasWs || next.length !== wsUris.length || next.some((u, i) => u !== wsUris[i]);
        wsUris = next;
        hasWs = true;
        resolveInitWs();
        if (changed) {
          for (const fn of wsListeners) {
            try { fn([...wsUris]); } catch {}
          }
        }
      }
    });
    if (window.parent && window.parent !== window) {
      const tracked = new Set();
      const postKey = (e) => pm({
        type: 'sidecar-key-event',
        payload: {
          eventType: e.type,
          key: e.key,
          code: e.code || '',
          ctrlKey: Boolean(e.ctrlKey),
          metaKey: Boolean(e.metaKey),
          altKey: Boolean(e.altKey),
          shiftKey: Boolean(e.shiftKey),
          repeat: Boolean(e.repeat),
        },
      });
      window.addEventListener('keydown', (e) => {
        if (!e || e.isComposing || e.keyCode === 229 || typeof e.key !== 'string') return;
        if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
        if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift') return;
        const kl = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (kl === 'c' || kl === 'v' || kl === 'x')) return;
        const id = e.code || kl;
        if (id) tracked.add(id);
        postKey(e);
      });
      window.addEventListener('keyup', (e) => {
        if (!e || typeof e.key !== 'string') return;
        const id = e.code || e.key.toLowerCase();
        if ((id && tracked.delete(id)) || (tracked.size > 0 && e.key === 'Meta')) {
          if (e.key === 'Meta') tracked.clear();
          postKey(e);
        }
      });
    }
  }
  function sf(u, o = {}) {
    const h = new Headers(o.headers || {});
    if (!h.has('Content-Type') && o.body !== undefined) h.set('Content-Type', 'application/json');
    if (t) h.set('X-Sidecar-Token', t);
    return fetch(u, { ...o, headers: h });
  }
  const post = (u, b) => sf(u, { method: 'POST', body: JSON.stringify(b) }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  });
  async function getWorkspaceUris() {
    if (!window.parent || window.parent === window) return [];
    if (!hasWs && typeof setTimeout === 'function') {
      await Promise.race([initWsPromise, new Promise((r) => setTimeout(r, 150))]);
    }
    return [...wsUris];
  }
  window.sidecar = {
    conversationId: c,
    fetch: sf,
    getWorkspaceUris,
    onWorkspaceChange(fn) {
      if (typeof fn !== 'function') return () => {};
      wsListeners.add(fn);
      if (hasWs && typeof queueMicrotask === 'function') {
        queueMicrotask(() => { if (wsListeners.has(fn)) { try { fn([...wsUris]); } catch {} } });
      }
      return () => { wsListeners.delete(fn); };
    },
    agent: {
      sendMessage: (m, id) => post('/_sidecar/send-message', { conversationId: id || c, message: m }),
      startConversation: (m, title) => post('/_sidecar/new-conversation', { message: m, title }),
      getConversationMetadata: (id) => post('/_sidecar/get-conversation-metadata', { conversationId: id }),
    },
    ui: {
      toggleAuxPane(request) { pm({ type: 'toggle-aux-pane', payload: request }); },
      toggleConversation(conversationId, options) {
        const payload = options && typeof options === 'object' ? { conversationId, ...options } : { conversationId };
        pm({ type: 'toggle-conversation', payload });
      },
      addArtifactComment({ uri, comment, selection, pageTitle } = {}) {
        pm({ type: 'add-artifact-comment', payload: { uri, comment, selection, pageTitle } });
      },
    },
    auth: {
      requestCredentialRefresh() {
        pm({ type: 'request-credential-refresh' });
      },
    },
  };
})();\n`;

const preloadCache = new Map();

export function resolvePreloadJs(env = process.env) {
  const cacheKey = `${env.ANTIGRAVITY_PATH || ''}\0${env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || ''}\0${env.USERPROFILE || ''}\0${env.HOME || ''}`;
  if (preloadCache.has(cacheKey)) return preloadCache.get(cacheKey);
  const candidates = [];
  try {
    const sdkUrl = import.meta.resolve('sidecar_sdk');
    const sdkDir = dirname(fileURLToPath(sdkUrl));
    candidates.push(join(sdkDir, 'preload.js'), join(sdkDir, '..', 'preload.js'));
  } catch {}
  if (env.ANTIGRAVITY_PATH) {
    const agyBase = String(env.ANTIGRAVITY_PATH).trim();
    for (const root of [agyBase, dirname(agyBase)]) {
      candidates.push(
        join(root, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
        join(root, 'sidecar_sdk', 'preload.js'),
        join(root, 'resources', 'app', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
        join(root, 'resources', 'app', 'extensions', 'antigravity', 'sidecar_sdk', 'preload.js')
      );
    }
  }
  if (env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    const execData = String(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR).trim();
    candidates.push(
      join(execData, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
      join(execData, 'sidecar_sdk', 'preload.js')
    );
  }
  const homeRoot = env.USERPROFILE || env.HOME || homedir();
  candidates.push(join(homeRoot, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'));
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf8');
        preloadCache.set(cacheKey, content);
        return content;
      } catch {}
    }
  }
  preloadCache.set(cacheKey, FALLBACK_PRELOAD_JS);
  return FALLBACK_PRELOAD_JS;
}

const badReq = (msg) => Object.assign(new Error(msg), { status: 400, clientMessage: msg });
const attachErrStatus = (res) => {
  if (res && typeof res === 'object' && res.error && res.status === undefined) {
    Object.defineProperty(res, 'status', { value: 502, enumerable: false, configurable: true, writable: true });
  }
  return res;
};

function readBoundedJsonBody(req, res, limitBytes) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        if (byteLength + chunk.length > limitBytes + 65536) req.destroy();
        return;
      }
      byteLength += chunk.length;
      if (byteLength > limitBytes) {
        settled = true;
        chunks.length = 0;
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }), () => req.destroy());
        }
        if (byteLength > limitBytes + 65536) req.destroy();
        resolvePromise({ aborted: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolvePromise({ ok: true, body: null });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          resolvePromise({ ok: false, status: 400, error: 'JSON body must be an object' });
          return;
        }
        resolvePromise({ ok: true, body: parsed });
      } catch {
        resolvePromise({ ok: false, status: 400, error: 'Invalid JSON' });
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ok: false, status: 400, error: err?.message || 'Request stream error' });
    });
  });
}

export class StandaloneSidecarApp {
  #pages = new Map();
  #apis = new Map();
  #server = null;
  #hasExplicitToken = false;
  #configOverrides;
  #preloadJs;

  constructor(options = {}) {
    const rawPort = options.port !== undefined ? Number(options.port) : Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
    this.port = Number.isInteger(rawPort) && rawPort >= 0 ? rawPort : 0;
    this.host = options.host || '127.0.0.1';
    this.#hasExplicitToken = options.uiToken !== undefined || options.authToken !== undefined;
    this.uiToken = this.#hasExplicitToken
      ? String(options.uiToken ?? options.authToken ?? '')
      : (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
    this.bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    this.corsOrigins = Array.isArray(options.corsOrigins) ? options.corsOrigins : null;
    this.defaultModel = options.defaultModel || 'flash';
    this.agentApiFn = options.agentApiFn || runAgentApiAsync;
    this.#preloadJs = typeof options.preloadJs === 'string' ? options.preloadJs : null;
    this.#configOverrides = {
      projectId: options.projectId,
      conversationId: options.conversationId,
      workspace: options.workspace,
    };
  }

  get config() {
    return {
      projectId: this.#configOverrides.projectId ?? process.env.ANTIGRAVITY_PROJECT_ID,
      conversationId: this.#configOverrides.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID,
      workspace: this.#configOverrides.workspace ?? process.env.ANTIGRAVITY_WORKSPACE ?? '',
    };
  }

  getHttpServer() {
    return this.#server;
  }

  page(routePath, handler) {
    this.#pages.set(routePath, handler);
    return this;
  }

  api(routePath, handler, method = 'POST') {
    if (!this.#apis.has(routePath)) this.#apis.set(routePath, new Map());
    this.#apis.get(routePath).set(String(method || 'POST').toUpperCase(), handler);
    return this;
  }

  async sendMessage(conversationId, message, { title, projectId } = {}) {
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.trim().startsWith('-')) {
      throw badReq('Invalid or missing conversationId');
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw badReq('Invalid or missing message');
    }
    const cleanTitle = typeof title === 'string' && title.trim() ? title.trim() : '';
    if (cleanTitle.startsWith('-')) throw badReq('Invalid title');
    const args = ['send-message'];
    if (cleanTitle) args.push('--title', cleanTitle);
    if (message.startsWith('-')) args.push('--');
    args.push(conversationId.trim(), message);
    return attachErrStatus(await this.agentApiFn(args, { projectId: projectId ?? this.config.projectId }));
  }

  async startConversation(message, { model = this.defaultModel, workspace, projectId } = {}) {
    if (typeof message !== 'string' || !message.trim()) {
      throw badReq('Invalid or missing message');
    }
    const mdl = model !== undefined && model !== null ? String(model).trim() : '';
    if (mdl.startsWith('-')) throw badReq('Invalid model');
    const ws = workspace !== undefined && workspace !== null ? String(workspace).trim() : '';
    if (ws.startsWith('-')) throw badReq('Invalid workspace');
    const args = ['new-conversation'];
    if (mdl) args.push('--model', mdl);
    if (message.startsWith('-')) args.push('--');
    args.push(message);
    return attachErrStatus(
      await this.agentApiFn(args, {
        projectId: projectId ?? this.config.projectId,
        ...(ws ? { workspace: ws } : {}),
      })
    );
  }

  async getConversationMetadata(conversationId, { projectId } = {}) {
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.trim().startsWith('-')) {
      throw badReq('Invalid or missing conversationId');
    }
    return attachErrStatus(
      await this.agentApiFn(['get-conversation-metadata', conversationId.trim()], {
        projectId: projectId ?? this.config.projectId,
      })
    );
  }

  #expectedToken() {
    if (this.#hasExplicitToken || this.uiToken) return this.uiToken;
    return process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  }

  #isOriginAllowed(origin) {
    return isLoopbackOrigin(origin) || (Array.isArray(this.corsOrigins) && this.corsOrigins.includes(origin));
  }

  #writeResponseObject(res, method, value) {
    if (
      value instanceof SdkResponse ||
      value instanceof FallbackResponse ||
      (value && typeof value === 'object' && value.contentType && value.body !== undefined)
    ) {
      const status = value.status || 200;
      const body = typeof value.body === 'string' || Buffer.isBuffer(value.body) ? value.body : Buffer.from(value.body);
      res.writeHead(status, { 'Content-Type': value.contentType, ...value.headers });
      res.end(method === 'HEAD' ? undefined : body);
      return true;
    }
    return false;
  }

  run() {
    if (this.#server) return Promise.resolve(this.#server);
    if (!this.#pages.has('/preload.js')) {
      this.#pages.set(
        '/preload.js',
        () => new FallbackResponse(this.#preloadJs ?? resolvePreloadJs(), { contentType: 'text/javascript; charset=utf-8' })
      );
    }
    if (!this.#apis.get('/_sidecar/send-message')?.has('POST')) {
      this.api('/_sidecar/send-message', (data) =>
        this.sendMessage(data.conversationId, data.message, { title: data.title, projectId: data.projectId })
      );
    }
    if (!this.#apis.get('/_sidecar/new-conversation')?.has('POST')) {
      this.api('/_sidecar/new-conversation', (data) =>
        this.startConversation(data.message, { model: data.model, workspace: data.workspace, projectId: data.projectId })
      );
    }
    if (!this.#apis.get('/_sidecar/get-conversation-metadata')?.has('POST')) {
      this.api('/_sidecar/get-conversation-metadata', (data) =>
        this.getConversationMetadata(data.conversationId, { projectId: data.projectId })
      );
    }

    const server = createServer(async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase();
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        parsedUrl = new URL('/', 'http://127.0.0.1');
      }
      const pathname = parsedUrl.pathname;

      if (!this.#isOriginAllowed(req.headers?.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Forbidden origin' }));
        return;
      }

      if (req.headers?.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Sidecar-Token, X-Sidecar-Conversation',
        });
        res.end();
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && pathname === '/_sidecar/health' && !this.#pages.has(pathname)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: true, status: 'ok', pid: process.pid }));
        return;
      }

      const isSafeParamKey = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
      const fullEntries = [];
      const cleanEntries = [];
      for (const [k, v] of parsedUrl.searchParams.entries()) {
        if (!isSafeParamKey(k)) continue;
        fullEntries.push([k, v]);
        if (k.toLowerCase() !== 'token') cleanEntries.push([k, v]);
      }
      const fullQuery = Object.fromEntries(fullEntries);
      const cleanQuery = Object.fromEntries(cleanEntries);
      const ctx = { req, res, headers: req.headers, url: req.url, query: fullQuery };

      if ((method === 'GET' || method === 'HEAD') && this.#pages.has(pathname)) {
        try {
          const handler = this.#pages.get(pathname);
          const content = await runWithRequestContext(ctx, () => handler(cleanQuery, ctx));
          if (res.headersSent || res.writableEnded) return;
          if (this.#writeResponseObject(res, method, content)) return;
          const isJs = pathname.endsWith('.js');
          res.writeHead(200, { 'Content-Type': isJs ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : content);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Internal Server Error' }));
          }
        }
        return;
      }

      if (this.#apis.has(pathname)) {
        const expected = this.#expectedToken();
        if (expected) {
          const rawHeader = req.headers?.['x-sidecar-token'] ?? req.headers?.['X-Sidecar-Token'];
          const headerTok = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
          const provided = String(headerTok || fullQuery.token || parsedUrl.searchParams.get('token') || '');
          if (!verifySidecarToken(provided, expected)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        }

        const methodMap = this.#apis.get(pathname);
        const handler = methodMap.get(method) || (method === 'HEAD' ? methodMap.get('GET') : null);
        if (!handler) {
          res.writeHead(405, {
            'Content-Type': 'application/json; charset=utf-8',
            Allow: [...methodMap.keys()].join(', '),
          });
          res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        const limit = Number(this.bodyLimitBytes) > 0 ? Number(this.bodyLimitBytes) : DEFAULT_BODY_LIMIT_BYTES;
        const bodyRes = await readBoundedJsonBody(req, res, limit);
        if (bodyRes.aborted) return;
        if (!bodyRes.ok) {
          if (!res.headersSent) {
            res.writeHead(bodyRes.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: bodyRes.error }));
          }
          return;
        }

        const bodyEntries = bodyRes.body
          ? Object.entries(bodyRes.body).filter(([k]) => isSafeParamKey(k))
          : [];
        const data = Object.fromEntries([...cleanEntries, ...bodyEntries]);

        try {
          const result = await runWithRequestContext(ctx, () => handler(data, ctx));
          if (res.headersSent || res.writableEnded) return;
          if (this.#writeResponseObject(res, method, result)) return;
          const status =
            result && typeof result === 'object' && Number.isInteger(result.status) && result.status >= 100 && result.status < 600
              ? result.status
              : 200;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : JSON.stringify(result ?? null));
        } catch (err) {
          if (!res.headersSent) {
            const errStatus = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
            const safeError =
              errStatus < 500 && typeof err?.clientMessage === 'string'
                ? err.clientMessage
                : errStatus === 400
                  ? 'Bad Request'
                  : 'Internal Server Error';
            res.writeHead(errStatus, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: safeError }));
          }
        }
        return;
      }

      if (this.#pages.has(pathname)) {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : 'Not found');
    });

    const bindHost = this.host || '127.0.0.1';
    return new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      this.#server = server.listen(this.port, bindHost, () => {
        server.removeListener('error', rejectPromise);
        const boundPort = server.address?.()?.port;
        if (boundPort) this.port = boundPort;
        resolvePromise(server);
      });
    });
  }

  close() {
    if (!this.#server) return Promise.resolve();
    const srv = this.#server;
    this.#server = null;
    return new Promise((resolvePromise) => {
      srv.close(() => resolvePromise());
      srv.closeAllConnections?.();
    });
  }
}

export function createSidecarApp(options = {}) {
  return new StandaloneSidecarApp(options);
}
