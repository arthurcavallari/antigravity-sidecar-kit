import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonNoBom } from '../lib/config.mjs';
import { fetchHostStylesheet, resolveHostTheme } from '../lib/theme.mjs';

describe('antigravity-sidecar-kit/theme unified resolver and stylesheet proxy', () => {
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
});
