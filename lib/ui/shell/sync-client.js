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

  function subscribeStateSyncEvents(optionsOrFn = {}, maybeOpts = {}) {
    const ES = (typeof window !== 'undefined' && window.EventSource) || (typeof EventSource === 'function' ? EventSource : null);
    if (typeof ES !== 'function' || typeof window === 'undefined') return { close() {} };
    const opts = typeof optionsOrFn === 'function' ? { ...maybeOpts, onStateEvent: optionsOrFn } : optionsOrFn || {};
    const { url = opts.path || './api/events', getConversationId, onStateEvent } = opts;
    let backoffMs = 1000;
    let es = null;
    let reconnectTimer = null;
    let closed = false;
    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        if (typeof clearTimeout === 'function') clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    function connect() {
      clearReconnect();
      if (closed) return;
      try {
        try { es?.close(); } catch {}
        const token = getUiToken();
        const convId = opts.conversationId || getConversationId?.();
        let targetHref = url;
        if (typeof URL === 'function' && window.location?.href) {
          const target = new URL(url, window.location.href);
          if (token) target.searchParams.set('token', token);
          if (convId && convId !== '_new') {
            target.searchParams.set('conversationId', convId);
            target.searchParams.set('conversation', convId);
          }
          targetHref = target.href;
        } else {
          const qp = new URLSearchParams();
          if (token) qp.set('token', token);
          if (convId && convId !== '_new') {
            qp.set('conversationId', convId);
            qp.set('conversation', convId);
          }
          const qs = qp.toString();
          targetHref = qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
        }
        es = new ES(targetHref);
        es.onopen = () => {
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
        es.onmessage = handleEvent;
        es.addEventListener?.('state', handleEvent);
        es.addEventListener?.('state_changed', handleEvent);
        es.onerror = () => {
          if (closed || reconnectTimer !== null) return;
          try { es.close(); } catch {}
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            backoffMs = Math.min(backoffMs * 2, 30000);
            connect();
          }, backoffMs);
        };
      } catch {}
    }

    if (typeof document !== 'undefined' && document.readyState !== 'complete' && typeof window.addEventListener === 'function') {
      window.addEventListener(
        'load',
        () => {
          if (!closed) connect();
        },
        { once: true }
      );
    } else if (opts.immediate) {
      connect();
    } else {
      setTimeout(connect, 0);
    }
    return {
      close() {
        closed = true;
        clearReconnect();
        try { es?.close(); } catch {}
      },
    };
  }

  async function notifyAgent(message, conversationId = '', title = 'Sidecar State') {
    const fn = window.sidecar?.fetch || (typeof fetch === 'function' ? fetch.bind(window) : null);
    if (!fn || !message) return { ok: false, error: 'Fetch or message unavailable' };
    const urlParams = new URLSearchParams(window.location?.search || '');
    const urlConv = urlParams.get('conversationId') || '';
    const urlToken = getUiToken();
    const rawConv = conversationId || window.sidecar?.conversationId || urlConv;
    const isExplicitNew = rawConv === '_new';
    const resolvedConv = rawConv && !isExplicitNew ? rawConv : '';
    const workspace = window.sidecar?.workspace || urlParams.get('workspace') || '';
    const res = await fn('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(urlToken ? { 'X-Sidecar-Token': urlToken } : {}) },
      body: JSON.stringify({
        message,
        ...(isExplicitNew ? { conversationId: '_new' } : resolvedConv ? { conversationId: resolvedConv } : {}),
        ...(workspace ? { workspace } : {}),
        title,
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
    let hostVisible = true;
    let inViewport = true;
    let running = false;
    let timer = null;
    let inFlight = null;
    let observer = null;
    let listenersAttached = false;

    const isVisible = () => Boolean(hostVisible && inViewport && !(typeof document !== 'undefined' && document.hidden));
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
          scheduleNext();
        };
        const p = res.then(done, done);
        inFlight = p;
      } else {
        scheduleNext();
      }
    }

    function syncPolling() {
      clearTimer();
      if (!running || inFlight) return;
      if (isVisible()) runTick();
      else if (hiddenInterval > 0) scheduleNext();
    }

    function triggerNow() {
      clearTimer();
      if (inFlight) return inFlight;
      let res;
      try {
        res = onPoll();
      } catch {
        if (running && isVisible()) scheduleNext();
        return res;
      }
      if (res && typeof res.then === 'function') {
        const p = res.finally(() => {
          if (inFlight === p) inFlight = null;
          if (running && isVisible()) scheduleNext();
        });
        inFlight = p;
        return p;
      }
      if (running && isVisible()) scheduleNext();
      return res;
    }

    const onMessage = (e) => {
      if (e?.source && window.parent && e.source !== window.parent && e.source !== window) return;
      const d = e?.data;
      if (d?.type !== 'sidecar-visibility') return;
      const next = typeof d?.payload?.visible === 'boolean' ? d.payload.visible : typeof d?.visible === 'boolean' ? d.visible : null;
      if (next !== null && next !== hostVisible) {
        hostVisible = next;
        opts.onVisibilityChange?.(isVisible());
        syncPolling();
      }
    };

    const onDocVisibility = () => {
      opts.onVisibilityChange?.(isVisible());
      syncPolling();
    };

    function attachListeners() {
      if (listenersAttached) return;
      listenersAttached = true;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('message', onMessage);
      if (typeof IntersectionObserver === 'function' && typeof document !== 'undefined' && document.documentElement && !observer) {
        try {
          observer = new IntersectionObserver((entries) => {
            const last = entries && entries[entries.length - 1];
            if (!last || typeof last.isIntersecting !== 'boolean' || last.isIntersecting === inViewport) return;
            inViewport = last.isIntersecting;
            opts.onVisibilityChange?.(isVisible());
            syncPolling();
          });
          observer.observe(document.documentElement);
        } catch {}
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onDocVisibility);
      }
    }

    function detachListeners() {
      if (!listenersAttached) return;
      listenersAttached = false;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('message', onMessage);
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

    attachListeners();

    function start() {
      if (running) return;
      running = true;
      attachListeners();
      if (opts.immediate === false) scheduleNext();
      else syncPolling();
    }

    function stop() {
      running = false;
      clearTimer();
      detachListeners();
    }

    if (opts.autoStart) start();
    return { start, stop, triggerNow, isVisible };
  }

  Object.assign(agy, { getUiToken, subscribeStateSyncEvents, notifyAgent, createVisibilityPoller });
})();
