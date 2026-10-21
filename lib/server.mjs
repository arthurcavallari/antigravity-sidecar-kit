/**
 * @fileoverview Static UI asset and Antigravity stylesheet route factories for SidecarApp.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHostStylesheet } from './theme.mjs';

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
  return () => {
    const uiToken = options.uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? '';
    const raw = readFileSync(join(uiDir, relPath), 'utf-8');
    const query = `?token=${encodeURIComponent(uiToken)}&v=${bootTs}`;
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
