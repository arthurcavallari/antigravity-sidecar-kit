/**
 * @fileoverview Unified host theme resolution, contrast detection, and Antigravity
 * stylesheet proxy supporting both Hangar (cssVariables) and Context Monitor (vars) contracts.
 */

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { APP_STORAGE_PATH, CONFIG_JSON_PATH, readJsonSafe } from './config.mjs';
import { BUILT_IN_THEMES, ONYX_THEME_TOKENS } from './theme-presets.mjs';

export { BUILT_IN_THEMES, ONYX_THEME_TOKENS };

let cachedStorageMtime = -1;
let cachedStorageContrast = 1;

function hslToRgb(hDeg, sPct, lPct) {
  const h = (((Number(hDeg) || 0) % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, Number(sPct) || 0)) / 100;
  const l = Math.max(0, Math.min(100, Number(lPct) || 0)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function parseCssColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const hex = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(
    /^rgba?\(\s*([\d.]+)\s*(?:,\s*|\s+)([\d.]+)\s*(?:,\s*|\s+)([\d.]+)(?:\s*(?:,|\/)\s*[\d.%]+)?\s*\)$/i
  );
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = s.match(
    /^hsla?\(\s*([+-]?[\d.]+)(?:deg)?\s*(?:,\s*|\s+)([\d.]+)%\s*(?:,\s*|\s+)([\d.]+)%(?:\s*(?:,|\/)\s*[\d.%]+)?\s*\)$/i
  );
  if (hsl) return hslToRgb(hsl[1], hsl[2], hsl[3]);
  return null;
}

export function computeRelativeLuminance(rgb) {
  const c = Array.isArray(rgb) ? rgb : parseCssColor(rgb);
  if (!c || c.length < 3) return null;
  const lin = c.slice(0, 3).map((v) => {
    const n = Math.max(0, Math.min(255, Number(v) || 0)) / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function readHostContrast(storagePath = APP_STORAGE_PATH) {
  let fd;
  try {
    fd = openSync(storagePath, 'r');
    const mtime = fstatSync(fd).mtimeMs;
    if (storagePath === APP_STORAGE_PATH && mtime === cachedStorageMtime) return cachedStorageContrast;
    const m = readFileSync(fd, 'utf8').match(/"jetski\.contrast"\s*:\s*"?([12])"?/);
    const val = m ? Number(m[1]) : 1;
    if (storagePath === APP_STORAGE_PATH) {
      cachedStorageMtime = mtime;
      cachedStorageContrast = val;
    }
    return val;
  } catch {
    return 1;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function readHostThemePreset(storagePath = APP_STORAGE_PATH, mode = 'dark') {
  try {
    const data = readJsonSafe(storagePath, null);
    if (!data || typeof data !== 'object') return '';
    const key = mode === 'light' ? 'theme-preset-light' : 'theme-preset-dark';
    return typeof data[key] === 'string' ? data[key].trim() : '';
  } catch {
    return '';
  }
}

function findPluginThemeSeeds(themes, mode, presetName) {
  if (!Array.isArray(themes) || !presetName) return null;
  for (const item of themes) {
    if (!item || typeof item !== 'object') continue;
    const itemMode = item.mode === 'light' ? 'light' : 'dark';
    if (itemMode !== mode) continue;
    const name = String(item.label || item.id || '').trim();
    if (name === presetName && item.seeds && typeof item.seeds === 'object') {
      return item.seeds;
    }
  }
  return null;
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
  const isLight =
    rawMode === 1 ||
    rawMode === '1' ||
    rawMode === 'THEME_MODE_LIGHT' ||
    rawMode === 'light' ||
    rawMode === 'hcLight';
  const isDark = !isLight;
  const mode = isLight ? 'light' : 'dark';

  const rawContrast =
    userSettings?.contrast !== undefined
      ? userSettings.contrast
      : appStoragePath || input === CONFIG_JSON_PATH
        ? readHostContrast(appStoragePath)
        : 1;
  const highContrast =
    rawContrast === 2 ||
    rawContrast === '2' ||
    rawContrast === 'CONTRAST_HIGH' ||
    rawMode === 'hcDark' ||
    rawMode === 'hcLight';

  const c = highContrast
    ? { darkPct: '10%', darkAlpha: 0.1, lightPct: '12%', lightAlpha: 0.12, mutedPct: '4%', secDark: '14%', secLight: '8%', cardDark: '6.5%' }
    : { darkPct: '5%', darkAlpha: 0.05, lightPct: '7.5%', lightAlpha: 0.075, mutedPct: '2.5%', secDark: '12%', secLight: '6%', cardDark: '5%' };

  const explicitPreset =
    userSettings?.preset ||
    (isLight
      ? userSettings?.themePresetLight || userSettings?.['theme-preset-light']
      : userSettings?.themePresetDark || userSettings?.['theme-preset-dark']) ||
    (appStoragePath || input === CONFIG_JSON_PATH ? readHostThemePreset(appStoragePath, mode) : '');
  const presetTable = BUILT_IN_THEMES[mode] || {};
  const normalizedPresetName =
    explicitPreset === 'Onyx' || explicitPreset === 'onyx'
      ? isLight
        ? 'Onyx Light'
        : 'Onyx Dark'
      : explicitPreset;
  const isOnyx = normalizedPresetName === 'Onyx Light' || normalizedPresetName === 'Onyx Dark';
  const onyxTokens = isOnyx ? ONYX_THEME_TOKENS[mode][highContrast ? 'high' : 'normal'] : null;

  const builtInSeeds = (normalizedPresetName && presetTable[normalizedPresetName]) || null;
  const pluginSeeds =
    !builtInSeeds && normalizedPresetName
      ? findPluginThemeSeeds(userSettings?.themes, mode, normalizedPresetName)
      : null;
  const presetSeeds = onyxTokens
    ? {
        background: onyxTokens['--background'],
        foregroundOverride: onyxTokens['--foreground'],
        primary: onyxTokens['--primary'],
      }
    : builtInSeeds || pluginSeeds;

  const rawUserSeeds = (isLight ? userSettings?.customThemeSeedsLight : userSettings?.customThemeSeedsDark) || {};
  let userSeeds = rawUserSeeds;
  if (isOnyx && rawUserSeeds && typeof rawUserSeeds === 'object') {
    const defPreset = presetTable[isLight ? 'Default Light' : 'Default Dark'];
    const onyxPreset = presetTable[isLight ? 'Onyx Light' : 'Onyx Dark'];
    const sameHex = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
    const stripDefault = (val, d1, d2) => (!val || sameHex(val, d1) || sameHex(val, d2) ? undefined : val);
    userSeeds = { ...rawUserSeeds };
    const cleanBg = stripDefault(rawUserSeeds.background, defPreset?.background, onyxPreset?.background);
    const rawFg = rawUserSeeds.foregroundOverride || rawUserSeeds.foreground;
    const cleanFg = stripDefault(rawFg, defPreset?.foregroundOverride, onyxPreset?.foregroundOverride);
    const cleanPri = stripDefault(rawUserSeeds.primary, defPreset?.primary, onyxPreset?.primary);
    if (cleanBg === undefined) delete userSeeds.background;
    if (cleanFg === undefined) {
      delete userSeeds.foregroundOverride;
      delete userSeeds.foreground;
    }
    if (cleanPri === undefined) delete userSeeds.primary;
  }

  const rawSeeds = presetSeeds ? { ...presetSeeds, ...userSeeds } : userSeeds;
  const defaults = isLight
    ? { primary: '#f8f9fc', secondary: '#121317', tertiary: '#007acc' }
    : { primary: '#181818', secondary: '#ffffff', tertiary: '#007acc' };

  const fgSeed = rawSeeds.foregroundOverride || rawSeeds.foreground || rawSeeds.secondary || defaults.secondary;
  const seeds = rawSeeds.background
    ? {
        primary: rawSeeds.background,
        secondary: fgSeed,
        tertiary: rawSeeds.primary || rawSeeds.tertiary || defaults.tertiary,
      }
    : {
        primary: rawSeeds.primary || defaults.primary,
        secondary: fgSeed,
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
  const primaryLum = computeRelativeLuminance(parseCssColor(primary));
  const bgLum = computeRelativeLuminance(parseCssColor(bg)) ?? (isDark ? 0 : 1);
  const fgLum = computeRelativeLuminance(parseCssColor(fg)) ?? (isDark ? 1 : 0);
  const darkerEndpoint = fgLum < bgLum ? fg : bg;
  const explicitPrimaryFg =
    rawSeeds.primaryForegroundOverride ||
    rawSeeds.primaryForeground ||
    rawSeeds.primary_foreground;
  const primaryFg =
    explicitPrimaryFg ||
    (primaryLum !== null && primaryLum > 0.5 ? darkerEndpoint : '#ffffff');
  const explicitCodeFg =
    rawSeeds.codeForegroundOverride ||
    rawSeeds.codeForeground ||
    rawSeeds.code_foreground;
  const mixBase = isDark ? '#ffffff' : '#000000';
  const secPct = isDark ? c.secDark : c.secLight;
  const surface = `color-mix(in srgb, ${fg} ${c.mutedPct}, ${bg})`;
  const sidebar = `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${bg})`;
  const card = isLight ? '#ffffff' : `color-mix(in srgb, ${fg} ${c.cardDark}, ${bg})`;
  const secondary = `color-mix(in srgb, ${fg} ${secPct}, ${bg})`;
  const borderSolid = `color-mix(in srgb, ${fg} ${isLight ? c.lightPct : c.darkPct}, ${bg})`;
  const borderMix = `color-mix(in srgb, ${fg} ${isLight ? c.lightPct : c.darkPct}, transparent)`;
  const hover = isLight ? `rgba(0, 0, 0, ${c.lightAlpha})` : `rgba(255, 255, 255, ${c.darkAlpha})`;
  const linkColor = isDark ? '#6a9fcb' : '#3e8ed1';
  const scrimColor = isDark ? 'rgb(0 0 0 / 0.64)' : 'rgb(10 10 12 / 0.28)';
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
    '--muted': onyxTokens ? onyxTokens['--muted'] : surface,
    '--card': onyxTokens ? onyxTokens['--card'] : card,
    '--secondary': onyxTokens ? onyxTokens['--secondary'] : secondary,
    '--card-border': onyxTokens ? onyxTokens['--card-border'] : borderSolid,
    '--border': onyxTokens ? onyxTokens['--border'] : hover,
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

  const resolvedCard = vars['--card'];
  const onyxExtra = onyxTokens
    ? {
        '--onyx-frame': onyxTokens['--onyx-frame'],
        '--onyx-well': onyxTokens['--onyx-well'],
        '--onyx-raised': onyxTokens['--onyx-raised'],
        '--onyx-selected': onyxTokens['--onyx-selected'],
        '--onyx-key': onyxTokens['--onyx-key'],
      }
    : {};
  const cssVariables = {
    ...vars,
    ...onyxExtra,
    '--primary-foreground': primaryFg,
    '--secondary-foreground': onyxTokens
      ? onyxTokens['--secondary-foreground']
      : `color-mix(in srgb, ${fg} 75%, ${bg})`,
    '--muted-foreground': onyxTokens
      ? onyxTokens['--muted-foreground']
      : `color-mix(in srgb, ${fg} 50%, ${bg})`,
    '--placeholder': onyxTokens ? onyxTokens['--placeholder'] : `color-mix(in srgb, ${fg} 30%, ${bg})`,
    '--sidebar': onyxTokens ? onyxTokens['--sidebar'] : sidebar,
    '--sidebar-secondary': onyxTokens
      ? onyxTokens['--sidebar-secondary']
      : `color-mix(in srgb, ${mixBase} ${secPct}, ${sidebar})`,
    '--sidebar-muted': onyxTokens
      ? onyxTokens['--sidebar-muted']
      : `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${sidebar})`,
    '--shell': onyxTokens ? onyxTokens['--shell'] : bg,
    '--glass': onyxTokens ? onyxTokens['--glass'] : resolvedCard,
    '--glass-border': onyxTokens ? onyxTokens['--glass-border'] : hover,
    '--glass-highlight': onyxTokens ? onyxTokens['--glass-highlight'] : 'transparent',
    '--scrim': onyxTokens ? onyxTokens['--scrim'] : scrimColor,
    '--link': onyxTokens ? onyxTokens['--link'] : linkColor,
    '--cta': onyxTokens ? onyxTokens['--cta'] : primary,
    '--cta-foreground': onyxTokens ? onyxTokens['--cta-foreground'] : primaryFg,
    '--content': bg,
    '--accent': onyxTokens ? onyxTokens['--accent'] : primary,
    '--error': onyxTokens ? onyxTokens['--error'] : isDark ? '#de5555' : '#f05151',
    '--warning': onyxTokens ? onyxTokens['--warning'] : isDark ? '#f3c949' : '#ac830b',
    '--success': onyxTokens ? onyxTokens['--success'] : isDark ? '#7aae66' : '#58983f',
    '--code-foreground':
      explicitCodeFg ||
      (onyxTokens ? onyxTokens['--code-foreground'] : isDark ? '#d7ba7d' : '#a31515'),
    '--agy-ink': fg,
    '--agy-canvas': bg,
    '--agy-accent': primary,
    '--agy-card': resolvedCard,
    '--agy-raised': isLight ? `color-mix(in srgb, ${resolvedCard} 25%, #ffffff)` : resolvedCard,
    '--agy-ink-soft': `color-mix(in srgb, ${fg} 88%, ${bg})`,
  };
  const luminance = bgLum;

  return {
    theme: presetSeeds ? normalizedPresetName : isDark ? 'Antigravity Dark' : 'Antigravity Light',
    themeType: mode,
    mode,
    contrast: highContrast ? 'high' : 'normal',
    isDark,
    luminance,
    cssVariables,
    vars,
  };
}

let cachedHostCss = '';
let cachedHostCssAddr = '';
export async function fetchHostStylesheet({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  fetchFn = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (cachedHostCss && cachedHostCssAddr === lsAddress && !forceRefresh) return cachedHostCss;
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
      if (!forceRefresh) {
        cachedHostCss = wrapped;
        cachedHostCssAddr = lsAddress;
      }
      return wrapped;
    } catch { /* try next candidate */ }
  }
  return '';
}
