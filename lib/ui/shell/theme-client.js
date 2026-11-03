(function () {
  const agy = (window.AgyShell = window.AgyShell || {});
  const THEME_CACHE_KEY = 'agy.theme.v1';
  const DARK_LUMINANCE_THRESHOLD = 0.4;
  let applyingTheme = false;

  function rasterizeCssColorViaCanvas(str) {
    if (typeof document === 'undefined' || typeof CSS === 'undefined' || !CSS.supports?.('color', str)) return null;
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext?.('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    } catch {
      return null;
    }
  }

  function parseCssColor(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const t = raw.trim();
    const h8 = t.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (h8) {
      return {
        r: parseInt(h8[1], 16),
        g: parseInt(h8[2], 16),
        b: parseInt(h8[3], 16),
        a: Math.round((parseInt(h8[4], 16) / 255) * 100) / 100,
      };
    }
    const h6 = t.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (h6) return { r: parseInt(h6[1], 16), g: parseInt(h6[2], 16), b: parseInt(h6[3], 16) };
    const h4 = t.match(/^#?([a-f\d])([a-f\d])([a-f\d])([a-f\d])$/i);
    if (h4) {
      return {
        r: parseInt(h4[1] + h4[1], 16),
        g: parseInt(h4[2] + h4[2], 16),
        b: parseInt(h4[3] + h4[3], 16),
        a: Math.round((parseInt(h4[4] + h4[4], 16) / 255) * 100) / 100,
      };
    }
    const h3 = t.match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
    if (h3) {
      return { r: parseInt(h3[1] + h3[1], 16), g: parseInt(h3[2] + h3[2], 16), b: parseInt(h3[3] + h3[3], 16) };
    }
    const rgb = t.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+(?:\.\d+)?|\.\d+))?\s*\)$/i);
    if (rgb) {
      const out = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
      if (rgb[4] !== undefined) out.a = Number(rgb[4]);
      return out;
    }
    return rasterizeCssColorViaCanvas(t);
  }

  function computeRelativeLuminance(rgb) {
    if (!rgb || typeof rgb.r !== 'number') return null;
    const ch = (c) => {
      const n = c / 255;
      return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  }

  function isHostDarkTheme() {
    if (typeof document !== 'undefined' && document.documentElement) {
      const root = document.documentElement;
      const bg =
        root.style?.getPropertyValue?.('--background') ||
        (typeof getComputedStyle === 'function' ? getComputedStyle(root).getPropertyValue('--background') : '');
      const parsed = parseCssColor(bg);
      if (parsed) return computeRelativeLuminance(parsed) < DARK_LUMINANCE_THRESHOLD;
      if (root.classList?.contains?.('dark') || root.dataset?.theme === 'dark') return true;
      if (root.classList?.contains?.('light') || root.dataset?.theme === 'light') return false;
    }
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true;
  }

  function syncAgyThemeAttributes(targetEl) {
    if (applyingTheme) return false;
    const root = targetEl || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!root) return false;
    applyingTheme = true;
    try {
      const dark = isHostDarkTheme();
      const nextTheme = dark ? 'dark' : 'light';
      if (typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-follow-host')) {
        root.toggleAttribute?.('data-follow-host', true);
      }
      if (root.dataset && root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
      return dark;
    } finally {
      applyingTheme = false;
    }
  }

  const AGY_INLINE_TOKEN_KEYS = [
    '--agy-canvas', '--agy-ink', '--agy-ink-soft', '--agy-ink-faint',
    '--agy-card', '--agy-card-edge', '--agy-control', '--agy-hover',
    '--agy-sunken', '--agy-rule', '--agy-accent', '--agy-raised',
  ];

  function applyAgyThemeFromPayload(payload, cache = true) {
    if (!payload || typeof payload.cssVariables !== 'object') return false;
    const cv = payload.cssVariables;
    const hasHostVars = Boolean(cv['--background'] || cv['--foreground'] || cv['--card']);
    applyingTheme = true;
    try {
      if (typeof document !== 'undefined' && document.documentElement?.style) {
        const style = document.documentElement.style;
        for (const [k, v] of Object.entries(cv)) {
          if (hasHostVars && k.startsWith('--agy-')) {
            style.removeProperty?.(k);
            continue;
          }
          if (v && style.getPropertyValue?.(k) !== v) {
            style.setProperty(k, v);
          }
        }
        if (hasHostVars) {
          for (const k of AGY_INLINE_TOKEN_KEYS) style.removeProperty?.(k);
        }
      }
      const bgRgb = parseCssColor(payload.cssVariables['--background']);
      const lum = bgRgb ? computeRelativeLuminance(bgRgb) : null;
      const isDark =
        lum !== null ? lum < DARK_LUMINANCE_THRESHOLD : payload.themeType !== 'light' && payload.isDark !== false;
      const nextTheme = isDark ? 'dark' : 'light';
      if (typeof document !== 'undefined' && document.documentElement) {
        const root = document.documentElement;
        if (typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-follow-host')) {
          root.toggleAttribute?.('data-follow-host', true);
        }
        if (root.dataset && root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
      }
      if (cache && typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem(THEME_CACHE_KEY, JSON.stringify(payload));
        } catch {}
      }
      return isDark;
    } finally {
      applyingTheme = false;
    }
  }

  function restoreCachedTheme() {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(THEME_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      applyAgyThemeFromPayload(parsed, false);
      return parsed;
    } catch {
      return null;
    }
  }

  Object.assign(agy, {
    parseCssColor,
    rasterizeCssColorViaCanvas,
    computeRelativeLuminance,
    isHostDarkTheme,
    syncAgyThemeAttributes,
    applyAgyThemeFromPayload,
    restoreCachedTheme,
  });

  restoreCachedTheme();
  syncAgyThemeAttributes();
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
    new MutationObserver(() => syncAgyThemeAttributes()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
})();
