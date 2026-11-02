/**
 * @fileoverview Static UI asset and Antigravity stylesheet route factories for SidecarApp.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHostStylesheet } from './theme.mjs';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from './shell.mjs';
import { ALL_AGY_UI_MODULES, buildAgyUiCss, buildAgyUiJs } from './ui.mjs';

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
  // Expected outside Antigravity SidecarManager (e.g. standalone unit tests); inside a
  // sidecar it means handlers will return FallbackResponse, which SidecarApp won't recognise.
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    console.warn(
      `[antigravity-sidecar-kit] Could not import sidecar_sdk (${err?.message || err}); ` +
        'pass { ResponseClass: Response } to createAssetHandler/createAgyCssHandler.'
    );
  }
}

const DEFAULT_BOOT_TS = Date.now();

// Same-origin absolute paths only: skips protocol-relative //host URLs and paths that
// already carry a query string, and keeps any #fragment after the injected query.
const LOCAL_ASSET_ATTR = /(\s(?:src|href))="(\/(?!\/)[^"?#]*)(#[^"]*)?"/g;

export function createAssetHandler(uiDir, relPath, contentType, options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const bootTs = options.bootTs ?? DEFAULT_BOOT_TS;
  return (reqData = {}) => {
    const uiToken = options.uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? '';
    const convId =
      options.conversationId ??
      reqData?.conversationId ??
      reqData?.query?.conversationId ??
      '';
    const raw = readFileSync(join(uiDir, relPath), 'utf-8');
    const convQuery = convId ? `&conversationId=${encodeURIComponent(convId)}` : '';
    const query = `?token=${encodeURIComponent(uiToken)}&v=${bootTs}${convQuery}`;
    const body =
      relPath.endsWith('.html') && uiToken
        ? raw.replace(
            LOCAL_ASSET_ATTR,
            (_, attr, path, fragment = '') => `${attr}="${path}${query}${fragment}"`
          )
        : raw;
    return new ResponseClass(body, { contentType });
  };
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
  const defaultModules = options.modules || 'all';
  return (reqData = {}) => {
    const reqModules = reqData?.modules || reqData?.query?.modules || defaultModules;
    return new ResponseClass(buildAgyUiCss(reqModules), {
      contentType: 'text/css; charset=utf-8',
    });
  };
}

export function createUiJsHandler(options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const defaultModules = options.modules || 'all';
  return (reqData = {}) => {
    const reqModules = reqData?.modules || reqData?.query?.modules || defaultModules;
    return new ResponseClass(buildAgyUiJs(reqModules), {
      contentType: 'text/javascript; charset=utf-8',
    });
  };
}

export function registerUiRoutes(app, options = {}) {
  if (!app || typeof app.page !== 'function') return;
  app.page('/ui.css', createUiCssHandler(options));
  app.page('/ui.js', createUiJsHandler(options));
  for (const mod of ALL_AGY_UI_MODULES) {
    app.page(`/ui/${mod}.css`, createUiCssHandler({ ...options, modules: [mod] }));
    app.page(`/ui/${mod}.js`, createUiJsHandler({ ...options, modules: [mod] }));
  }
}
