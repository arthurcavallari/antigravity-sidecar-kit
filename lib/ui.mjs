/**
 * @fileoverview Modular Antigravity Sidecar Component Library (AgyUI) assembler.
 * Reads and caches per-module CSS and JS assets from lib/ui/<module>/.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'ui');

export const ALL_AGY_UI_MODULES = Object.freeze([
  'core',
  'tabs',
  'tab-drag',
  'layout',
  'overlays',
  'controls',
  'surfaces',
]);

const MODULE_JS_FILES = {
  core: ['icons.js', 'html.js', 'runtime.js'],
  tabs: ['tab-pill.js', 'tab-strip.js', 'toggle-group.js'],
  'tab-drag': ['tab-drag.js'],
  layout: ['layout.js'],
  overlays: ['overlays.js'],
  controls: ['controls.js'],
  surfaces: ['surfaces.js'],
};

const readCss = (mod) => readFileSync(join(UI_ROOT, mod, `${mod}.css`), 'utf8');
const readJs = (mod) => (MODULE_JS_FILES[mod] || []).map((f) => readFileSync(join(UI_ROOT, mod, f), 'utf8')).join('\n');

export const AGY_UI_CSS_MODULES = Object.freeze(Object.fromEntries(ALL_AGY_UI_MODULES.map((m) => [m, readCss(m)])));
export const AGY_UI_JS_MODULES = Object.freeze(Object.fromEntries(ALL_AGY_UI_MODULES.map((m) => [m, readJs(m)])));

export function readModuleCss(mod) {
  return AGY_UI_CSS_MODULES[mod] || '';
}

export function readModuleJs(mod) {
  return AGY_UI_JS_MODULES[mod] || '';
}

export function resolveAgyUiModules(modules) {
  if (!modules || modules === 'all' || (Array.isArray(modules) && modules.includes('all'))) {
    return [...ALL_AGY_UI_MODULES];
  }
  const list = Array.isArray(modules) ? modules : String(modules).split(',').map((s) => s.trim()).filter(Boolean);
  const valid = list.filter((m) => ALL_AGY_UI_MODULES.includes(m));
  if (!valid.includes('core')) valid.unshift('core');
  return [...new Set(valid)];
}

export function buildAgyUiCss(modules = 'all') {
  return resolveAgyUiModules(modules).map((m) => AGY_UI_CSS_MODULES[m] || '').filter(Boolean).join('\n');
}

export function buildAgyUiJs(modules = 'all') {
  const selected = resolveAgyUiModules(modules);
  const body = selected.map((m) => AGY_UI_JS_MODULES[m] || '').filter(Boolean).join('\n');
  const footer = [
    ';(function(w) {',
    '  const u = (w.AgyUI = w.AgyUI || {});',
    `  u.enabledModules = ${JSON.stringify(selected)};`,
    "})(typeof window !== 'undefined' ? window : globalThis);",
  ].join('\n');
  return `${body}\n${footer}\n`;
}

export const AGY_UI_CSS = buildAgyUiCss('all');
export const AGY_UI_JS = buildAgyUiJs('all');

export function installDomPolyfills(win) {
  if (!win) return;
  if (typeof win.Event === 'function') {
    for (const evName of ['MouseEvent', 'PointerEvent', 'KeyboardEvent', 'WheelEvent']) {
      if (typeof win[evName] !== 'function') {
        win[evName] = class extends win.Event {
          constructor(type, init = {}) {
            super(type, init);
            if (init && typeof init === 'object') {
              for (const [k, v] of Object.entries(init)) {
                if (k !== 'bubbles' && k !== 'cancelable' && k !== 'composed') this[k] = v;
              }
            }
            if ((evName === 'MouseEvent' || evName === 'PointerEvent') && this.button === undefined) this.button = 0;
          }
        };
      }
    }
  }
  const elProto = win.HTMLElement?.prototype;
  if (elProto) {
    const tiDesc = Object.getOwnPropertyDescriptor(elProto, 'tabIndex');
    if (!tiDesc || !tiDesc.set) {
      Object.defineProperty(elProto, 'tabIndex', {
        configurable: true,
        get() {
          const v = this.getAttribute?.('tabindex');
          return v !== null && v !== undefined && v !== '' ? Number(v) : -1;
        },
        set(val) {
          this.setAttribute?.('tabindex', String(Number(val)));
        },
      });
    }
  }
}

export function attachAgyUI(globalObj = typeof window !== 'undefined' ? window : globalThis, options = {}) {
  const win = globalObj?.window || globalObj;
  const doc = globalObj?.document || win?.document;
  if (win && doc && !win.document) win.document = doc;
  installDomPolyfills(win);
  const fn = new Function(
    'window', 'document', 'customElements', 'HTMLElement', 'CustomEvent',
    'MutationObserver', 'ResizeObserver', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'fetch',
    buildAgyUiJs(options.modules || 'all')
  );
  fn(
    win, doc,
    win?.customElements ?? (typeof customElements !== 'undefined' ? customElements : undefined),
    win?.HTMLElement ?? (typeof HTMLElement !== 'undefined' ? HTMLElement : undefined),
    win?.CustomEvent ?? (typeof CustomEvent !== 'undefined' ? CustomEvent : undefined),
    win?.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined),
    win?.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined),
    win?.setTimeout ? win.setTimeout.bind(win) : setTimeout,
    win?.clearTimeout ? win.clearTimeout.bind(win) : clearTimeout,
    win?.URL ?? URL,
    win?.URLSearchParams ?? URLSearchParams,
    win?.fetch ? win.fetch.bind(win) : typeof fetch !== 'undefined' ? fetch : undefined
  );
  return win.AgyUI;
}
