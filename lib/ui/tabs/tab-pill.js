(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);

  function dispatchTabEvent(target, type, detail) {
    if (!CEvent || typeof target?.dispatchEvent !== 'function') return;
    target.dispatchEvent(new CEvent(type, { detail, bubbles: true }));
  }

  ui.startInlineRename = function startInlineRename(pillEl, labelElOrOpts = {}, maybeOpts = {}) {
    if (!pillEl || pillEl._isRenaming) return null;
    let labelEl = null;
    let opts = {};
    if (labelElOrOpts && labelElOrOpts.nodeType === 1) {
      labelEl = labelElOrOpts;
      opts = maybeOpts || {};
    } else {
      opts = labelElOrOpts || {};
      const labelSel = opts.labelSelector || '[data-role="tab-label"], .agy-tab-label';
      labelEl = pillEl.querySelector?.(labelSel);
    }
    if (!labelEl) return null;
    pillEl._isRenaming = true;
    pillEl.classList?.add?.('is-renaming');
    const closeWrap = pillEl._slots?.closeWrap || pillEl.querySelector?.('[data-role="tab-close-wrap"], .agy-tab-close-wrap');
    const wasCloseHidden = Boolean(closeWrap?.classList?.contains?.('hidden'));
    closeWrap?.classList?.add?.('hidden');
    const inp = doc.createElement('input');
    inp.type = 'text';
    inp.className = opts.inputClassName || 'agy-tab-rename-input agy-rename-input';
    inp.value = String(opts.initialValue ?? (labelEl.textContent ? labelEl.textContent.trim() : ''));
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      pillEl._isRenaming = false;
      pillEl.classList?.remove?.('is-renaming');
      if (closeWrap && !wasCloseHidden && !pillEl._item?.pinned && (pillEl._item?.closable ?? true)) closeWrap.classList?.remove?.('hidden');
      inp.replaceWith(labelEl);
      if (commit) {
        labelEl.textContent = inp.value;
        opts.onCommit?.(inp.value);
        dispatchTabEvent(pillEl, 'tab-rename', {
          id: pillEl._item?.id ?? pillEl.dataset?.tabId,
          value: inp.value,
          item: pillEl._item,
        });
      } else {
        if (pillEl._item && (pillEl._item.label !== undefined || pillEl._item.id !== undefined)) {
          labelEl.textContent = pillEl._item.label ?? pillEl._item.id ?? '';
        }
        opts.onCancel?.();
      }
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation?.();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
    for (const ev of ['click', 'dblclick', 'pointerdown']) inp.addEventListener(ev, (e) => e.stopPropagation?.());

    labelEl.replaceWith(inp);
    inp.focus?.();
    inp.select?.();
    return inp;
  };

  function ensurePillSlots(host) {
    if (host._slots) return host._slots;
    const mk = (cls, role, html = '') => {
      const s = doc.createElement('span');
      s.className = cls;
      s.dataset.role = role;
      if (html) s.innerHTML = html;
      return s;
    };
    const iconSlot = mk('agy-tab-icon agy-tab-icon-slot', 'tab-icon');
    const labelEl = mk('agy-tab-label', 'tab-label');
    const badgeEl = mk('agy-tab-badge hidden', 'tab-badge');
    const extBadge = mk('agy-tab-ext-badge hidden', 'tab-ext-badge', ui.iconSvg('open_in_new', 11));
    const dotEl = mk('agy-status-dot hidden', 'tab-dot');
    const pinBtn = mk('agy-tab-pin hidden', 'tab-pin', ui.iconSvg('keep', 16));
    pinBtn.title = 'Unpin Tab';
    pinBtn.setAttribute?.('role', 'button');
    pinBtn.setAttribute?.('aria-label', 'Unpin Tab');
    const closeWrap = mk('agy-tab-close-wrap', 'tab-close-wrap');
    const closeBtn = mk('agy-tab-close', 'tab-close', ui.iconSvg('close', 14));
    closeBtn.setAttribute?.('role', 'button');
    closeWrap.appendChild(closeBtn);

    if (typeof host.replaceChildren === 'function') {
      host.replaceChildren(iconSlot, labelEl, badgeEl, extBadge, dotEl, pinBtn, closeWrap);
    } else if (typeof host.appendChild === 'function') {
      for (const ch of [iconSlot, labelEl, badgeEl, extBadge, dotEl, pinBtn, closeWrap]) host.appendChild(ch);
    }
    host._slots = { iconSlot, labelEl, badgeEl, extBadge, dotEl, pinBtn, closeWrap, closeBtn };

    const bindAction = (el, handler) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation?.();
        handler(e);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault?.();
          e.stopPropagation?.();
          handler(e);
        }
      });
    };
    bindAction(pinBtn, (e) => {
      const cur = host._item || {};
      if (cur.pinned) {
        host._opts?.onUnpin?.(cur.id, cur, e);
        dispatchTabEvent(host, 'tab-unpin', { id: cur.id, item: cur, originalEvent: e });
      }
    });
    bindAction(closeBtn, (e) => {
      const cur = host._item || {};
      if (cur.closable && !cur.pinned) {
        host._opts?.onClose?.(cur.id, cur, e);
        dispatchTabEvent(host, 'tab-close', { id: cur.id, item: cur, originalEvent: e });
      }
    });
    host.addEventListener('click', (e) => {
      if (host._wasDragged) {
        host._wasDragged = false;
        return;
      }
      const cur = host._item || {};
      host._opts?.onSelect?.(cur.id, cur, e);
      dispatchTabEvent(host, 'tab-select', { id: cur.id, item: cur, originalEvent: e });
    });
    host.addEventListener('auxclick', (e) => {
      const cur = host._item || {};
      if (e.button === 1 && cur.closable && !cur.pinned) {
        e.preventDefault?.();
        e.stopPropagation?.();
        host._opts?.onClose?.(cur.id, cur, e);
        dispatchTabEvent(host, 'tab-close', { id: cur.id, item: cur, originalEvent: e });
      }
    });
    host.addEventListener('contextmenu', (e) => {
      const cur = host._item || {};
      host._opts?.onContextMenu?.(cur.id, cur, e, host);
      dispatchTabEvent(host, 'tab-contextmenu', { id: cur.id, item: cur, originalEvent: e });
    });
    host.addEventListener('dblclick', (e) => {
      const cur = host._item || {};
      const curOpts = host._opts || {};
      if (!cur.renamable) return;
      e.stopPropagation?.();
      curOpts.onRenameStart?.(cur.id, cur, host);
      ui.startInlineRename(host, {
        initialValue: cur.renameValue ?? cur.label ?? '',
        onCommit: (val) => curOpts.onRename?.(cur.id, val, cur),
        onCancel: () => {
          curOpts.onRenameCancel?.(cur.id, cur, host);
          ui.updateTabPill(host, host._item || cur, host._opts || curOpts);
        },
      });
    });
    return host._slots;
  }

  ui.createTabPill = function createTabPill(item, callbacksOrOpts = {}, maybeOpts) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    ensurePillSlots(btn);
    ui.updateTabPill(btn, item, callbacksOrOpts, maybeOpts);
    const baseOpts = btn._opts;
    baseOpts?.bindDrag?.(btn, item);
    if (btn._opts !== baseOpts) btn._opts = { ...baseOpts, ...(btn._opts || {}) };
    return btn;
  };

  ui.updateTabPill = function updateTabPill(btn, item = {}, callbacksOrOpts, maybeOpts) {
    if (!btn || btn._rendering) return;
    btn._rendering = true;
    try {
      const slots = ensurePillSlots(btn);
      const opts = { ...(btn._opts || {}), ...(callbacksOrOpts || {}), ...(maybeOpts || {}) };
      btn._item = item;
      btn._opts = opts;
      const idKey = opts.idDatasetKey || 'tabId';
      if (item.id !== undefined) {
        btn.dataset[idKey] = String(item.id);
        btn.dataset.tabId = String(item.id);
      }
      const baseCls = opts.pillClass || 'agy-tab';
      btn.className = `${baseCls}${item.active ? ' active' : ''}`;
      btn.dataset.pinned = item.pinned ? 'true' : 'false';
      btn.title = item.title || item.label || item.id || '';
      if (item.dataset && typeof item.dataset === 'object') {
        for (const [k, v] of Object.entries(item.dataset)) btn.dataset[k] = String(v);
      }
      if (btn._isRenaming) return;

      const customIconEl = item.iconElement || item.iconEl;
      if (customIconEl && customIconEl.nodeType) {
        if (!slots.iconSlot.parentNode) btn.insertBefore(slots.iconSlot, btn.firstChild);
        slots.iconSlot.dataset.iconKey = '__custom__';
        if (slots.iconSlot.firstChild !== customIconEl) {
          ui.clear(slots.iconSlot);
          slots.iconSlot.appendChild(customIconEl);
        }
      } else if (item.icon === null || item.icon === false || item.icon === '') {
        slots.iconSlot.remove?.();
        delete slots.iconSlot.dataset.iconKey;
      } else {
        if (!slots.iconSlot.parentNode) btn.insertBefore(slots.iconSlot, btn.firstChild);
        const iconName = item.icon || 'folder';
        const iconSize = item.iconSize || 16;
        const iconKey = `${iconName}:${iconSize}`;
        if (slots.iconSlot.dataset.iconKey !== iconKey) {
          slots.iconSlot.dataset.iconKey = iconKey;
          slots.iconSlot.dataset.icon = iconName;
          slots.iconSlot.innerHTML = ui.iconSvg(iconName, iconSize);
        }
      }
      slots.labelEl.textContent = item.label ?? item.id ?? '';
      slots.badgeEl.textContent = item.badgeText || '';
      slots.badgeEl.classList.toggle('hidden', !item.badgeText);
      slots.extBadge.title = item.externalTitle || opts.externalTitle || 'Opened externally';
      slots.extBadge.classList.toggle('hidden', !item.externalBadge);
      slots.dotEl.className = item.statusDot ? `agy-status-dot ${item.statusDot}` : 'agy-status-dot hidden';
      const isPinned = Boolean(item.pinned);
      const isClosable = Boolean(!isPinned && item.closable);
      slots.pinBtn.classList.toggle('hidden', !isPinned);
      slots.pinBtn.setAttribute?.('tabindex', isPinned ? '0' : '-1');
      try { slots.pinBtn.tabIndex = isPinned ? 0 : -1; } catch {}
      const closeLabel = item.closeTitle || opts.closeTitle || 'Close Tab';
      slots.closeBtn.title = closeLabel;
      slots.closeBtn.setAttribute?.('aria-label', closeLabel);
      slots.closeBtn.setAttribute?.('tabindex', isClosable ? '0' : '-1');
      try { slots.closeBtn.tabIndex = isClosable ? 0 : -1; } catch {}
      slots.closeWrap.classList.toggle('hidden', !isClosable);
    } finally {
      btn._rendering = false;
    }
  };

  if (ce && BaseEl && !ce.get('agy-tab')) {
    class AgyTabElement extends BaseEl {
      constructor() {
        super();
        this._item = null;
        this._opts = {};
      }
      connectedCallback() {
        this.setAttribute('role', 'tab');
        if (this._item) this.render();
      }
      render() {
        ui.updateTabPill(this, this._item || {}, this._opts);
      }
      get tab() {
        return this._item;
      }
      set tab(val) {
        this._item = val || {};
        this.render();
      }
      get options() {
        return this._opts;
      }
      set options(val) {
        this._opts = { ...(this._opts || {}), ...(val || {}) };
        if (this._item) this.render();
      }
      startRename(opts = {}) {
        return ui.startInlineRename(this, opts);
      }
    }
    ce.define('agy-tab', AgyTabElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
