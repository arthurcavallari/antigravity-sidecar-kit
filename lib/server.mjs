/**
 * @fileoverview Static UI asset and Antigravity stylesheet route factories for SidecarApp.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fetchHostStylesheet } from './theme.mjs';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from './shell.mjs';
import {
  ALL_AGY_UI_MODULES,
  buildAgyUiCss,
  buildAgyUiJs,
  readModuleCss,
  readModuleJs,
} from './ui.mjs';
import { getCurrentRequestContext, isLoopbackOrigin, registerStateSyncRoutes, verifySidecarToken } from './state-sync.mjs';
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
