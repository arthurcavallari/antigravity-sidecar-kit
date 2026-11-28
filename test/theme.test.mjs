import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from '../lib/shell.mjs';
import { writeJsonNoBom } from '../lib/config.mjs';
import {
  BUILT_IN_THEMES,
  ONYX_THEME_TOKENS,
  computeRelativeLuminance,
  fetchHostStylesheet,
  parseCssColor,
  readHostFontSize,
  readHostThemePreset,
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
      '--agy-info: var(--link, var(--color-blue-500, #4380b4));',
      '--agy-info: var(--link, var(--color-blue-400, #6a9fcb));',
      '--nux-focus-ring: color-mix(in srgb, var(--agy-accent) 55%, transparent);',
    ]) {
      assert.ok(AGY_SHELL_CSS.includes(tokenRule), `AGY_SHELL_CSS must include ${tokenRule}`);
    }
  });

  it('parses CSS colors (including CSS Color 4 space/slash syntax), computes relative luminance, and emits --agy-* tokens including 88% --agy-ink-soft', () => {
    assert.deepEqual(parseCssColor('#181818'), [24, 24, 24]);
    assert.deepEqual(parseCssColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseCssColor('rgb(16, 185, 129)'), [16, 185, 129]);
    assert.deepEqual(parseCssColor('rgb(10 10 12 / 0.06)'), [10, 10, 12]);
    assert.deepEqual(parseCssColor('rgba(255 255 255 / 8%)'), [255, 255, 255]);
    assert.ok(computeRelativeLuminance('#ffffff') > 0.99);
    assert.ok(computeRelativeLuminance('#181818') < 0.02);

    const dark = resolveHostTheme({ themeMode: 2 });
    assert.ok(dark.luminance < 0.02);
    assert.equal(dark.theme, 'Onyx Dark');
    assert.equal(dark.cssVariables['--agy-ink-soft'], 'color-mix(in srgb, #FFFFFF 88%, #070708)');
    assert.equal(dark.cssVariables['--agy-canvas'], '#070708');
    assert.equal(dark.cssVariables['--link'], '#6a9fcb');
    assert.equal(dark.cssVariables['--shell'], '#111114');
    assert.equal(dark.cssVariables['--cta'], '#2F71E3');
  });

  it('resolves both Hangar cssVariables and Context Monitor vars across dark, light, and high-contrast modes', () => {
    const darkDefault = resolveHostTheme({ themeMode: 2 });
    assert.equal(darkDefault.mode, 'dark');
    assert.equal(darkDefault.themeType, 'dark');
    assert.equal(darkDefault.contrast, 'normal');
    assert.equal(darkDefault.theme, 'Onyx Dark');
    assert.equal(darkDefault.vars['--cm-bg'], '#070708');
    assert.equal(darkDefault.vars['--cm-text'], '#FFFFFF');
    assert.equal(darkDefault.vars['--cm-accent'], '#2F71E3');
    assert.equal(darkDefault.cssVariables['--background'], '#070708');
    assert.equal(darkDefault.cssVariables['--primary'], '#2F71E3');
    assert.equal(darkDefault.cssVariables['--card'], '#131317');

    const legacyDark = resolveHostTheme({ themeMode: 2, preset: 'Legacy Dark' });
    assert.equal(legacyDark.theme, 'Legacy Dark');
    assert.equal(legacyDark.cssVariables['--background'], '#101010');
    assert.equal(legacyDark.cssVariables['--primary'], '#007acc');

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

  it('maintains >= 4.6:1 WCAG contrast on 88% --agy-ink-soft across all built-in Antigravity 2.29.0 presets and Onyx tokens', () => {
    const mix88 = (fgHex, bgHex) => {
      const fg = parseCssColor(fgHex);
      const bg = parseCssColor(bgHex);
      return fg.map((c, i) => Math.round(c * 0.88 + bg[i] * 0.12));
    };
    const contrastRatio = (rgbA, rgbB) => {
      const l1 = computeRelativeLuminance(rgbA);
      const l2 = computeRelativeLuminance(rgbB);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    for (const [mode, table] of Object.entries(BUILT_IN_THEMES)) {
      const themeMode = mode === 'light' ? 'THEME_MODE_LIGHT' : 'THEME_MODE_DARK';
      for (const [presetName, seeds] of Object.entries(table)) {
        const res = resolveHostTheme({ themeMode, preset: presetName });
        assert.equal(res.mode, mode);
        assert.equal(res.theme, presetName);
        assert.equal(res.cssVariables['--background'], seeds.background);
        assert.equal(res.cssVariables['--foreground'], seeds.foregroundOverride);
        assert.equal(res.cssVariables['--primary'], seeds.primary);
        const inkSoftRgb = mix88(seeds.foregroundOverride, seeds.background);
        const ratio = contrastRatio(inkSoftRgb, parseCssColor(seeds.background));
        assert.ok(ratio >= 4.6, `${mode}/${presetName} 88% ink-soft contrast ${ratio.toFixed(2)}:1 must be >= 4.6:1`);
      }
    }

    // Vesper has a high-luminance primary (#FFC799) -> primary-foreground picks dark endpoint (#101010)
    const vesper = resolveHostTheme({ themeMode: 2, preset: 'Vesper' });
    assert.equal(vesper.cssVariables['--primary-foreground'], '#101010');

    // Onyx Dark & Onyx Light normal + high contrast token resolution matching jPb/vPb/wPb
    const onyxDark = resolveHostTheme({
      themeMode: 2,
      preset: 'Onyx Dark',
      contrast: 2,
      // Leftover Default Dark seeds in config.json must be stripped when Onyx is active (matching cPb)
      customThemeSeedsDark: {
        background: '#101010',
        foregroundOverride: '#cccccc',
        primary: '#007acc',
      },
    });
    assert.equal(onyxDark.contrast, 'high');
    assert.equal(onyxDark.cssVariables['--background'], '#050507');
    assert.equal(onyxDark.cssVariables['--shell'], '#121216');
    assert.equal(onyxDark.cssVariables['--card'], '#17171C');
    assert.equal(onyxDark.cssVariables['--glass'], '#16161A');
    assert.equal(onyxDark.cssVariables['--secondary-foreground'], '#EAEBF1');
    assert.equal(onyxDark.cssVariables['--muted-foreground'], '#A8A9B2');
    assert.equal(onyxDark.cssVariables['--placeholder'], '#888990');
    assert.equal(onyxDark.cssVariables['--border'], ONYX_THEME_TOKENS.dark.high['--border']);
    assert.equal(onyxDark.cssVariables['--onyx-frame'], '#0D0D11');
    assert.equal(onyxDark.cssVariables['--nux-radius-pill'], '9999px');
    assert.equal(vesper.cssVariables['--nux-radius-pill'], undefined, 'Non-Onyx presets must omit --nux-radius-pill');

    const onyxLightNormal = resolveHostTheme({ themeMode: 1, preset: 'Onyx Light', contrast: 1 });
    assert.equal(onyxLightNormal.cssVariables['--card'], '#FFFFFF');
    assert.equal(onyxLightNormal.cssVariables['--secondary-foreground'], '#3F3F46');
    assert.equal(onyxLightNormal.cssVariables['--muted-foreground'], '#71717A');
    assert.equal(onyxLightNormal.cssVariables['--placeholder'], '#8E8E95');
    assert.equal(onyxLightNormal.cssVariables['--onyx-frame'], '#F9F9F9');
    assert.equal(onyxLightNormal.cssVariables['--link'], '#1d588e');

    const onyxLightHigh = resolveHostTheme({ themeMode: 1, preset: 'Onyx Light', contrast: 2 });
    assert.equal(onyxLightHigh.cssVariables['--foreground'], '#000000');
    assert.equal(onyxLightHigh.cssVariables['--primary'], '#2560A3');
    assert.equal(onyxLightHigh.cssVariables['--shell'], '#F3F3F3');
    assert.equal(onyxLightHigh.cssVariables['--secondary-foreground'], '#27272A');
    assert.equal(onyxLightHigh.cssVariables['--link'], '#1d588e');

    const solarizedHc = resolveHostTheme({ themeMode: 1, preset: 'Solarized Light', contrast: 2 });
    assert.equal(solarizedHc.cssVariables['--link'], '#1d588e');

    // Plugin-contributed theme seeds (OYc / PluginThemeSeedsSchema: foreground, primaryForeground, codeForeground)
    const pluginTheme = resolveHostTheme({
      themeMode: 2,
      preset: 'Custom Plugin Dark',
      themes: [
        {
          id: 'custom-plugin-dark',
          label: 'Custom Plugin Dark',
          mode: 'dark',
          seeds: {
            background: 'hsl(220 20% 10%)',
            foreground: '#E5E9F0',
            primary: '#88C0D0',
            primaryForeground: '#1B1F27',
            codeForeground: '#A3BE8C',
          },
        },
      ],
    });
    assert.equal(pluginTheme.theme, 'Custom Plugin Dark');
    assert.equal(pluginTheme.cssVariables['--foreground'], '#E5E9F0');
    assert.equal(pluginTheme.cssVariables['--primary-foreground'], '#1B1F27');
    assert.equal(pluginTheme.cssVariables['--code-foreground'], '#A3BE8C');
    assert.ok(pluginTheme.luminance < 0.05);

    // Bare hex (without #) and hsl()/hsla() parsing in lib/theme.mjs
    assert.deepEqual(parseCssColor('181818'), [24, 24, 24]);
    assert.deepEqual(parseCssColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
    assert.deepEqual(parseCssColor('hsla(120 100% 50% / 0.5)'), [0, 255, 0]);

    const dir = mkdtempSync(join(tmpdir(), 'kit-theme-preset-'));
    try {
      const storagePath = join(dir, 'app_storage.json');
      writeJsonNoBom(storagePath, {
        'theme-preset-light': 'Solarized Light',
        'theme-preset-dark': 'Tokyo Night',
      });
      assert.equal(readHostThemePreset(storagePath, 'light'), 'Solarized Light');
      assert.equal(readHostThemePreset(storagePath, 'dark'), 'Tokyo Night');
      const fromStorage = resolveHostTheme({ themeMode: 'THEME_MODE_DARK' }, storagePath);
      assert.equal(fromStorage.theme, 'Tokyo Night');
      assert.equal(fromStorage.cssVariables['--background'], '#1A1B26');

      writeJsonNoBom(storagePath, {
        'theme-preset-dark': 'Default Dark',
        'jetski.contrast': '2',
      });
      const defaultDarkOnyx = resolveHostTheme({ themeMode: 'THEME_MODE_DARK' }, storagePath);
      assert.equal(defaultDarkOnyx.theme, 'Onyx Dark');
      assert.equal(defaultDarkOnyx.contrast, 'high');
      assert.equal(defaultDarkOnyx.cssVariables['--background'], '#050507');
      assert.equal(defaultDarkOnyx.cssVariables['--secondary-foreground'], '#EAEBF1');
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
              text: async () => ':root{--radius-sm:4px}button:focus-visible{outline:none !important}@property --tw-x { syntax: "*"; }',
            },
      forceRefresh: true,
    });
    assert.match(css, /^@layer agy-host \{[\s\S]*--radius-sm:4px[\s\S]*\}\n@property --tw-x/);
    assert.equal(css.includes('!important'), false, '@layer agy-host must strip !important to prevent CSS Cascade Level 5 layer inversion');

    const cssPort1 = await fetchHostStylesheet({
      lsAddress: '127.0.0.1:9001',
      fetchFn: async (u) => ({
        ok: true,
        headers: new Map([['content-type', u.endsWith('/') ? 'text/html' : 'text/css']]),
        text: async () => (u.endsWith('/') ? '' : ':root{--port:9001}'),
      }),
    });
    const cssPort2 = await fetchHostStylesheet({
      lsAddress: '127.0.0.1:9002',
      fetchFn: async (u) => ({
        ok: true,
        headers: new Map([['content-type', u.endsWith('/') ? 'text/html' : 'text/css']]),
        text: async () => (u.endsWith('/') ? '' : ':root{--port:9002}'),
      }),
    });
    assert.match(cssPort1, /--port:9001/);
    assert.match(cssPort2, /--port:9002/);
  });

  it('AGY_CLIENT_JS MutationObserver does not re-trigger itself and handles theme-change postMessage + CSS Color 4 syntax', () => {
    let observerCallback = null;
    let observerFilter = [];
    let observerDeliveries = 0;
    const messageListeners = [];
    const sessionStore = new Map();

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
      classList: { contains: (cls) => cls === 'theme-light' && attrs.get('class') === 'theme-light' },
    };

    const bodyAttrs = new Map();
    const bodyEl = {
      hasAttribute: (k) => bodyAttrs.has(k),
      getAttribute: (k) => (bodyAttrs.has(k) ? bodyAttrs.get(k) : null),
      setAttribute: (k, v) => bodyAttrs.set(k, String(v)),
      removeAttribute: (k) => bodyAttrs.delete(k),
      classList: {
        toggle: () => {},
      },
    };

    const sandbox = {
      URLSearchParams,
      sessionStorage: {
        getItem: (k) => sessionStore.get(k) || null,
        setItem: (k, v) => sessionStore.set(k, v),
      },
      window: {
        location: { href: 'http://127.0.0.1:5000/?hostTheme=dark', search: '?hostTheme=dark' },
        matchMedia: () => ({ matches: false }),
        addEventListener: (ev, fn) => {
          if (ev === 'message') messageListeners.push(fn);
        },
      },
      document: {
        readyState: 'loading',
        documentElement: rootEl,
        body: bodyEl,
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
    sandbox.window.parent = sandbox.window;
    sandbox.window.document = sandbox.document;

    vm.runInNewContext(AGY_CLIENT_JS, sandbox);
    assert.deepEqual([...observerFilter], ['class', 'style']);
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.ok(AGY_SHELL_CSS.includes('--agy-font-mono:'));
    assert.equal(AGY_SHELL_CSS.includes('#101114'), false);
    assert.equal(AGY_SHELL_CSS.includes('#e6e8ec'), false);

    // CSS Color 4 space/slash syntax and hsl() in client parser
    assert.deepEqual({ ...sandbox.window.AgyShell.parseCssColor('rgb(10 10 12 / 0.06)') }, {
      r: 10,
      g: 10,
      b: 12,
      a: 0.06,
    });
    assert.deepEqual({ ...sandbox.window.AgyShell.parseCssColor('hsl(240 100% 50% / 25%)') }, {
      r: 0,
      g: 0,
      b: 255,
      a: 0.25,
    });

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

    // When --background is var(--vscode-editor-background), falls back to --vscode-editor-background
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      themeType: 'dark',
      cssVariables: {
        '--background': 'var(--vscode-editor-background)',
        '--vscode-editor-background': '#1e1e1e',
      },
    });
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.equal(sandbox.window.AgyShell.isHostDarkTheme(), true);

    // Host postMessage with type === 'theme-change' automatically updates theme, synthesizes --onyx-* tokens, and caches to sessionStorage
    observerDeliveries = 0;
    for (const fn of messageListeners) {
      fn({
        source: sandbox.window.parent,
        data: {
          type: 'theme-change',
          payload: {
            theme: 'Onyx Dark',
            themeType: 'hcDark',
            cssVariables: { '--background': '#050507', '--foreground': '#FFFFFF' },
          },
        },
      });
    }
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.equal(styleProps.get('--background'), '#050507');
    assert.equal(styleProps.get('--onyx-well'), '#111115');
    assert.equal(styleProps.get('--onyx-key'), '#24252A');
    assert.ok(sessionStore.get('agy.theme.v1')?.includes('#050507'));

    // Host Ldc postMessage with label "Default Light" and Onyx rgb(10 10 12 / ...) tokens synthesizes light --onyx-* tokens
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      theme: 'Default Light',
      themeType: 'light',
      cssVariables: {
        '--background': '#FFFFFF',
        '--foreground': '#0A0A0C',
        '--secondary': 'rgb(10 10 12 / 0.06)',
        '--muted': 'rgb(10 10 12 / 0.038)',
      },
    });
    assert.equal(attrs.get('data-theme'), 'light');
    assert.equal(styleProps.get('--onyx-well'), 'rgb(10 10 12 / 0.055)');
    assert.equal(styleProps.get('--onyx-key'), '#FFFFFF');

    // Switching to a non-Onyx theme cleans up stale --onyx-* inline properties
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      theme: 'Tokyo Night',
      themeType: 'dark',
      cssVariables: {
        '--background': '#1A1B26',
        '--foreground': '#A9B1D6',
        '--secondary': '#232433',
      },
    });
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.equal(styleProps.has('--onyx-well'), false);
    assert.equal(styleProps.has('--onyx-key'), false);
    assert.equal(styleProps.has('--nux-radius-pill'), false);
    assert.equal(bodyAttrs.has('data-newux-theme'), false, 'Non-Onyx theme must remove data-newux-theme attribute');

    // Font scale from resolveHostTheme persists when subsequent host theme-change omits --app-font-scale
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      theme: 'Onyx Dark',
      themeType: 'dark',
      fontScale: 1.142857,
      cssVariables: { '--background': '#070709', '--foreground': '#FFFFFF' },
    });
    assert.equal(styleProps.get('--app-font-scale'), '1.142857');
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      theme: 'Onyx Dark',
      themeType: 'dark',
      cssVariables: { '--background': '#070709', '--foreground': '#FFFFFF' },
    });
    assert.equal(styleProps.get('--app-font-scale'), '1.142857');

    // 2.30+ Onyx Dark #070708 background without explicit label matches isOnyxPayload [KIT-15]
    observerDeliveries = 0;
    sandbox.window.AgyShell.applyAgyThemeFromPayload({
      themeType: 'dark',
      cssVariables: { '--background': '#070708', '--foreground': '#FFFFFF' },
    });
    assert.equal(styleProps.get('--onyx-well'), '#111115');
    assert.equal(styleProps.get('--onyx-key'), '#24252A');
  });

  it('reads jetski.fontSize from app_storage.json and emits --app-font-scale and 2.31 --text-* variables [KIT-14]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-font-scale-'));
    try {
      const storagePath = join(dir, 'app_storage.json');
      writeJsonNoBom(storagePath, { 'jetski.fontSize': 16, 'theme-preset-dark': 'Onyx Dark' });
      const fsInfo = readHostFontSize(storagePath);
      assert.equal(fsInfo.fontSizePx, 16);
      assert.equal(fsInfo.fontScale, +(16 / 14).toFixed(6));

      const resolved = resolveHostTheme({ themeMode: 'THEME_MODE_DARK' }, storagePath);
      assert.equal(resolved.fontSizePx, 16);
      assert.equal(resolved.cssVariables['--app-font-scale'], String(+(16 / 14).toFixed(6)));
      assert.equal(resolved.cssVariables['--font-size'], '16px');
      assert.equal(resolved.cssVariables['--text-compact'], 'calc(0.875rem * var(--app-font-scale, 1) - 0.0625rem)');
      assert.equal(resolved.cssVariables['--text-base'], 'calc(0.875rem * var(--app-font-scale, 1))');

      writeJsonNoBom(storagePath, { 'jetski.fontSize': 'small' });
      assert.equal(readHostFontSize(storagePath).fontSizePx, 12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const darkCharts = resolveHostTheme({ themeMode: 2 });
    assert.equal(darkCharts.cssVariables['--chart-1'], '#60a5fa');
    assert.equal(darkCharts.cssVariables['--chart-6'], '#38bdf8');
    const lightCharts = resolveHostTheme({ themeMode: 1 });
    assert.equal(lightCharts.cssVariables['--chart-1'], '#2563eb');
    assert.equal(lightCharts.cssVariables['--chart-6'], '#0284c7');
  });
});
