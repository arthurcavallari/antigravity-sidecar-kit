(function (win) {
  const ui = (win.AgyUI = win.AgyUI || {});

  ui.renderCountPill = function renderCountPill(count) {
    return `<span class="agy-count-pill">${ui.escHtml(count)}</span>`;
  };

  ui.renderEmptyState = function renderEmptyState({ icon = 'code_blocks', message = '', actionHtml = '' } = {}) {
    return `<div class="agy-empty-state">${ui.iconSvg(icon, 24)}<span>${ui.escHtml(message)}</span>${actionHtml}</div>`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
