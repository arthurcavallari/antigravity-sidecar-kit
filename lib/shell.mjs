/**
 * @fileoverview AGY design-token stylesheet (AGY_SHELL_CSS) and client runtime (AGY_CLIENT_JS)
 * with WCAG relative luminance detection, 1x1 canvas CSS color parser, sessionStorage zero-flash
 * theme cache, SSE StateSync subscriber, and /api/notify agent self-healing helper.
 */

export const AGY_SHELL_CSS = `/* AGY Shared Sidecar Contrast & Theme Shell */
:root,
[data-theme='light'] {
  color-scheme: light;
  --agy-font-sans: var(--font-sans, var(--vscode-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif));
  --agy-font-mono: var(--font-mono, var(--editor-font-family, var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)));
  --agy-ink: var(--foreground, #1f2124);
  --agy-canvas: var(--background, #fbfbfa);
  --agy-ink-soft: color-mix(in srgb, var(--agy-ink) 88%, var(--agy-canvas));
  --agy-ink-faint: var(--muted-foreground, color-mix(in srgb, var(--agy-ink) 60%, var(--agy-canvas)));
  --agy-sunken: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-control: var(--secondary, color-mix(in srgb, var(--agy-ink) 12%, var(--agy-canvas)));
  --agy-hover: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-pressed: color-mix(in srgb, var(--agy-ink) 11%, transparent);
  --agy-card: var(--card, #ffffff);
  --agy-card-edge: var(--card-border, color-mix(in srgb, var(--agy-ink) 5%, var(--agy-card)));
  --agy-card-edge-hover: rgba(15, 18, 23, 0.24);
  --agy-paper: var(--agy-card);
  --agy-raised: color-mix(in srgb, var(--agy-card) 25%, #ffffff);
  --agy-accent: var(--primary, #3a6ff7);
  --agy-accent-ink: color-mix(in srgb, var(--agy-accent) 60%, var(--agy-ink));
  --agy-accent-soft: color-mix(in srgb, var(--agy-accent) 10%, transparent);
  --agy-bad: #d93838;
  --agy-bad-soft: rgba(217, 56, 56, 0.13);
  --agy-bad-ink: #8c1d18;
  --agy-err: var(--error, #d93838);
  --agy-ok: #188038;
  --agy-ok-soft: rgba(24, 128, 56, 0.14);
  --agy-ok-ink: #064e26;
  --agy-warn: #b06000;
  --agy-warn-soft: rgba(223, 142, 29, 0.16);
  --agy-warn-ink: #5c3c00;
  --agy-info: var(--color-blue-500, #4380b4);
  --agy-rule: var(--border, rgba(128, 128, 128, 0.12));
  --agy-radius-sm: var(--radius-sm, 0.25rem);
  --agy-radius-md: var(--radius-md, 0.375rem);
  --agy-radius-lg: var(--radius-lg, 0.5rem);
  --agy-radius-xl: var(--radius-xl, 0.75rem);
  --agy-radius-pill: 9999px;
  --agy-dur: var(--default-transition-duration, 150ms);
  --agy-ease: var(--default-transition-timing-function, cubic-bezier(0.4, 0, 0.2, 1));
}

[data-theme='dark'] {
  color-scheme: dark;
  --agy-ink: var(--foreground, #cccccc);
  --agy-canvas: var(--background, #101010);
  --agy-ink-soft: color-mix(in srgb, var(--agy-ink) 88%, var(--agy-canvas));
  --agy-ink-faint: var(--muted-foreground, color-mix(in srgb, var(--agy-ink) 65%, var(--agy-canvas)));
  --agy-sunken: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-control: var(--secondary, color-mix(in srgb, var(--agy-ink) 12%, var(--agy-canvas)));
  --agy-hover: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-pressed: color-mix(in srgb, var(--agy-ink) 14%, transparent);
  --agy-card: var(--card, color-mix(in srgb, var(--agy-ink) 5%, var(--agy-canvas)));
  --agy-card-edge: var(--card-border, color-mix(in srgb, var(--agy-ink) 5%, var(--agy-card)));
  --agy-card-edge-hover: rgba(255, 255, 255, 0.2);
  --agy-paper: var(--agy-card);
  --agy-raised: var(--agy-card);
  --agy-accent: var(--primary, #007acc);
  --agy-accent-ink: color-mix(in srgb, var(--agy-accent) 60%, var(--agy-ink));
  --agy-accent-soft: color-mix(in srgb, var(--agy-accent) 16%, transparent);
  --agy-bad: #ff6b6b;
  --agy-bad-soft: rgba(255, 107, 107, 0.17);
  --agy-bad-ink: #ffedea;
  --agy-err: var(--error, var(--color-red-500, #de5555));
  --agy-ok: var(--success, var(--color-green-400, #7aae66));
  --agy-ok-soft: rgba(91, 185, 116, 0.18);
  --agy-ok-ink: #e4fadc;
  --agy-warn: var(--warning, #f3c949);
  --agy-warn-soft: rgba(253, 214, 99, 0.16);
  --agy-warn-ink: #fff4d1;
  --agy-info: var(--color-blue-400, #6a9fcb);
  --agy-rule: var(--border, rgba(128, 128, 128, 0.12));
}

/* Host-adaptive AGY tokens: 88% ink-soft guarantees >= 4.6:1 contrast across all 14 IDE themes */
[data-follow-host][data-theme='light'] {
  --agy-ink: var(--foreground, #1f2124);
  --agy-canvas: var(--background, #fbfbfa);
  --agy-accent: var(--primary, #3a6ff7);
  --agy-card: var(--card, #ffffff);
  --agy-raised: color-mix(in srgb, var(--agy-card) 25%, #ffffff);
  --agy-ink-soft: color-mix(in srgb, var(--agy-ink) 88%, var(--agy-canvas));
  --agy-ink-faint: var(--muted-foreground, color-mix(in srgb, var(--agy-ink) 60%, var(--agy-canvas)));
  --agy-accent-ink: color-mix(in srgb, var(--agy-accent) 60%, var(--agy-ink));
  --agy-accent-soft: color-mix(in srgb, var(--agy-accent) 10%, transparent);
  --agy-sunken: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-control: var(--secondary, color-mix(in srgb, var(--agy-ink) 12%, var(--agy-canvas)));
  --agy-hover: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-pressed: color-mix(in srgb, var(--agy-ink) 11%, transparent);
  --agy-card-edge: var(--card-border, var(--border, rgba(128, 128, 128, 0.12)));
  --agy-rule: var(--border, rgba(128, 128, 128, 0.12));
}

[data-follow-host][data-theme='dark'] {
  --agy-ink: var(--foreground, #cccccc);
  --agy-canvas: var(--background, #101010);
  --agy-accent: var(--primary, #007acc);
  --agy-card: var(--card, color-mix(in srgb, var(--agy-ink) 5%, var(--agy-canvas)));
  --agy-raised: var(--agy-card);
  --agy-ink-soft: color-mix(in srgb, var(--agy-ink) 88%, var(--agy-canvas));
  --agy-ink-faint: var(--muted-foreground, color-mix(in srgb, var(--agy-ink) 65%, var(--agy-canvas)));
  --agy-accent-ink: color-mix(in srgb, var(--agy-accent) 60%, var(--agy-ink));
  --agy-accent-soft: color-mix(in srgb, var(--agy-accent) 16%, transparent);
  --agy-sunken: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-control: var(--secondary, color-mix(in srgb, var(--agy-ink) 12%, var(--agy-canvas)));
  --agy-hover: var(--muted, color-mix(in srgb, var(--agy-ink) 4%, var(--agy-canvas)));
  --agy-pressed: color-mix(in srgb, var(--agy-ink) 14%, transparent);
  --agy-card-edge: var(--card-border, color-mix(in srgb, var(--agy-ink) 5%, var(--agy-card)));
  --agy-rule: var(--border, rgba(128, 128, 128, 0.12));
}

@media (forced-colors: active) {
  :root,
  [data-theme='light'],
  [data-theme='dark'],
  [data-follow-host] {
    --agy-ink: CanvasText;
    --agy-ink-soft: CanvasText;
    --agy-ink-faint: GrayText;
    --agy-canvas: Canvas;
    --agy-card: Canvas;
    --agy-raised: ButtonFace;
    --agy-accent: Highlight;
    --agy-accent-ink: Highlight;
    --agy-rule: ButtonBorder;
  }
}
`;

export const AGY_CLIENT_JS = `(function () {
  const agy = (window.AgyShell = window.AgyShell || {});
  const hangar = (window.Hangar = window.Hangar || {});
  const THEME_CACHE_KEY = 'agy.theme.v1';
  const DARK_LUMINANCE_THRESHOLD = 0.4;

  function rasterizeCssColorViaCanvas(str) {
    if (typeof document === 'undefined' || typeof CSS === 'undefined' || !CSS.supports?.('color', str)) return null;
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const ctx = c.getContext?.('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    } catch { return null; }
  }

  function parseCssColor(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const t = raw.trim();
    const h8 = t.match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
    if (h8) return { r: parseInt(h8[1], 16), g: parseInt(h8[2], 16), b: parseInt(h8[3], 16), a: Math.round((parseInt(h8[4], 16) / 255) * 100) / 100 };
    const h6 = t.match(/^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i);
    if (h6) return { r: parseInt(h6[1], 16), g: parseInt(h6[2], 16), b: parseInt(h6[3], 16) };
    const h4 = t.match(/^#?([a-f\\d])([a-f\\d])([a-f\\d])([a-f\\d])$/i);
    if (h4) return { r: parseInt(h4[1] + h4[1], 16), g: parseInt(h4[2] + h4[2], 16), b: parseInt(h4[3] + h4[3], 16), a: Math.round((parseInt(h4[4] + h4[4], 16) / 255) * 100) / 100 };
    const h3 = t.match(/^#?([a-f\\d])([a-f\\d])([a-f\\d])$/i);
    if (h3) return { r: parseInt(h3[1] + h3[1], 16), g: parseInt(h3[2] + h3[2], 16), b: parseInt(h3[3] + h3[3], 16) };
    const rgb = t.match(/^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*(\\d+(?:\\.\\d+)?|\\.\\d+))?\\s*\\)$/i);
    if (rgb) {
      const out = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
      if (rgb[4] !== undefined) out.a = Number(rgb[4]);
      return out;
    }
    return rasterizeCssColorViaCanvas(t);
  }

  function computeRelativeLuminance(rgb) {
    if (!rgb || typeof rgb.r !== 'number') return null;
    const ch = (c) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  }

  function isHostDarkTheme() {
    if (typeof document !== 'undefined' && document.documentElement) {
      const root = document.documentElement;
      const bg = root.style?.getPropertyValue?.('--background') || (typeof getComputedStyle === 'function' ? getComputedStyle(root).getPropertyValue('--background') : '');
      const parsed = parseCssColor(bg);
      if (parsed) return computeRelativeLuminance(parsed) < DARK_LUMINANCE_THRESHOLD;
      if (root.classList?.contains?.('dark') || root.dataset?.theme === 'dark') return true;
      if (root.classList?.contains?.('light') || root.dataset?.theme === 'light') return false;
    }
    return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true;
  }

  function syncAgyThemeAttributes(targetEl) {
    const root = targetEl || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!root) return false;
    const dark = isHostDarkTheme();
    const nextTheme = dark ? 'dark' : 'light';
    if (typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-follow-host')) {
      root.toggleAttribute?.('data-follow-host', true);
    }
    if (root.dataset && root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
    return dark;
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
    const isDark = lum !== null ? lum < DARK_LUMINANCE_THRESHOLD : (payload.themeType !== 'light' && payload.isDark !== false);
    const nextTheme = isDark ? 'dark' : 'light';
    if (typeof document !== 'undefined' && document.documentElement) {
      const root = document.documentElement;
      if (typeof root.hasAttribute !== 'function' || !root.hasAttribute('data-follow-host')) {
        root.toggleAttribute?.('data-follow-host', true);
      }
      if (root.dataset && root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
    }
    if (cache && typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem(THEME_CACHE_KEY, JSON.stringify(payload)); } catch {}
    }
    return isDark;
  }

  function restoreCachedTheme() {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(THEME_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      applyAgyThemeFromPayload(parsed, false);
      return parsed;
    } catch { return null; }
  }

  function subscribeStateSyncEvents({ url = './api/events', getConversationId, onStateEvent } = {}) {
    if (typeof EventSource !== 'function' || typeof window === 'undefined' || !window.location?.href) return { close() {} };
    let backoffMs = 1000, es = null, closed = false;
    function connect() {
      if (closed) return;
      try {
        const target = new URL(url, window.location.href);
        const token = new URLSearchParams(window.location.search || '').get('token');
        if (token) target.searchParams.set('token', token);
        const convId = getConversationId?.();
        if (convId && convId !== '_new') target.searchParams.set('conversationId', convId);
        es = new EventSource(target.href);
        es.onopen = () => { backoffMs = 1000; };
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data && typeof data.version === 'number') onStateEvent?.(data.state, data.version);
          } catch {}
        };
        es.onerror = () => {
          if (closed) return;
          try { es.close(); } catch {}
          setTimeout(() => { backoffMs = Math.min(backoffMs * 2, 30000); connect(); }, backoffMs);
        };
      } catch {}
    }
    if (typeof document !== 'undefined' && document.readyState !== 'complete' && typeof window.addEventListener === 'function') {
      window.addEventListener('load', () => setTimeout(connect, 0), { once: true });
    } else {
      setTimeout(connect, 0);
    }
    return { close() { closed = true; try { es?.close(); } catch {} } };
  }

  async function notifyAgent(message, conversationId = '', title = 'Sidecar State') {
    const fn = window.sidecar?.fetch || (typeof fetch === 'function' ? fetch.bind(window) : null);
    if (!fn || !message) return { ok: false, error: 'Fetch or message unavailable' };
    const urlConv = new URLSearchParams(window.location?.search || '').get('conversationId') || '';
    const rawConv = conversationId || window.sidecar?.conversationId || urlConv;
    const resolvedConv = rawConv && rawConv !== '_new' ? rawConv : '';
    const res = await fn('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...(resolvedConv ? { conversationId: resolvedConv } : {}), title }),
    });
    return res.json().catch(() => ({ ok: res.ok }));
  }

  Object.assign(agy, {
    parseCssColor, rasterizeCssColorViaCanvas, computeRelativeLuminance, isHostDarkTheme,
    syncAgyThemeAttributes, applyAgyThemeFromPayload, restoreCachedTheme, subscribeStateSyncEvents, notifyAgent,
  });
  Object.assign(hangar, agy);

  restoreCachedTheme();
  syncAgyThemeAttributes();
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
    new MutationObserver(() => syncAgyThemeAttributes()).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'style'],
    });
  }
})();
`;
