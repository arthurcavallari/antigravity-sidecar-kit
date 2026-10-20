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
} catch {
  // Running outside Antigravity SidecarManager (e.g. standalone unit tests)
}

const DEFAULT_BOOT_TS = Date.now();

export function createAssetHandler(uiDir, relPath, contentType, options = {}) {
  const ResponseClass = options.ResponseClass || SdkResponse;
  const bootTs = options.bootTs ?? DEFAULT_BOOT_TS;
  return () => {
    const uiToken = options.uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? '';
    const raw = readFileSync(join(uiDir, relPath), 'utf-8');
    const body =
      relPath.endsWith('.html') && uiToken
        ? raw.replace(
            /(src|href)="(\/[^"?]+)"/g,
            `$1="$2?token=${encodeURIComponent(uiToken)}&v=${bootTs}"`
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
