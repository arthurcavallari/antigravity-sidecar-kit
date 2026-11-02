import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from '../lib/shell.mjs';
import { writeJsonNoBom } from '../lib/config.mjs';
import {
  computeRelativeLuminance,
  fetchHostStylesheet,
  parseCssColor,
  resolveHostTheme,
} from '../lib/theme.mjs';

describe('antigravity-sidecar-kit/theme unified resolver and stylesheet proxy', () => {
  it('AGY_SHELL_CSS defines --agy-radius-*, --agy-dur, --agy-ease, dark-mode --agy-rule, and [data-follow-host] mappings', () => {
    for (const tokenRule of [
      '--agy-radius-sm: var(--radius-sm, 0.25rem);',
      '--agy-radius-md: var(--radius-md, 0.375rem);',
      '--agy-radius-lg: var(--radius-lg, 0.5rem);',
      '--agy-radius-xl: var(--radius-xl, 0.75rem);',
      '--agy-radius-pill: 9999px;',
      '--agy-dur: var(--default-transition-duration, 150ms);',
      '--agy-ease: var(--default-transition-timing-function, cubic-bezier(0.4, 0, 0.2, 1));',
      '--agy-control: var(--secondary, color-mix(in srgb, var(--agy-ink) 12%, var(--agy-canvas)));',
      '--agy-hover: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));',
      '--agy-card-edge: var(--card-border, var(--border, rgba(128, 128, 128, 0.12)));',
      '--agy-rule: var(--border, rgba(128, 128, 128, 0.12));',
    ]) {
      assert.ok(AGY_SHELL_CSS.includes(tokenRule), `AGY_SHELL_CSS must include ${tokenRule}`);
    }
  });

  it('parses CSS colors, computes relative luminance, and emits --agy-* tokens including 88% --agy-ink-soft', () => {
    assert.deepEqual(parseCssColor('#181818'), [24, 24, 24]);
    assert.deepEqual(parseCssColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseCssColor('rgb(16, 185, 129)'), [16, 185, 129]);
    assert.ok(computeRelativeLuminance('#ffffff') > 0.99);
    assert.ok(computeRelativeLuminance('#181818') < 0.02);

    const dark = resolveHostTheme({ themeMode: 2 });
    assert.ok(dark.luminance < 0.02);
    assert.equal(dark.cssVariables['--agy-ink-soft'], 'color-mix(in srgb, #ffffff 88%, #181818)');
    assert.equal(dark.cssVariables['--agy-canvas'], '#181818');
  });

  it('resolves both Hangar cssVariables and Context Monitor vars across dark, light, and high-contrast modes', () => {
    const darkDefault = resolveHostTheme({ themeMode: 2 });
    assert.equal(darkDefault.mode, 'dark');
    assert.equal(darkDefault.themeType, 'dark');
    assert.equal(darkDefault.contrast, 'normal');
    assert.equal(darkDefault.vars['--cm-bg'], '#181818');
    assert.equal(darkDefault.vars['--cm-text'], '#ffffff');
    assert.equal(darkDefault.vars['--cm-card'], 'color-mix(in srgb, #ffffff 5%, #181818)');
    assert.equal(darkDefault.vars['--cm-border'], 'color-mix(in srgb, #ffffff 5%, transparent)');
    assert.equal(darkDefault.vars['--cm-hover'], 'rgba(255, 255, 255, 0.05)');
    assert.equal(darkDefault.cssVariables['--background'], '#181818');

    const dir = mkdtempSync(join(tmpdir(), 'kit-theme-test-'));
    try {
      const agyCfgPath = join(dir, 'config.json');
      const appStoragePath = join(dir, 'app_storage.json');
      writeJsonNoBom(agyCfgPath, {
        userSettings: {
          themeMode: 'THEME_MODE_LIGHT',
          customThemeSeedsLight: { background: '#FAFAFA', primary: '#10b981' },
        },
      });
      writeJsonNoBom(appStoragePath, { 'jetski.contrast': '2' });
      const resolved = resolveHostTheme(agyCfgPath, appStoragePath);
      assert.equal(resolved.themeType, 'light');
      assert.equal(resolved.mode, 'light');
      assert.equal(resolved.contrast, 'high');
      assert.equal(resolved.cssVariables['--background'], '#FAFAFA');
      assert.equal(resolved.cssVariables['--primary'], '#10b981');
      assert.equal(resolved.cssVariables['--border'], 'rgba(0, 0, 0, 0.12)');
      assert.equal(resolved.vars['--cm-bg'], '#FAFAFA');
      assert.equal(resolved.vars['--cm-accent'], '#10b981');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchHostStylesheet discovers renamed CSS links, rejects SPA HTML catch-all, and wraps in @layer agy-host', async () => {
    const css = await fetchHostStylesheet({
      lsAddress: '127.0.0.1:59125',
      fetchFn: async (u) =>
        u.endsWith('/')
          ? {
              ok: true,
              headers: new Map([['content-type', 'text/html']]),
              text: async () => '<link rel="stylesheet" href="/app-hash.css">',
            }
          : {
              ok: true,
              headers: new Map([['content-type', 'text/css']]),
              text: async () => ':root{--radius-sm:4px}@property --tw-x { syntax: "*"; }',
            },
      forceRefresh: true,
    });
    assert.match(css, /^@layer agy-host \{[\s\S]*--radius-sm:4px[\s\S]*\}\n@property --tw-x/);
  });

  it('AGY_CLIENT_JS MutationObserver does not re-trigger itself on syncAgyThemeAttributes or applyAgyThemeFromPayload', () => {
    let observerCallback = null;
    let observerFilter = [];
    let observerDeliveries = 0;

    const attrs = new Map();
    const styleProps = new Map();
    const notifyAttr = (attrName) => {
      if (observerCallback && observerFilter.includes(attrName)) {
        observerDeliveries++;
        if (observerDeliveries > 10) {
          throw new Error('Infinite MutationObserver loop detected');
        }
        observerCallback([{ attributeName: attrName }]);
      }
    };

    const rootEl = {
      hasAttribute: (k) => attrs.has(k),
      toggleAttribute: (k, force) => {
        if (force) attrs.set(k, '');
        else attrs.delete(k);
        notifyAttr(k);
      },
      dataset: new Proxy(
        {},
        {
          get: (_t, prop) => attrs.get(`data-${String(prop)}`),
          set: (_t, prop, val) => {
            attrs.set(`data-${String(prop)}`, String(val));
            notifyAttr(`data-${String(prop)}`);
            return true;
          },
        }
      ),
      style: {
        getPropertyValue: (k) => styleProps.get(k) || '',
        setProperty: (k, v) => {
          styleProps.set(k, v);
          notifyAttr('style');
        },
        removeProperty: (k) => {
          styleProps.delete(k);
        },
      },
      classList: { contains: () => false },
    };

    const sandbox = {
      window: {
        location: { href: 'http://127.0.0.1:5000/', search: '' },
        matchMedia: () => ({ matches: true }),
      },
      document: {
        readyState: 'loading',
        documentElement: rootEl,
      },
      MutationObserver: class {
        constructor(cb) {
          observerCallback = cb;
        }
        observe(_el, opts) {
          observerFilter = opts.attributeFilter || [];
        }
      },
    };
    sandbox.window.document = sandbox.document;

    vm.runInNewContext(AGY_CLIENT_JS, sandbox);
    assert.deepEqual([...observerFilter], ['class', 'style']);
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.ok(AGY_SHELL_CSS.includes('--agy-font-mono:'));
    assert.equal(AGY_SHELL_CSS.includes('#101114'), false);
    assert.equal(AGY_SHELL_CSS.includes('#e6e8ec'), false);

    // Triggering applyAgyThemeFromPayload mutates style once, which triggers the observer once and stops cleanly
    styleProps.set('--agy-ink-soft', 'color-mix(in srgb, #ffffff 88%, #181818)');
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      themeType: 'light',
      cssVariables: {
        '--background': '#fafafa',
        '--agy-canvas': '#181818',
        '--agy-ink-soft': 'color-mix(in srgb, #ffffff 88%, #181818)',
      },
    });
    assert.equal(attrs.get('data-theme'), 'light');
    assert.equal(styleProps.has('--agy-canvas'), false);
    assert.equal(styleProps.has('--agy-ink-soft'), false);
    assert.equal(observerDeliveries, 1);
  });
});
