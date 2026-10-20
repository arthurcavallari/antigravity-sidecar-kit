/**
 * @fileoverview Unified host theme resolution, contrast detection, and Antigravity
 * stylesheet proxy supporting both Hangar (cssVariables) and Context Monitor (vars) contracts.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { APP_STORAGE_PATH, CONFIG_JSON_PATH, readJsonSafe } from './config.mjs';

let cachedStorageMtime = -1;
let cachedStorageContrast = 1;

export function readHostContrast(storagePath = APP_STORAGE_PATH) {
  try {
    if (!existsSync(storagePath)) return 1;
    const mtime = statSync(storagePath).mtimeMs;
    if (storagePath === APP_STORAGE_PATH && mtime === cachedStorageMtime) return cachedStorageContrast;
    const m = readFileSync(storagePath, 'utf8').match(/"jetski\.contrast"\s*:\s*"?([12])"?/);
    const val = m ? Number(m[1]) : 1;
    if (storagePath === APP_STORAGE_PATH) {
      cachedStorageMtime = mtime;
      cachedStorageContrast = val;
    }
    return val;
  } catch {
    return 1;
  }
}

export function resolveHostTheme(input = CONFIG_JSON_PATH, appStoragePath) {
  let userSettings = {};
  if (typeof input === 'string') {
    const parsed = readJsonSafe(input, {});
    userSettings = parsed?.userSettings || parsed || {};
  } else if (input && typeof input === 'object') {
    userSettings = input.userSettings || input;
  }

  const rawMode = userSettings?.themeMode;
  const isLight = rawMode === 1 || rawMode === '1' || rawMode === 'THEME_MODE_LIGHT';
  const isDark = !isLight;
  const mode = isLight ? 'light' : 'dark';

  const rawContrast =
    userSettings?.contrast !== undefined
      ? userSettings.contrast
      : appStoragePath || input === CONFIG_JSON_PATH
        ? readHostContrast(appStoragePath)
        : 1;
  const highContrast = rawContrast === 2 || rawContrast === '2' || rawContrast === 'CONTRAST_HIGH';

  const c = highContrast
    ? { darkPct: '10%', darkAlpha: 0.1, lightPct: '12%', lightAlpha: 0.12, mutedPct: '4%', secDark: '14%', secLight: '8%', cardDark: '6.5%' }
    : { darkPct: '5%', darkAlpha: 0.05, lightPct: '7.5%', lightAlpha: 0.075, mutedPct: '2.5%', secDark: '12%', secLight: '6%', cardDark: '5%' };

  const rawSeeds = (isLight ? userSettings?.customThemeSeedsLight : userSettings?.customThemeSeedsDark) || {};
  const defaults = isLight
    ? { primary: '#f8f9fc', secondary: '#121317', tertiary: '#007acc' }
    : { primary: '#181818', secondary: '#ffffff', tertiary: '#007acc' };

  const seeds = rawSeeds.background
    ? {
        primary: rawSeeds.background,
        secondary: rawSeeds.foregroundOverride || rawSeeds.secondary || defaults.secondary,
        tertiary: rawSeeds.primary || rawSeeds.tertiary || defaults.tertiary,
      }
    : {
        primary: rawSeeds.primary || defaults.primary,
        secondary: rawSeeds.foregroundOverride || rawSeeds.secondary || defaults.secondary,
        tertiary: rawSeeds.tertiary || defaults.tertiary,
      };

  const fontSans =
    userSettings?.['font.family'] ||
    userSettings?.fontFamily ||
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const fontMono =
    userSettings?.['editor.font.family'] ||
    userSettings?.['editor.fontFamily'] ||
    userSettings?.editorFontFamily ||
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

  const bg = seeds.primary;
  const fg = seeds.secondary;
  const primary = seeds.tertiary;
  const primaryFg = rawSeeds.primaryForegroundOverride || '#ffffff';
  const mixBase = isDark ? '#ffffff' : '#000000';
  const secPct = isDark ? c.secDark : c.secLight;
  const surface = `color-mix(in srgb, ${fg} ${c.mutedPct}, ${bg})`;
  const sidebar = `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${bg})`;
  const card = isLight ? '#ffffff' : `color-mix(in srgb, ${fg} ${c.cardDark}, ${bg})`;
  const secondary = `color-mix(in srgb, ${fg} ${secPct}, ${bg})`;
  const borderSolid = `color-mix(in srgb, ${fg} ${isLight ? c.lightPct : c.darkPct}, ${bg})`;
  const borderMix = `color-mix(in srgb, ${fg} ${isLight ? c.lightPct : c.darkPct}, transparent)`;
  const hover = isLight ? `rgba(0, 0, 0, ${c.lightAlpha})` : `rgba(255, 255, 255, ${c.darkAlpha})`;
  const chartColors = {
    '--chart-blue': isLight ? '#0066cc' : '#4e9de0',
    '--chart-purple': isLight ? '#6f42c1' : '#9b59b6',
    '--chart-green': isLight ? '#28a745' : '#388a34',
    '--chart-yellow': isLight ? '#d29922' : '#b5a642',
    '--chart-orange': isLight ? '#e36209' : '#d18616',
    '--chart-red': isLight ? '#d73a49' : '#d14d41',
  };

  const vars = {
    '--background': bg,
    '--foreground': fg,
    '--primary': primary,
    '--muted': surface,
    '--card': card,
    '--secondary': secondary,
    '--card-border': borderSolid,
    '--border': hover,
    '--cm-bg': bg,
    '--cm-surface': surface,
    '--cm-card': card,
    '--cm-secondary': secondary,
    '--cm-border': borderMix,
    '--cm-border-solid': borderSolid,
    '--cm-text': fg,
    '--cm-muted': `color-mix(in srgb, ${fg} ${isLight ? '60%' : '65%'}, ${bg})`,
    '--cm-accent': primary,
    '--cm-hover': hover,
    ...chartColors,
    '--vscode-font-family': fontSans,
    '--editor-font-family': fontMono,
    'color-scheme': mode,
  };

  const cssVariables = {
    ...vars,
    '--primary-foreground': primaryFg,
    '--secondary-foreground': `color-mix(in srgb, ${fg} 75%, ${bg})`,
    '--muted-foreground': `color-mix(in srgb, ${fg} 50%, ${bg})`,
    '--placeholder': `color-mix(in srgb, ${fg} 30%, ${bg})`,
    '--sidebar': sidebar,
    '--sidebar-secondary': `color-mix(in srgb, ${mixBase} ${secPct}, ${sidebar})`,
    '--sidebar-muted': `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${sidebar})`,
    '--content': bg,
    '--accent': primary,
    '--error': isDark ? '#de5555' : '#f05151',
    '--warning': isDark ? '#f3c949' : '#ac830b',
    '--success': isDark ? '#7aae66' : '#58983f',
    '--code-foreground': rawSeeds.codeForegroundOverride || (isDark ? '#d7ba7d' : '#a31515'),
  };

  return {
    theme: isDark ? 'Antigravity Dark' : 'Antigravity Light',
    themeType: mode,
    mode,
    contrast: highContrast ? 'high' : 'normal',
    isDark,
    cssVariables,
    vars,
  };
}

let cachedHostCss = '';
export async function fetchHostStylesheet({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  fetchFn = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (cachedHostCss && !forceRefresh) return cachedHostCss;
  if (!lsAddress || typeof fetchFn !== 'function') return '';
  const baseUrl = lsAddress.startsWith('http') ? lsAddress : `http://${lsAddress}`;
  const candidates = ['/compiled_tailwind.css'];
  try {
    const htmlRes = await fetchFn(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) });
    if (htmlRes?.ok) {
      const html = await htmlRes.text();
      const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi)]
        .map((m) => m[1] || m[2])
        .filter((h) => h && h.startsWith('/') && !h.includes('jetbox'));
      for (const h of hrefs.reverse()) {
        if (!candidates.includes(h)) candidates.unshift(h);
      }
    }
  } catch { /* fallback to default candidate */ }

  for (const path of candidates) {
    try {
      const res = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(1500) });
      const ctype = String(res?.headers?.get?.('content-type') || '').toLowerCase();
      if (!res?.ok || !ctype.includes('text/css')) continue;
      const rawCss = await res.text();
      const trimmed = rawCss.trimStart();
      if (!trimmed || trimmed.startsWith('<')) continue;
      const props = [];
      const body = rawCss.replace(/@property\s+--[\w-]+\s*\{[^}]*\}/g, (m) => {
        props.push(m);
        return '';
      });
      const wrapped = `@layer agy-host {\n${body}\n}\n${props.join('\n')}`;
      if (!forceRefresh) cachedHostCss = wrapped;
      return wrapped;
    } catch { /* try next candidate */ }
  }
  return '';
}
