(function () {
  const agy = (window.AgyShell = window.AgyShell || {});
  function getUiToken() {
    try {
      const qTok = new URLSearchParams(window.location?.search || '').get('token');
      if (qTok) return (window.__AGY_TOKEN__ = qTok);
      if (window.__AGY_TOKEN__) return window.__AGY_TOKEN__;
      for (const el of document?.querySelectorAll?.('script[src*="token="], link[href*="token="]') || []) {
        const tok = new URL(el.getAttribute?.('src') || el.getAttribute?.('href') || '', 'http://127.0.0.1').searchParams.get('token');
        if (tok) return (window.__AGY_TOKEN__ = tok);
      }
    } catch {}
    return '';
  }

  function createVisibilityWatcher(watcherOpts = {}) {
    const enabled = watcherOpts.enabled !== false;
    let hostVisible = true;
    let inViewport = true;
    let observer = null;
    let listenersAttached = false;

    const isVisible = () => {
      if (!enabled) return true;
      return Boolean(hostVisible && inViewport && !(typeof document !== 'undefined' && document.hidden));
    };

    const notifyChange = () => {
      watcherOpts.onVisibilityChange?.(isVisible());
      watcherOpts.onSync?.();
    };

    const onMessage = (e) => {
      if (e?.source && window.parent && e.source !== window.parent && e.source !== window) return;
      watcherOpts.onHostMessage?.(e);
      const d = e?.data;
      if (d?.type !== 'sidecar-visibility') return;
      const next = typeof d?.payload?.visible === 'boolean' ? d.payload.visible : typeof d?.visible === 'boolean' ? d.visible : null;
      if (next !== null && next !== hostVisible) {
        hostVisible = next;
        notifyChange();
      }
    };

    const onDocVisibility = () => {
      notifyChange();
    };

    function attach() {
      if (!enabled || listenersAttached) return;
      listenersAttached = true;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', onMessage);
      }
      if (typeof IntersectionObserver === 'function' && typeof document !== 'undefined' && document.documentElement && !observer) {
        try {
          observer = new IntersectionObserver((entries) => {
            const last = entries && entries[entries.length - 1];
            if (!last || typeof last.isIntersecting !== 'boolean' || last.isIntersecting === inViewport) return;
            inViewport = last.isIntersecting;
            notifyChange();
          });
          observer.observe(document.documentElement);
        } catch {}
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onDocVisibility);
      }
    }

    function detach() {
      if (!listenersAttached) return;
      listenersAttached = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', onMessage);
      }
      if (observer) {
        try {
          observer.disconnect?.();
        } catch {}
        observer = null;
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onDocVisibility);
      }
    }

    return { attach, detach, isVisible };
  }

  function subscribeStateSyncEvents(optionsOrFn = {}, maybeOpts = {}) {
    const ES = (typeof window !== 'undefined' && window.EventSource) || (typeof EventSource === 'function' ? EventSource : null);
    if (typeof ES !== 'function' || typeof window === 'undefined') {
      return { close() {}, isVisible: () => false };
    }
    const opts = typeof optionsOrFn === 'function' ? { ...maybeOpts, onStateEvent: optionsOrFn } : optionsOrFn || {};
    const { url = opts.path || './api/events', getConversationId, onStateEvent } = opts;
    let backoffMs = 1000;
    let es = null;
    let activeClientId = '';
    let reconnectTimer = null;
    let initTimer = null;
    let loadHandler = null;
    let pageHideHandler = null;
    let ready = false;
    let closed = false;
    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        if (typeof clearTimeout === 'function') clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const clearInitTimer = () => {
      if (initTimer !== null) {
        if (typeof clearTimeout === 'function') clearTimeout(initTimer);
        initTimer = null;
      }
    };

    function resolveCloseHref() {
      if (typeof URL === 'function' && window.location?.href) {
        const u = new URL(url, window.location.href);
        u.pathname = `${u.pathname.replace(/\/+$/, '')}/close`;
        return u.href;
      }
      const qIdx = url.indexOf('?');
      const base = (qIdx >= 0 ? url.slice(0, qIdx) : url).replace(/\/+$/, '');
      const qs = qIdx >= 0 ? url.slice(qIdx) : '';
      return `${base}/close${qs}`;
    }

    function notifyServerDisconnect(cid) {
      if (!cid) return;
      const fn =
        window.sidecar?.fetch ||
        (typeof window.fetch === 'function' ? window.fetch.bind(window) : typeof fetch === 'function' ? fetch : null);
      if (typeof fn !== 'function') return;
      try {
        const tok = getUiToken();
        Promise.resolve(
          fn(resolveCloseHref(), {
            method: 'POST',
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              ...(tok ? { 'X-Sidecar-Token': tok } : {}),
            },
            body: JSON.stringify({ clientId: cid }),
          })
        ).catch(() => {});
      } catch {}
    }

    const watcher = createVisibilityWatcher({
      enabled: opts.pauseWhenHidden !== false,
      onVisibilityChange: opts.onVisibilityChange,
      onSync: syncConnection,
    });

    function disconnect() {
      clearReconnect();
      backoffMs = 1000;
      if (!es) return;
      const cur = es;
      const cid = activeClientId;
      es = null;
      activeClientId = '';
      try {
        cur.close();
      } catch {}
      notifyServerDisconnect(cid);
    }

    function connect() {
      clearReconnect();
      if (closed || !watcher.isVisible()) return;
      try {
        if (es) {
          const prev = es;
          const prevCid = activeClientId;
          es = null;
          activeClientId = '';
          try {
            prev.close();
          } catch {}
          notifyServerDisconnect(prevCid);
        }
        const token = getUiToken();
        const convId = opts.conversationId || getConversationId?.();
        const nextCid = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        let targetHref = url;
        if (typeof URL === 'function' && window.location?.href) {
          const target = new URL(url, window.location.href);
          if (token) target.searchParams.set('token', token);
          if (convId && convId !== '_new') {
            target.searchParams.set('conversationId', convId);
            target.searchParams.set('conversation', convId);
          }
          target.searchParams.set('clientId', nextCid);
          targetHref = target.href;
        } else {
          const qp = new URLSearchParams();
          if (token) qp.set('token', token);
          if (convId && convId !== '_new') {
            qp.set('conversationId', convId);
            qp.set('conversation', convId);
          }
          qp.set('clientId', nextCid);
          const qs = qp.toString();
          targetHref = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
        }
        const nextEs = new ES(targetHref);
        es = nextEs;
        activeClientId = nextCid;
        nextEs.onopen = () => {
          backoffMs = 1000;
        };
        const handleEvent = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data && typeof data.version === 'number') {
              onStateEvent?.(data.state !== undefined ? data.state : data, data.version);
            } else if (data && typeof onStateEvent === 'function') {
              onStateEvent(data.state !== undefined ? data.state : data.data !== undefined ? data.data : data, data._version ?? 0);
            }
          } catch {}
        };
        nextEs.onmessage = handleEvent;
        nextEs.addEventListener?.('state', handleEvent);
        nextEs.addEventListener?.('state_changed', handleEvent);
        nextEs.addEventListener?.('sse_lease_expired', (ev) => {
          try {
            const parsed = JSON.parse(ev.data);
            const retryMs = Number(parsed?.retryMs);
            if (retryMs > backoffMs) {
              backoffMs = Math.min(retryMs, 60000);
            }
          } catch {
            backoffMs = Math.max(backoffMs, 15000);
          }
        });
        nextEs.onerror = () => {
          if (closed || es !== nextEs || reconnectTimer !== null) return;
          es = null;
          activeClientId = '';
          try {
            nextEs.close();
          } catch {}
          if (!watcher.isVisible()) return;
          const delayMs = backoffMs;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (closed || !watcher.isVisible()) return;
            backoffMs = Math.min(backoffMs * 2, 30000);
            connect();
          }, delayMs);
        };
      } catch {}
    }

    function syncConnection() {
      if (closed || !ready) return;
      if (!watcher.isVisible()) {
        disconnect();
        return;
      }
      if (!es && reconnectTimer === null) {
        connect();
      }
    }

    watcher.attach();
    if (typeof window.addEventListener === 'function') {
      pageHideHandler = () => {
        disconnect();
      };
      window.addEventListener('pagehide', pageHideHandler);
    }
    if (typeof document !== 'undefined' && document.readyState !== 'complete' && typeof window.addEventListener === 'function') {
      loadHandler = () => {
        loadHandler = null;
        if (closed) return;
        ready = true;
        syncConnection();
      };
      window.addEventListener('load', loadHandler, { once: true });
    } else if (opts.immediate) {
      ready = true;
      syncConnection();
    } else {
      initTimer = setTimeout(() => {
        initTimer = null;
        if (closed) return;
        ready = true;
        syncConnection();
      }, 0);
    }
    return {
      close() {
        closed = true;
        clearInitTimer();
        if (loadHandler && typeof window.removeEventListener === 'function') {
          window.removeEventListener('load', loadHandler);
          loadHandler = null;
        }
        if (pageHideHandler && typeof window.removeEventListener === 'function') {
          window.removeEventListener('pagehide', pageHideHandler);
          pageHideHandler = null;
        }
        watcher.detach();
        disconnect();
      },
      isVisible: watcher.isVisible,
    };
  }

  async function notifyAgent(message, conversationId = '', title = 'Sidecar State', extraOpts = {}) {
    const fn = window.sidecar?.fetch || (typeof fetch === 'function' ? fetch.bind(window) : null);
    if (!fn || !message) return { ok: false, error: 'Fetch or message unavailable' };
    const opts = extraOpts && typeof extraOpts === 'object' ? extraOpts : {};
    const urlParams = new URLSearchParams(window.location?.search || '');
    const urlConv = urlParams.get('conversationId') || '';
    const urlToken = getUiToken();
    const rawConv = conversationId || opts.conversationId || window.sidecar?.conversationId || urlConv;
    const isExplicitNew = rawConv === '_new';
    const resolvedConv = rawConv && !isExplicitNew ? rawConv : '';
    let bridgeWs = '';
    if (typeof window.sidecar?.getWorkspaceUris === 'function') {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris) && typeof uris[0] === 'string') {
          bridgeWs = uris[0];
        }
      } catch {}
    }
    const workspace = opts.workspace || bridgeWs || window.sidecar?.workspace || urlParams.get('workspace') || '';
    const finalTitle = opts.title || title;
    const res = await fn('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(urlToken ? { 'X-Sidecar-Token': urlToken } : {}) },
      body: JSON.stringify({
        message,
        ...(isExplicitNew ? { conversationId: '_new' } : resolvedConv ? { conversationId: resolvedConv } : {}),
        ...(workspace ? { workspace } : {}),
        title: finalTitle,
      }),
    });
    return res.json().catch(() => ({ ok: res.ok }));
  }

  function createVisibilityPoller(optionsOrFn = {}, maybeOpts = {}) {
    const opts = typeof optionsOrFn === 'function' ? { ...maybeOpts, onPoll: optionsOrFn } : optionsOrFn || {};
    const onPoll = typeof opts.onPoll === 'function' ? opts.onPoll : () => {};
    const baseInterval = Number(opts.intervalMs ?? opts.activeMs ?? 2000) || 2000;
    const hiddenInterval = Number(opts.hiddenPollMs ?? opts.hiddenIntervalMs ?? 0) || 0;
    const resolveDelay = () => (typeof opts.getIntervalMs === 'function' ? Number(opts.getIntervalMs()) || baseInterval : baseInterval);
    let running = false;
    let timer = null;
    let inFlight = null;
    let pendingWake = false;

    const watcher = createVisibilityWatcher({
      onVisibilityChange: opts.onVisibilityChange,
      onHostMessage: opts.onHostMessage,
      onSync: syncPolling,
    });
    const isVisible = watcher.isVisible;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    function scheduleNext() {
      clearTimer();
      if (!running || inFlight) return;
      const vis = isVisible();
      if (!vis && !(hiddenInterval > 0)) return;
      timer = setTimeout(runTick, vis ? resolveDelay() : hiddenInterval);
    }

    function runTick() {
      clearTimer();
      if (!running || (!isVisible() && !(hiddenInterval > 0)) || inFlight) return;
      pendingWake = false;
      let res;
      try {
        res = onPoll();
      } catch {
        scheduleNext();
        return;
      }
      if (res && typeof res.then === 'function') {
        const done = () => {
          if (inFlight === p) inFlight = null;
          if (pendingWake && running && isVisible()) {
            pendingWake = false;
            runTick();
          } else {
            scheduleNext();
          }
        };
        const p = res.then(done, done);
        inFlight = p;
      } else {
        scheduleNext();
      }
    }

    function syncPolling() {
      clearTimer();
      if (!running) return;
      if (inFlight) {
        if (isVisible()) pendingWake = true;
        return;
      }
      if (isVisible()) runTick();
      else if (hiddenInterval > 0) scheduleNext();
    }

    function triggerNow() {
      clearTimer();
      if (inFlight) {
        if (running && isVisible()) pendingWake = true;
        return inFlight;
      }
      let res;
      try {
        res = onPoll();
      } catch {
        scheduleNext();
        return res;
      }
      if (res && typeof res.then === 'function') {
        const p = res.finally(() => {
          if (inFlight === p) inFlight = null;
          if (pendingWake && running && isVisible()) {
            pendingWake = false;
            runTick();
          } else {
            scheduleNext();
          }
        });
        inFlight = p;
        return p;
      }
      scheduleNext();
      return res;
    }

    function start() {
      if (running) return;
      running = true;
      watcher.attach();
      if (opts.immediate === false) scheduleNext();
      else syncPolling();
    }

    function stop() {
      running = false;
      pendingWake = false;
      clearTimer();
      watcher.detach();
    }

    if (opts.autoStart) start();
    return { start, sync: syncPolling, stop, triggerNow, isVisible };
  }

  function matchTabCycleShortcut(e) {
    if (!e || typeof e !== 'object') return 0;
    if (e.altKey || e.getModifierState?.('AltGraph')) return 0;
    const key = String(e.key || '');
    const code = String(e.code || '');
    if ((key === 'Tab' || code === 'Tab') && e.ctrlKey && !e.metaKey) {
      return e.shiftKey ? -1 : 1;
    }
    const nav = typeof window !== 'undefined' ? window.navigator : typeof navigator !== 'undefined' ? navigator : null;
    const isMac = /mac|iphone|ipad|ipod/i.test(String(nav?.platform || nav?.userAgent || ''));
    const hasPrimaryMod = isMac ? Boolean(e.metaKey) && !e.ctrlKey : Boolean(e.ctrlKey) && !e.metaKey;
    if (hasPrimaryMod && e.shiftKey) {
      if (code === 'Period' || key === '>' || key === '.') return 1;
      if (code === 'Comma' || key === '<' || key === ',') return -1;
    }
    return 0;
  }

  function isEmbeddedInHostHub(opts = {}) {
    if (typeof opts.nestedHost === 'boolean') return opts.nestedHost;
    try {
      const hostParam = new URLSearchParams(window.location?.search || '').get('host');
      if (hostParam) return true;
      if (window.location?.protocol === 'plugin:') return false;
      if (window.top) {
        return Boolean(window.parent && window.parent !== window && window.parent !== window.top);
      }
      return Boolean(window.parent && window.parent !== window);
    } catch {
      return true;
    }
  }

  function bindParentShortcutForwarder(opts = {}) {
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return () => {};
    const root = opts.root || (typeof document !== 'undefined' && document.documentElement) || window;
    if (!root || typeof root.addEventListener !== 'function') return () => {};
    root._cleanupShortcutForwarder?.();
    const onKeyDown = (e) => {
      if (e.defaultPrevented) return;
      if (typeof document !== 'undefined' && document._hasLocalTabCycleHandler) return;
      if (!isEmbeddedInHostHub(opts)) return;
      const dir = matchTabCycleShortcut(e);
      if (!dir) return;
      e.preventDefault?.();
      e.stopPropagation?.();
      try {
        window.parent.postMessage({ type: 'agy:shortcut-forwarded', dir, repeat: Boolean(e.repeat) }, '*');
      } catch {}
    };
    root.addEventListener('keydown', onKeyDown);
    const cleanup = () => {
      root.removeEventListener?.('keydown', onKeyDown);
      if (root._cleanupShortcutForwarder === cleanup) root._cleanupShortcutForwarder = null;
    };
    root._cleanupShortcutForwarder = cleanup;
    return cleanup;
  }

  const RESERVED_SYNC_QUERY_KEYS = new Set([
    'token',
    'entrypoint',
    'conversationId',
    'urlSync',
    'initSubpath',
  ]);

  function parseSearchEntries(rawQuery) {
    const qs = String(rawQuery || '').replace(/^\?/, '');
    if (!qs) return [];
    const USP =
      (typeof URLSearchParams === 'function' && URLSearchParams) ||
      (typeof window !== 'undefined' && typeof window.URLSearchParams === 'function' && window.URLSearchParams) ||
      null;
    if (USP) {
      return Array.from(new USP(qs).entries());
    }
    const entries = [];
    for (const part of qs.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const rawKey = eq >= 0 ? part.slice(0, eq) : part;
      const rawVal = eq >= 0 ? part.slice(eq + 1) : '';
      try {
        const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
        entries.push([key, val]);
      } catch {
        entries.push([rawKey, rawVal]);
      }
    }
    return entries;
  }

  function hasReservedSyncQueryKey(queryStr) {
    for (const [key] of parseSearchEntries(queryStr)) {
      if (RESERVED_SYNC_QUERY_KEYS.has(key)) return true;
    }
    return false;
  }

  function sanitizeSyncSubpath(raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return undefined;
    if (/[?#\\\x00-\x1f\x7f]/.test(raw)) return undefined;
    let start = 0;
    while (start < raw.length && raw.charCodeAt(start) === 47) {
      start++;
    }
    let end = raw.length;
    while (end > start && raw.charCodeAt(end - 1) === 47) {
      end--;
    }
    const trimmed = raw.slice(start, end);
    if (!trimmed) return '';
    for (const seg of trimmed.split('/')) {
      if (!seg || seg === '.' || seg === '..') return undefined;
      let decoded;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        return undefined;
      }
      if (/[\\\x00-\x1f\x7f]/.test(decoded)) return undefined;
      for (const sub of decoded.split('/')) {
        if (sub === '.' || sub === '..') return undefined;
      }
      if (seg.startsWith('~q=')) {
        const unpacked = seg.slice(3).replace(/%2F/gi, '/').replace(/%25/g, '%');
        if (hasReservedSyncQueryKey(unpacked)) return undefined;
      } else if (decoded.startsWith('~q=')) {
        if (hasReservedSyncQueryKey(decoded.slice(3))) return undefined;
      }
    }
    return trimmed;
  }

  function createUrlSyncBridge(opts = {}) {
    const bridgeOpts = opts && typeof opts === 'object' ? opts : {};
    let search = '';
    try {
      search = typeof window !== 'undefined' ? String(window.location?.search || '') : '';
    } catch {}
    let hasUrlSync = false;
    let enabled = false;
    let hasInitSubpath = false;
    let rawInitSubpath = '';
    for (const [key, val] of parseSearchEntries(search)) {
      if (key === 'urlSync' && !hasUrlSync) {
        hasUrlSync = true;
        enabled = val === '1';
      } else if (key === 'initSubpath' && !hasInitSubpath) {
        hasInitSubpath = true;
        rawInitSubpath = val;
      }
    }
    const initialSubpath = enabled ? (sanitizeSyncSubpath(rawInitSubpath) ?? '') : '';
    let lastSubpath = initialSubpath;
    let applyingHostChange = false;
    let destroyed = false;

    const onMessage = (e) => {
      if (destroyed) return;
      if (e?.data?.type !== 'host-url-change') return;
      if (!window.parent || window.parent === window || e.source !== window.parent) return;
      const nextSubpath = sanitizeSyncSubpath(e.data.payload?.subpath);
      if (nextSubpath === undefined || nextSubpath === lastSubpath) return;
      lastSubpath = nextSubpath;
      applyingHostChange = true;
      try {
        bridgeOpts.onSubpathChange?.(nextSubpath);
      } finally {
        applyingHostChange = false;
      }
    };

    if (enabled && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('message', onMessage);
    }

    function getInitialSubpath() {
      return initialSubpath;
    }

    function pushSubpath(subpath, pushOpts) {
      if (!enabled || destroyed || applyingHostChange) return false;
      const clean = sanitizeSyncSubpath(subpath);
      if (clean === undefined) return false;
      const sent = postHostMessage('sidecar-url-change', {
        subpath: clean,
        replace: Boolean(pushOpts?.replace),
      });
      if (sent) lastSubpath = clean;
      return sent;
    }

    function stepHistory(delta) {
      if (!enabled || destroyed) return false;
      const num = Number(delta);
      if (!Number.isFinite(num)) return false;
      const clamped = Math.max(-50, Math.min(50, Math.trunc(num)));
      if (!clamped) return false;
      return postHostMessage('sidecar-history-step', { delta: clamped });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (enabled && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('message', onMessage);
      }
    }

    return {
      enabled,
      getInitialSubpath,
      pushSubpath,
      stepHistory,
      destroy,
    };
  }

  function postHostMessage(type, payload) {
    if (typeof window === 'undefined') return false;
    if (!window.parent || window.parent === window) return false;
    try {
      window.parent.postMessage({ type, payload }, '*');
      return true;
    } catch {
      return false;
    }
  }

  function toggleAuxPane(request) {
    if (typeof window !== 'undefined' && typeof window.sidecar?.ui?.toggleAuxPane === 'function') {
      window.sidecar.ui.toggleAuxPane(request);
      return true;
    }
    return postHostMessage('toggle-aux-pane', request ?? {});
  }

  function toggleConversation(conversationId, options) {
    if (typeof window !== 'undefined' && typeof window.sidecar?.ui?.toggleConversation === 'function') {
      window.sidecar.ui.toggleConversation(conversationId, options);
      return true;
    }
    const payload =
      options && typeof options === 'object'
        ? { conversationId, ...options }
        : { conversationId };
    return postHostMessage('toggle-conversation', payload);
  }

  function newConversation() {
    if (typeof window !== 'undefined' && typeof window.sidecar?.ui?.newConversation === 'function') {
      window.sidecar.ui.newConversation();
      return true;
    }
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return false;
    try {
      window.parent.postMessage({ type: 'new-conversation' }, '*');
      return true;
    } catch {
      return false;
    }
  }

  function addArtifactComment(input = {}) {
    if (typeof window !== 'undefined' && typeof window.sidecar?.ui?.addArtifactComment === 'function') {
      window.sidecar.ui.addArtifactComment(input);
      return true;
    }
    const { uri, comment, selection, pageTitle } = input || {};
    return postHostMessage('add-artifact-comment', { uri, comment, selection, pageTitle });
  }

  function requestCredentialRefresh() {
    if (typeof window !== 'undefined' && typeof window.sidecar?.auth?.requestCredentialRefresh === 'function') {
      window.sidecar.auth.requestCredentialRefresh();
      return true;
    }
    if (typeof window === 'undefined' || !window.parent || window.parent === window) return false;
    try {
      window.parent.postMessage({ type: 'request-credential-refresh' }, '*');
      return true;
    } catch {
      return false;
    }
  }

  function frameBlocksDownloads(fe) {
    if (!fe) return true;
    const hasSandbox =
      typeof fe.hasAttribute === 'function' ? fe.hasAttribute('sandbox') : fe.sandbox != null;
    if (!hasSandbox) return false;
    if (typeof fe.sandbox?.contains === 'function') {
      return !fe.sandbox.contains('allow-downloads');
    }
    const raw =
      typeof fe.sandbox === 'string'
        ? fe.sandbox
        : typeof fe.getAttribute === 'function'
          ? String(fe.getAttribute('sandbox') || '')
          : '';
    const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return !tokens.includes('allow-downloads');
  }

  function isDownloadSandboxed(win) {
    const rootWin = win || (typeof window !== 'undefined' ? window : null);
    if (!rootWin) return false;
    try {
      const selfWin = rootWin.self || rootWin;
      const topWin = rootWin.top;
      if (topWin) {
        if (selfWin === topWin || rootWin === topWin) return false;
      } else if (
        (!rootWin.parent || rootWin.parent === selfWin || rootWin.parent === rootWin) &&
        !('frameElement' in rootWin)
      ) {
        return false;
      }
      let cur = rootWin;
      let depth = 0;
      while (cur && depth++ < 32) {
        const curSelf = cur.self || cur;
        if (topWin && (curSelf === topWin || cur === topWin)) return false;
        if (
          !topWin &&
          (!cur.parent || cur.parent === curSelf || cur.parent === cur) &&
          !('frameElement' in cur)
        ) {
          return false;
        }
        const fe = cur.frameElement;
        if (!fe) return true;
        if (frameBlocksDownloads(fe)) return true;
        const next = cur.parent;
        if (!next || next === cur || next === curSelf) {
          return topWin ? !(curSelf === topWin || cur === topWin) : false;
        }
        cur = next;
      }
      return depth > 32;
    } catch {
      return true;
    }
  }

  const POPUP_DOWNLOAD_CSS = [
    ':root {',
    '  color-scheme: dark;',
    '  --p-bg: #070708;',
    '  --p-card: #15151a;',
    '  --p-border: rgba(255, 255, 255, 0.12);',
    '  --p-ink: #ffffff;',
    '  --p-soft: rgba(255, 255, 255, 0.72);',
    '  --p-accent: #2f71e3;',
    '}',
    ':root[data-theme="light"] {',
    '  color-scheme: light;',
    '  --p-bg: #fbfbfa;',
    '  --p-card: #ffffff;',
    '  --p-border: rgba(15, 18, 23, 0.12);',
    '  --p-ink: #1f2124;',
    '  --p-soft: rgba(31, 33, 36, 0.72);',
    '  --p-accent: #3a6ff7;',
    '}',
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-items: center;',
    '  padding: 24px;',
    '  box-sizing: border-box;',
    '  background: var(--p-bg);',
    '  color: var(--p-ink);',
    '  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '}',
    '.agy-popup-card {',
    '  max-width: 24rem;',
    '  width: 100%;',
    '  padding: 20px;',
    '  border-radius: 16px;',
    '  border: 1px solid var(--p-border);',
    '  background: var(--p-card);',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 12px;',
    '}',
    '.agy-popup-title {',
    '  margin: 0;',
    '  font-size: 1rem;',
    '  font-weight: 600;',
    '  overflow-wrap: anywhere;',
    '}',
    '.agy-popup-meta {',
    '  margin: 0;',
    '  font-size: 0.8125rem;',
    '  line-height: 1.45;',
    '  color: var(--p-soft);',
    '  overflow-wrap: anywhere;',
    '}',
    '.agy-popup-btn {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  align-self: flex-start;',
    '  height: 32px;',
    '  padding: 0 14px;',
    '  border-radius: 9999px;',
    '  background: var(--p-accent);',
    '  color: #ffffff;',
    '  font-size: 0.875rem;',
    '  font-weight: 500;',
    '  text-decoration: none;',
    '}',
  ].join('\n');

  function ensurePopupBody(popupDoc, pageTitle, isDark) {
    if (!popupDoc || typeof popupDoc.createElement !== 'function') return null;
    if (popupDoc.documentElement) {
      popupDoc.documentElement.setAttribute?.('lang', 'en');
      popupDoc.documentElement.setAttribute?.('data-theme', isDark ? 'dark' : 'light');
    }
    try {
      popupDoc.title = pageTitle;
    } catch {}
    const head = popupDoc.head || popupDoc.documentElement;
    if (head && !popupDoc.querySelector?.('style[data-agy-popup-style]')) {
      const styleEl = popupDoc.createElement('style');
      styleEl.setAttribute?.('data-agy-popup-style', '1');
      styleEl.textContent = POPUP_DOWNLOAD_CSS;
      head.appendChild?.(styleEl);
    }
    let body = popupDoc.body;
    if (!body && popupDoc.documentElement) {
      body = popupDoc.createElement('body');
      popupDoc.documentElement.appendChild?.(body);
    }
    if (!body) return null;
    if (typeof body.replaceChildren === 'function') {
      body.replaceChildren();
    } else {
      body.innerHTML = '';
    }
    return body;
  }

  function renderPopupPlaceholder(popupDoc, filename, isDark) {
    const label = `Preparing ${filename}\u2026`;
    const body = ensurePopupBody(popupDoc, label, isDark);
    if (!body) return;
    const card = popupDoc.createElement('main');
    card.className = 'agy-popup-card';
    const h1 = popupDoc.createElement('h1');
    h1.className = 'agy-popup-title';
    h1.textContent = label;
    const meta = popupDoc.createElement('p');
    meta.className = 'agy-popup-meta';
    meta.textContent = 'Generating download payload\u2026';
    card.appendChild(h1);
    card.appendChild(meta);
    body.appendChild(card);
  }

  function renderPopupReadyCard(popupDoc, info) {
    const body = ensurePopupBody(popupDoc, info.title, info.isDark);
    if (!body) return null;
    const card = popupDoc.createElement('main');
    card.className = 'agy-popup-card';
    const h1 = popupDoc.createElement('h1');
    h1.className = 'agy-popup-title';
    h1.textContent = info.title;
    const meta = popupDoc.createElement('p');
    meta.className = 'agy-popup-meta';
    meta.textContent = info.metaText || `Ready to save ${info.filename}.`;
    const link = popupDoc.createElement('a');
    link.className = 'agy-popup-btn';
    link.setAttribute?.('href', info.href);
    link.href = info.href;
    link.setAttribute?.('download', info.filename);
    link.download = info.filename;
    link.textContent = `Download ${info.filename}`;
    card.appendChild(h1);
    card.appendChild(meta);
    card.appendChild(link);
    body.appendChild(card);
    return link;
  }

  function isBlobLike(val) {
    if (!val || typeof val !== 'object') return false;
    if (typeof Blob === 'function' && val instanceof Blob) return true;
    return (
      typeof val.size === 'number' &&
      typeof val.type === 'string' &&
      (typeof val.slice === 'function' || typeof val.text === 'function' || typeof val.arrayBuffer === 'function')
    );
  }

  function normalizeDownloadBlob(raw, mimeType, win) {
    if (raw == null) return null;
    const BlobCtor =
      (win && typeof win.Blob === 'function' && win.Blob) ||
      (typeof window !== 'undefined' && typeof window.Blob === 'function' && window.Blob) ||
      (typeof Blob === 'function' ? Blob : null);
    if (isBlobLike(raw)) {
      if (raw.size === 0) return null;
      if (mimeType && raw.type !== mimeType && BlobCtor) {
        return new BlobCtor([raw], { type: mimeType });
      }
      if (!raw.type && BlobCtor) {
        return new BlobCtor([raw], { type: 'application/octet-stream' });
      }
      return raw;
    }
    if (!BlobCtor) return null;
    if (typeof raw === 'string') {
      if (raw.length === 0) return null;
      return new BlobCtor([raw], { type: mimeType || 'text/plain;charset=utf-8' });
    }
    const isBufferView = ArrayBuffer.isView(raw);
    const isArrayBuf =
      !isBufferView &&
      ((typeof ArrayBuffer === 'function' && raw instanceof ArrayBuffer) ||
        Object.prototype.toString.call(raw) === '[object ArrayBuffer]');
    if (isBufferView || isArrayBuf) {
      if (!raw.byteLength) return null;
      return new BlobCtor([raw], { type: mimeType || 'application/octet-stream' });
    }
    return null;
  }

  function closePopupSafe(popup) {
    if (!popup) return;
    try {
      if (!popup.closed && typeof popup.close === 'function') {
        popup.close();
      }
    } catch {}
  }

  function toError(err, fallbackMsg) {
    if (err instanceof Error) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string') return err;
    const msg = err != null && String(err) ? String(err) : fallbackMsg;
    return new Error(msg);
  }

  function makeCallerObject(protoSource, props) {
    const proto =
      protoSource && typeof protoSource === 'object'
        ? Object.getPrototypeOf(protoSource)
        : null;
    if (proto && proto !== Object.prototype) {
      return Object.assign(Object.create(proto), props);
    }
    return { ...props };
  }

  async function downloadFile(opts = {}) {
    const rawOpts = opts && typeof opts === 'object' ? opts : {};
    const result = (props) => makeCallerObject(rawOpts, props);
    const filename = String(rawOpts.filename || 'download').trim() || 'download';
    const title = String(rawOpts.title || `Download ${filename}`);
    const metaText = rawOpts.metaText == null ? '' : String(rawOpts.metaText);
    if (typeof rawOpts.produce !== 'function') {
      return result({
        ok: false,
        mode: 'failed',
        error: new Error('downloadFile requires a produce() function'),
      });
    }
    const win = rawOpts.window || (typeof window !== 'undefined' ? window : null);
    const isDark = typeof agy.isHostDarkTheme === 'function' ? agy.isHostDarkTheme() : true;
    const sandboxed = isDownloadSandboxed(win);

    let popup = null;
    if (sandboxed && typeof win?.open === 'function') {
      try {
        popup = win.open('', '_blank');
      } catch {
        popup = null;
      }
      if (popup && !popup.closed) {
        try {
          renderPopupPlaceholder(popup.document, filename, isDark);
        } catch {}
      }
    }

    let rawPayload;
    try {
      rawPayload = await rawOpts.produce();
    } catch (err) {
      closePopupSafe(popup);
      return result({ ok: false, mode: 'failed', error: toError(err, 'Download failed') });
    }

    const blob = normalizeDownloadBlob(rawPayload, rawOpts.mimeType, win);
    if (!blob) {
      closePopupSafe(popup);
      return result({ ok: false, mode: 'failed', error: new Error('Empty download payload') });
    }

    if (!sandboxed) {
      const UrlApi = win?.URL || (typeof URL !== 'undefined' ? URL : null);
      const doc = win?.document || (typeof document !== 'undefined' ? document : null);
      if (!UrlApi || typeof UrlApi.createObjectURL !== 'function' || !doc?.createElement) {
        return result({ ok: false, mode: 'failed', error: new Error('Download URL API unavailable') });
      }
      try {
        const objectUrl = UrlApi.createObjectURL(blob);
        const link = doc.createElement('a');
        link.setAttribute?.('href', objectUrl);
        link.href = objectUrl;
        link.setAttribute?.('download', filename);
        link.download = filename;
        link.rel = 'noopener';
        if (link.style) link.style.display = 'none';
        (doc.body || doc.documentElement)?.appendChild?.(link);
        try {
          link.click?.();
        } finally {
          link.remove?.();
        }
        const schedule = typeof win?.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
        const timer = schedule(() => {
          try {
            UrlApi.revokeObjectURL?.(objectUrl);
          } catch {}
        }, 10000);
        timer?.unref?.();
        return result({ ok: true, mode: 'direct' });
      } catch (err) {
        return result({ ok: false, mode: 'failed', error: toError(err, 'Direct download failed') });
      }
    }

    let deliveredInPopup = false;
    if (popup && !popup.closed) {
      let PopupUrlApi = null;
      let popupUrl = '';
      try {
        PopupUrlApi = popup.URL || win?.URL || (typeof URL !== 'undefined' ? URL : null);
        if (PopupUrlApi && typeof PopupUrlApi.createObjectURL === 'function' && popup.document) {
          popupUrl = PopupUrlApi.createObjectURL(blob);
          const link = renderPopupReadyCard(popup.document, {
            filename,
            title,
            metaText,
            href: popupUrl,
            isDark,
          });
          if (link) {
            let revoked = false;
            const revokePopupUrl = () => {
              if (revoked || !popupUrl) return;
              revoked = true;
              try {
                PopupUrlApi.revokeObjectURL?.(popupUrl);
              } catch {}
            };
            popup.addEventListener?.('pagehide', revokePopupUrl, { once: true });
            link.click?.();
            deliveredInPopup = true;
          } else {
            PopupUrlApi.revokeObjectURL?.(popupUrl);
          }
        }
      } catch {
        if (popupUrl) {
          try {
            PopupUrlApi?.revokeObjectURL?.(popupUrl);
          } catch {}
        }
      }
      if (!deliveredInPopup) {
        closePopupSafe(popup);
      }
    }

    if (deliveredInPopup) {
      return result({ ok: true, mode: 'popup' });
    }

    const fallbackCtx = makeCallerObject(rawOpts, { blob, filename, title, metaText });
    if (typeof rawOpts.onFallback === 'function') {
      try {
        const fbResult = await rawOpts.onFallback(fallbackCtx);
        if (fbResult !== false) {
          return result({ ok: true, mode: 'fallback' });
        }
      } catch (err) {
        return result({ ok: false, mode: 'failed', error: toError(err, 'Download fallback failed') });
      }
    }

    const modalEl = win?.AgyUI?.openDownloadModal?.(fallbackCtx);
    if (modalEl) {
      return result({ ok: true, mode: 'fallback' });
    }
    return result({ ok: false, mode: 'failed' });
  }

  bindParentShortcutForwarder();

  Object.assign(agy, {
    getUiToken,
    subscribeStateSyncEvents,
    notifyAgent,
    createVisibilityPoller,
    matchTabCycleShortcut,
    bindParentShortcutForwarder,
    sanitizeSyncSubpath,
    createUrlSyncBridge,
    toggleAuxPane,
    toggleConversation,
    newConversation,
    addArtifactComment,
    requestCredentialRefresh,
    isDownloadSandboxed,
    downloadFile,
  });
})();
