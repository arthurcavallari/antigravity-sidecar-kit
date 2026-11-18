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

  function addArtifactComment(input = {}) {
    if (typeof window !== 'undefined' && typeof window.sidecar?.ui?.addArtifactComment === 'function') {
      window.sidecar.ui.addArtifactComment(input);
      return true;
    }
    const { uri, comment, selection, pageTitle } = input || {};
    return postHostMessage('add-artifact-comment', { uri, comment, selection, pageTitle });
  }

  bindParentShortcutForwarder();

  Object.assign(agy, {
    getUiToken,
    subscribeStateSyncEvents,
    notifyAgent,
    createVisibilityPoller,
    matchTabCycleShortcut,
    bindParentShortcutForwarder,
    toggleAuxPane,
    toggleConversation,
    addArtifactComment,
  });
})();
