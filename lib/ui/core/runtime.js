(function (win) {
  const ui = (win.AgyUI = win.AgyUI || {});

  ui.VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';

  ui.apiCall = async function apiCall(path, body = {}, init = {}) {
    const fn = win.sidecar?.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : fetch);
    const urlToken = new URLSearchParams(win.location?.search || '').get('token') || win.__AGY_TOKEN__ || '';
    const res = await fn(path, {
      method: 'POST',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(urlToken ? { 'X-Sidecar-Token': urlToken } : {}),
        ...(init.headers || {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  };

  ui.formatStatusBadge = function formatStatusBadge(rawBadge = '', isRunning = false, isErrored = false) {
    if (isRunning || rawBadge === 'RUNNING') return { label: 'Running', state: 'running' };
    if (isErrored || rawBadge === 'ERRORED') return { label: 'Error', state: 'errored' };
    if (rawBadge === 'HIBERNATED') return { label: 'Hibernated', state: 'hibernated' };
    if (rawBadge === 'STOPPED') return { label: 'Stopped', state: 'stopped' };
    if (rawBadge === 'STARTING') return { label: 'Starting', state: 'starting' };
    return {
      label: rawBadge ? rawBadge.charAt(0).toUpperCase() + rawBadge.slice(1).toLowerCase() : 'Stopped',
      state: 'stopped',
    };
  };

  ui.formatBadgeLabel = function formatBadgeLabel(rawBadge = '') {
    const s = String(rawBadge || '').trim();
    if (!s) return '';
    if (/^PID\b/i.test(s)) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  };

  ui.readHostVisibility = function readHostVisibility(msgData) {
    if (!msgData || msgData.type !== ui.VISIBILITY_MESSAGE_TYPE) return null;
    const v = msgData.payload?.visible;
    return typeof v === 'boolean' ? v : null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
