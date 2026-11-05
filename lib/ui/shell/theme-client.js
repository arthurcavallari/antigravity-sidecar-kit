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
    const rgb = t.match(
      /^rgba?\(\s*([\d.]+)\s*(?:,\s*|\s+)([\d.]+)\s*(?:,\s*|\s+)([\d.]+)(?:\s*(?:,|\/)\s*(\d+(?:\.\d+)?%?|\.\d+%?))?\s*\)$/i
    );
    if (rgb) {
      const out = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
      if (rgb[4] !== undefined) {
        out.a = rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
      }
      return out;
    }
    const hsl = t.match(
      /^hsla?\(\s*([+-]?[\d.]+)(?:deg)?\s*(?:,\s*|\s+)([\d.]+)%\s*(?:,\s*|\s+)([\d.]+)%(?:\s*(?:,|\/)\s*(\d+(?:\.\d+)?%?|\.\d+%?))?\s*\)$/i
    );
    if (hsl) {
      const h = (((Number(hsl[1]) || 0) % 360) + 360) % 360;
      const s = Math.max(0, Math.min(100, Number(hsl[2]) || 0)) / 100;
      const l = Math.max(0, Math.min(100, Number(hsl[3]) || 0)) / 100;
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
      const out = {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255),
      };
      if (hsl[4] !== undefined) {
        out.a = hsl[4].endsWith('%') ? Number(hsl[4].slice(0, -1)) / 100 : Number(hsl[4]);
      }
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
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
      const parsed =
        parseCssColor(root.style?.getPropertyValue?.('--background')) ||
        parseCssColor(root.style?.getPropertyValue?.('--vscode-editor-background')) ||
        (cs ? parseCssColor(cs.getPropertyValue('--background')) || parseCssColor(cs.getPropertyValue('--vscode-editor-background')) : null);
      if (parsed) return computeRelativeLuminance(parsed) < DARK_LUMINANCE_THRESHOLD;
      if (
        root.classList?.contains?.('dark') ||
        root.classList?.contains?.('theme-dark') ||
        root.dataset?.theme === 'dark'
      ) {
        return true;
      }
      if (
        root.classList?.contains?.('light') ||
        root.classList?.contains?.('theme-light') ||
        root.dataset?.theme === 'light'
      ) {
        return false;
      }
    }
    try {
      const qTheme =
        typeof URLSearchParams === 'function' && typeof window !== 'undefined'
          ? new URLSearchParams(window.location?.search || '').get('hostTheme')
          : '';
      if (qTheme === 'dark') return true;
      if (qTheme === 'light') return false;
    } catch {}
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
      const body = typeof document !== 'undefined' ? document.body : null;
      if (body) {
        body.setAttribute?.('data-agy-theme', '');
        if (!body.hasAttribute?.('data-newux-theme')) {
          body.setAttribute?.('data-newux-theme', '');
        }
        body.classList?.toggle?.('dark', dark);
      }
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
  const ONYX_SURFACE_FALLBACKS = {
    dark: {
      '--onyx-frame': '#0D0D11',
      '--onyx-well': '#111115',
      '--onyx-raised': '#15151A',
      '--onyx-selected': '#1F1F24',
      '--onyx-key': '#24252A',
    },
    light: {
      '--onyx-frame': '#F9F9F9',
      '--onyx-well': 'rgb(10 10 12 / 0.055)',
      '--onyx-raised': '#FFFFFF',
      '--onyx-selected': '#FFFFFF',
      '--onyx-key': '#FFFFFF',
    },
  };

  function applyAgyThemeFromPayload(payload, cache = true) {
    if (!payload || typeof payload.cssVariables !== 'object') return false;
    const cv = payload.cssVariables;
    const hasHostVars = Boolean(
      cv['--background'] || cv['--vscode-editor-background'] || cv['--foreground'] || cv['--card']
    );
    const bgRgb =
      parseCssColor(cv['--background']) || parseCssColor(cv['--vscode-editor-background']);
    const lum = bgRgb ? computeRelativeLuminance(bgRgb) : null;
    const isDark =
      lum !== null
        ? lum < DARK_LUMINANCE_THRESHOLD
        : payload.themeType !== 'light' && payload.themeType !== 'hcLight' && payload.isDark !== false;
    const nextTheme = isDark ? 'dark' : 'light';
    const isOnyxPayload =
      Boolean(cv['--onyx-key'] || cv['--onyx-well']) ||
      /onyx/i.test(String(payload.theme || payload.preset || '')) ||
      /^#0[57]0[57]0[79]$/i.test(String(cv['--background'] || '').trim()) ||
      /^rgb\(\s*(?:255[\s,]+255[\s,]+255|10[\s,]+10[\s,]+12)\b/i.test(
        String(cv['--secondary'] || cv['--muted'] || '').trim()
      );
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
          const onyxMap = ONYX_SURFACE_FALLBACKS[nextTheme];
          for (const [k, fallbackVal] of Object.entries(onyxMap)) {
            if (isOnyxPayload) {
              const targetVal = cv[k] || fallbackVal;
              if (style.getPropertyValue?.(k) !== targetVal) {
                style.setProperty(k, targetVal);
              }
            } else if (!cv[k]) {
              style.removeProperty?.(k);
            }
          }
        }
      }
      if (typeof document !== 'undefined' && document.documentElement) {
        const root = document.documentElement;
        if (typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-follow-host')) {
          root.toggleAttribute?.('data-follow-host', true);
        }
        if (root.dataset && root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
      }
      if (typeof document !== 'undefined' && document.body) {
        document.body.setAttribute?.('data-agy-theme', '');
        document.body.setAttribute?.('data-newux-theme', isOnyxPayload ? 'onyx' : '');
        document.body.classList?.toggle?.('dark', isDark);
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
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('message', (event) => {
      if (event?.source && window.parent && event.source !== window.parent && event.source !== window) return;
      const data = event?.data;
      if (data && data.type === 'theme-change' && data.payload) {
        applyAgyThemeFromPayload(data.payload, true);
      }
    });
  }
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
    new MutationObserver(() => syncAgyThemeAttributes()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }
})();
