(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const RO = win.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
  const MO = win.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

  function isPinnedControl(ch, addRole, pinnedSelector) {
    if (!ch) return false;
    const role = ch.dataset?.role;
    if (role === addRole || role === 'add-tab' || role === 'agy-add-tab') return true;
    if (ch.classList?.contains?.('agy-tab-add') || ch.classList?.contains?.('agy-tab-add-btn')) return true;
    return Boolean(pinnedSelector && typeof ch.matches === 'function' && ch.matches(pinnedSelector));
  }

  function bindTabStripKeydown(stripEl) {
    if (!stripEl || stripEl._tabKeyBound) return;
    stripEl._tabKeyBound = true;
    stripEl.addEventListener?.('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const target = e.target;
      if (!target || target._isRenaming || !target.classList?.contains?.('agy-tab')) return;
      const pills = Array.from(stripEl.children || []).filter((ch) => ch?.classList?.contains?.('agy-tab'));
      if (pills.length < 2) return;
      const idx = pills.indexOf(target);
      if (idx === -1) return;
      let nextIdx = idx;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % pills.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + pills.length) % pills.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = pills.length - 1;
      e.preventDefault?.();
      pills[nextIdx]?.focus?.();
    });
  }

  ui.matchTabCycleShortcut = function matchTabCycleShortcut(e) {
    if (!e || typeof e !== 'object') return 0;
    if (e.altKey || e.getModifierState?.('AltGraph')) return 0;
    const key = String(e.key || '');
    const code = String(e.code || '');
    if ((key === 'Tab' || code === 'Tab') && e.ctrlKey && !e.metaKey) {
      return e.shiftKey ? -1 : 1;
    }
    const nav = win?.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const isMac = /mac|iphone|ipad|ipod/i.test(String(nav?.platform || nav?.userAgent || ''));
    const hasPrimaryMod = isMac ? Boolean(e.metaKey) && !e.ctrlKey : Boolean(e.ctrlKey) && !e.metaKey;
    if (hasPrimaryMod && e.shiftKey) {
      if (code === 'Period' || key === '>' || key === '.') return 1;
      if (code === 'Comma' || key === '<' || key === ',') return -1;
    }
    return 0;
  };

  ui.cycleTabStrip = function cycleTabStrip(stripEl, dir = 1) {
    if (!stripEl || (dir !== 1 && dir !== -1)) return false;
    const pills = Array.from(stripEl.children || []).filter(
      (ch) => ch?.classList?.contains?.('agy-tab') && !ch.disabled && !ch.classList?.contains?.('hidden')
    );
    if (!pills.length) return false;
    const curIdx = pills.findIndex(
      (ch) => ch.classList?.contains?.('active') || ch.getAttribute?.('aria-selected') === 'true'
    );
    const nextIdx = curIdx === -1 ? (dir > 0 ? 0 : pills.length - 1) : (curIdx + dir + pills.length) % pills.length;
    const nextPill = pills[nextIdx];
    if (!nextPill) return false;
    if (nextIdx !== curIdx || curIdx === -1) {
      nextPill.click?.();
    }
    const inlineAlign = nextIdx === 0 ? 'start' : nextIdx === pills.length - 1 ? 'end' : 'nearest';
    nextPill.scrollIntoView?.({ block: 'nearest', inline: inlineAlign });
    return true;
  };

  ui.bindGlobalTabCycleKeydown = function bindGlobalTabCycleKeydown(stripOrResolver, opts = {}) {
    const root = opts.root || doc?.documentElement || doc || win;
    if (!root || typeof root.addEventListener !== 'function') return () => {};
    root._cleanupTabCycleKeydown?.();
    if (doc) doc._hasLocalTabCycleHandler = true;
    const resolveStrip = (sourceWin = null) =>
      typeof stripOrResolver === 'function' ? stripOrResolver(sourceWin) : stripOrResolver;

    const onKeyDown = (e) => {
      const dir = ui.matchTabCycleShortcut(e);
      if (!dir) return;
      const stripEl = resolveStrip(null);
      if (!stripEl) return;
      e.preventDefault?.();
      e.stopPropagation?.();
      if (e.repeat) return;
      if (ui.cycleTabStrip(stripEl, dir)) {
        opts.onCycle?.(stripEl, dir, e);
      }
    };

    const onMessage = (e) => {
      if (opts.listenForwarded === false) return;
      if (typeof opts.isTrustedMessage === 'function' && !opts.isTrustedMessage(e)) return;
      const d = e?.data;
      if (!d || typeof d !== 'object' || d.type !== 'agy:shortcut-forwarded') return;
      const payload = d.payload && typeof d.payload === 'object' ? d.payload : d;
      const dir = payload.dir === 1 || payload.dir === -1 ? payload.dir : 0;
      if (!dir || payload.repeat) return;
      const stripEl = resolveStrip(e.source || null);
      if (!stripEl) return;
      if (ui.cycleTabStrip(stripEl, dir)) {
        opts.onCycle?.(stripEl, dir, e);
      }
    };

    root.addEventListener('keydown', onKeyDown, true);
    if (opts.listenForwarded !== false && typeof win?.addEventListener === 'function') {
      win.addEventListener('message', onMessage);
    }

    const cleanup = () => {
      root.removeEventListener?.('keydown', onKeyDown, true);
      if (opts.listenForwarded !== false && typeof win?.removeEventListener === 'function') {
        win.removeEventListener('message', onMessage);
      }
      if (root._cleanupTabCycleKeydown === cleanup) root._cleanupTabCycleKeydown = null;
      if (doc) doc._hasLocalTabCycleHandler = false;
    };
    root._cleanupTabCycleKeydown = cleanup;
    return cleanup;
  };

  ui.reconcileTabStrip = function reconcileTabStrip(stripEl, items = [], callbacksOrOpts = {}, maybeOpts) {
    if (!stripEl) return;
    if (!stripEl.hasAttribute?.('role')) stripEl.setAttribute?.('role', 'tablist');
    bindTabStripKeydown(stripEl);
    const opts = { ...(callbacksOrOpts || {}), ...(maybeOpts || {}) };
    const idKey = opts.idDatasetKey || 'tabId';
    const addRole = opts.addButton?.role || 'agy-add-tab';
    const existingById = new Map();
    let addBtn = null;
    let hintEl = null;

    for (const ch of Array.from(stripEl.children || [])) {
      if (isPinnedControl(ch, addRole, opts.pinnedSelector)) addBtn = ch;
      else if (ch?.classList?.contains?.('agy-tab-drop-hint')) hintEl = ch;
      else if (ch?.dataset?.[idKey] || ch?.dataset?.tabId) existingById.set(ch.dataset[idKey] || ch.dataset.tabId, ch);
    }

    const desiredIds = new Set(items.map((it) => String(it.id)));
    for (const [id, el] of existingById.entries()) {
      if (!desiredIds.has(id)) {
        el.remove();
        existingById.delete(id);
      }
    }

    if (items.length === 0 && opts.emptyHint) {
      if (!hintEl) {
        hintEl = ui.el('span', { className: 'agy-tab-drop-hint' }, opts.emptyHint);
        stripEl.insertBefore(hintEl, addBtn || null);
      } else hintEl.textContent = opts.emptyHint;
    } else if (hintEl) hintEl.remove();

    items.forEach((item, idx) => {
      const id = String(item.id);
      let btn = existingById.get(id);
      if (!btn) {
        btn = ui.createTabPill(item, opts);
        existingById.set(id, btn);
        stripEl.insertBefore(btn, stripEl.children[idx] || addBtn || null);
      } else {
        ui.updateTabPill(btn, item, opts);
        if (stripEl.children[idx] !== btn) stripEl.insertBefore(btn, stripEl.children[idx] || addBtn || null);
      }
    });

    if (opts.addButton) {
      const addLabel = opts.addButton.ariaLabel || opts.addButton.title || 'New tab';
      if (!addBtn) {
        addBtn = ui.el('button', {
          type: 'button',
          className: 'agy-icon-btn agy-tab-add agy-tab-add-btn',
          'aria-label': addLabel,
          title: opts.addButton.title || 'New Tab',
          dataset: { role: addRole, ...(opts.addButton.testId ? { testid: opts.addButton.testId } : {}) },
          innerHTML: ui.iconSvg('add', 18),
          onClick: (e) => addBtn._onClick?.(e, addBtn),
        });
        addBtn._createdByAgy = true;
      } else {
        addBtn.setAttribute?.('aria-label', addLabel);
        if (opts.addButton.title) addBtn.title = opts.addButton.title;
      }
      addBtn._onClick = opts.addButton.onClick;
      if (stripEl.lastElementChild !== addBtn) stripEl.appendChild(addBtn);
    } else if (addBtn) {
      if (addBtn._createdByAgy) addBtn.remove();
      else if (stripEl.lastElementChild !== addBtn) stripEl.appendChild(addBtn);
    }
  };

  function collectDomTabs(stripEl, pinnedSelector, idKey = 'tabId') {
    const out = [];
    for (const ch of Array.from(stripEl.children || [])) {
      if (isPinnedControl(ch, 'agy-add-tab', pinnedSelector) || ch.classList?.contains?.('agy-tab-drop-hint')) continue;
      const id = ch.dataset?.[idKey] || ch.dataset?.tabId || ch._item?.id || '';
      const labelNode = ch.querySelector?.('[data-role="tab-label"], .agy-tab-label');
      const iconNode = ch.querySelector?.('[data-role="tab-icon"], .agy-tab-icon');
      out.push({
        id,
        label: labelNode ? labelNode.textContent : ch.textContent?.trim() || id,
        active: Boolean(ch.classList?.contains?.('active')),
        pinned: ch.dataset?.pinned === 'true',
        iconEl: iconNode ? iconNode.cloneNode(true) : null,
        _domEl: ch,
      });
    }
    return out;
  }

  ui.setupStripScroll = function setupStripScroll(
    stripEl, overflowBtnOrOpts, getItemsFn, onSelectFn, popoverEl, getClosedItemsFn, onReopenClosedFn, maybeOpts = {}
  ) {
    if (!stripEl) return null;
    const isObj = overflowBtnOrOpts && typeof overflowBtnOrOpts === 'object' && !overflowBtnOrOpts.nodeType && typeof overflowBtnOrOpts.addEventListener !== 'function';
    const src = isObj ? overflowBtnOrOpts : maybeOpts || {};
    const cfg = {
      overflowBtn: isObj ? src.overflowBtn || null : overflowBtnOrOpts || null,
      popoverEl: isObj ? src.popoverEl || src.overflowMenuEl || null : popoverEl || src.overflowMenuEl || null,
      getItems: isObj ? src.getItems || src.getTabs : getItemsFn,
      onSelect: isObj ? src.onSelect || src.onSelectTab : onSelectFn,
      getClosedItems: isObj ? src.getClosedItems || src.getClosedTabs : getClosedItemsFn,
      onReopenClosed: isObj ? src.onReopenClosed || src.onReopenTab : onReopenClosedFn,
      renderItemIcon: src.renderItemIcon,
      pinnedSelector: src.pinnedSelector || null,
      idDatasetKey: src.idDatasetKey || 'tabId',
    };

    stripEl._scrollCfg = cfg;
    if (cfg.overflowBtn) {
      cfg.overflowBtn.classList?.add?.('agy-tab-overflow-btn');
      cfg.overflowBtn.setAttribute?.('aria-haspopup', 'menu');
      if (!cfg.overflowBtn.hasAttribute?.('aria-expanded')) {
        cfg.overflowBtn.setAttribute?.('aria-expanded', 'false');
      }
    }
    if (cfg.popoverEl) {
      cfg.popoverEl.setAttribute?.('role', 'menu');
    }
    if (stripEl._scrollBound) {
      stripEl._updateOverflow?.();
      return { syncMasks: stripEl._updateOverflow, disconnect: stripEl._disconnectScroll };
    }
    stripEl._scrollBound = true;

    const syncMasks = () => {
      const c = stripEl._scrollCfg || cfg;
      const sLeft = stripEl.scrollLeft || 0;
      const canL = sLeft > 2;
      const canR = sLeft + (stripEl.clientWidth || 0) < (stripEl.scrollWidth || 0) - 2;
      stripEl.classList?.toggle?.('mask-left', canL && !canR);
      stripEl.classList?.toggle?.('mask-right', !canL && canR);
      stripEl.classList?.toggle?.('mask-both', canL && canR);
      if (c.overflowBtn) {
        const closedCount = c.getClosedItems?.()?.length || 0;
        c.overflowBtn.classList?.toggle?.('hidden', !canL && !canR && closedCount === 0);
        c.overflowBtn.classList?.toggle?.('has-hidden-tabs', closedCount > 0);
        let badgeEl = c.overflowBtn.querySelector?.('.agy-tab-overflow-badge');
        if (closedCount > 0) {
          if (!badgeEl) c.overflowBtn.appendChild((badgeEl = ui.el('span', { className: 'agy-tab-overflow-badge' })));
          badgeEl.textContent = String(closedCount);
          c.overflowBtn.title = `All Tabs (${closedCount} hidden)`;
        } else {
          badgeEl?.remove?.();
          c.overflowBtn.title = 'All Tabs';
        }
      }
    };
    stripEl._updateScroll = stripEl._updateOverflow = syncMasks;

    stripEl.addEventListener('scroll', syncMasks, { passive: true });
    stripEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault?.();
        stripEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    const ro = RO ? new RO(syncMasks) : null;
    const mo = MO ? new MO(syncMasks) : null;
    ro?.observe?.(stripEl);
    mo?.observe?.(stripEl, { childList: true });
    stripEl._disconnectScroll = () => {
      ro?.disconnect?.();
      mo?.disconnect?.();
    };

    if (cfg.overflowBtn && cfg.popoverEl && !cfg.overflowBtn._overflowBound) {
      cfg.overflowBtn._overflowBound = true;
      cfg.popoverEl.classList?.add?.('agy-tab-overflow-popover');
      if (!cfg.popoverEl._popoverKeyBound) {
        cfg.popoverEl._popoverKeyBound = true;
        cfg.popoverEl.addEventListener?.('toggle', (ev) => {
          if (ev?.newState === 'closed') {
            cfg.popoverEl._activeTriggerBtn?.setAttribute?.('aria-expanded', 'false');
          }
        });
        cfg.popoverEl.addEventListener?.('keydown', (ev) => {
          const pop = cfg.popoverEl;
          const key = ev.key;
          if (key === 'Escape') {
            ev.preventDefault?.();
            ev.stopPropagation?.();
            const trigger = pop._activeTriggerBtn;
            trigger?.setAttribute?.('aria-expanded', 'false');
            pop.hidePopover?.();
            trigger?.focus?.();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
          const items = Array.from(pop.querySelectorAll?.('.agy-tab-overflow-item') || []).filter((b) => !b.disabled);
          if (!items.length) return;
          ev.preventDefault?.();
          ev.stopPropagation?.();
          const domIdx = items.indexOf(doc.activeElement);
          const curIdx = domIdx !== -1 ? domIdx : (typeof pop._focusIdx === 'number' ? pop._focusIdx : -1);
          let nextIdx = 0;
          if (key === 'ArrowDown') nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % items.length;
          else if (key === 'ArrowUp') nextIdx = curIdx <= 0 ? items.length - 1 : curIdx - 1;
          else if (key === 'Home') nextIdx = 0;
          else if (key === 'End') nextIdx = items.length - 1;
          pop._focusIdx = nextIdx;
          items[nextIdx]?.focus?.();
        });
      }
      cfg.overflowBtn.addEventListener('click', (e) => {
        e.stopPropagation?.();
        const c = stripEl._scrollCfg || cfg;
        const list = typeof c.getItems === 'function' ? c.getItems() || [] : collectDomTabs(stripEl, c.pinnedSelector, c.idDatasetKey);
        const closedList = c.getClosedItems?.() || [];
        if (!list.length && !closedList.length) return;
        let isOpen = false;
        try { isOpen = Boolean(c.popoverEl.matches?.(':popover-open')); } catch {}
        if (isOpen && c.popoverEl._activeTriggerBtn === c.overflowBtn) {
          c.overflowBtn.setAttribute?.('aria-expanded', 'false');
          return c.popoverEl.hidePopover?.();
        }
        if (c.popoverEl._activeTriggerBtn && c.popoverEl._activeTriggerBtn !== c.overflowBtn) {
          c.popoverEl._activeTriggerBtn.setAttribute?.('aria-expanded', 'false');
        }
        c.popoverEl._activeTriggerBtn = c.overflowBtn;
        ui.clear(c.popoverEl);
        const rect = c.overflowBtn.getBoundingClientRect?.() || { bottom: 32, right: 240 };
        c.popoverEl.style.top = `${Math.round(rect.bottom + 6)}px`;
        c.popoverEl.style.left = `${Math.max(8, Math.round(rect.right - 220))}px`;
        const activeId = stripEl.querySelector?.('.agy-tab.active')?.dataset?.tabId || '';
        const hasOverflow = (stripEl.scrollWidth || 0) > (stripEl.clientWidth || 0) + 1;
        const renderedItems = [];

        const appendItem = (tab, isClosed = false) => {
          const tabId = tab.id ?? tab.tabId ?? '';
          const tabName = tab.displayName ?? tab.title ?? tab.label ?? tabId;
          const isTabActive = !isClosed && (Boolean(tab.active) || (activeId && tabId === activeId));
          const icon = doc.createElement('span');
          icon.className = 'agy-tab-icon';
          const customIcon = c.renderItemIcon?.(tab) || tab.iconElement || tab.iconEl;
          if (customIcon && customIcon.nodeType) icon.appendChild(customIcon.parentNode ? customIcon.cloneNode(true) : customIcon);
          else if (typeof customIcon === 'string') icon.innerHTML = customIcon;
          else icon.appendChild(ui.iconEl(typeof tab.icon === 'string' && tab.icon ? tab.icon : 'grid_view', 14));
          const left = ui.el('span', { className: 'agy-tab-overflow-item-left' }, icon, ui.el('span', { className: 'agy-tab-overflow-item-title' }, tabName));
          const itemIdx = renderedItems.length;
          const item = ui.el('button', {
            type: 'button',
            role: 'menuitem',
            className: `agy-tab-overflow-item${isClosed ? ' is-hidden-tab' : isTabActive ? ' active' : ''}`,
            title: isClosed ? `Show ${tabName}` : undefined,
            onFocus: () => {
              c.popoverEl._focusIdx = itemIdx;
            },
            onClick: () => {
              c.overflowBtn.setAttribute?.('aria-expanded', 'false');
              c.popoverEl.hidePopover?.();
              if (isClosed) c.onReopenClosed?.(tabId);
              else if (c.onSelect) c.onSelect(tabId);
              else tab._domEl?.click?.();
            },
          }, left);
          if (isClosed) item.appendChild(ui.el('span', { className: 'agy-tab-overflow-restore' }, 'Show'));
          else if (tab.status || tab.statusBadge || tab.isRunning || tab.isErrored) {
            const stateCls = tab.status || ui.formatStatusBadge(tab.statusBadge, tab.isRunning, tab.isErrored).state;
            item.appendChild(ui.el('span', { className: `agy-status-dot ${stateCls}` }));
          }
          if (!isClosed && (tab.isPinned || tab.pinned)) item.appendChild(ui.el('span', { className: 'agy-tab-pin', innerHTML: ui.iconSvg('keep', 12) }));
          renderedItems.push(item);
          c.popoverEl.appendChild(item);
        };

        if (list.length && (hasOverflow || !closedList.length)) {
          if (closedList.length) c.popoverEl.appendChild(ui.el('div', { className: 'agy-tab-overflow-section', role: 'presentation' }, 'Open Tabs'));
          for (const t of list) appendItem(t, false);
        }
        if (closedList.length) {
          c.popoverEl.appendChild(ui.el('div', { className: 'agy-tab-overflow-section', role: 'presentation' }, `Hidden Tabs (${closedList.length})`));
          for (const t of closedList) appendItem(t, true);
        }
        c.overflowBtn.setAttribute?.('aria-expanded', 'true');
        c.popoverEl.showPopover?.();
        const activeIdx = renderedItems.findIndex((b) => b.classList?.contains?.('active'));
        const initIdx = activeIdx >= 0 ? activeIdx : 0;
        c.popoverEl._focusIdx = initIdx;
        renderedItems[initIdx]?.focus?.();
      });
    }
    syncMasks();
    return { syncMasks, disconnect: stripEl._disconnectScroll };
  };

  if (ce && BaseEl && !ce.get('agy-tab-strip')) {
    class AgyTabStripElement extends BaseEl {
      constructor() {
        super();
        this._tabs = [];
        this._closedTabs = [];
        this._options = {};
      }
      connectedCallback() {
        this.classList.add('agy-tab-strip');
        if (!this.hasAttribute?.('role')) this.setAttribute?.('role', 'tablist');
        bindTabStripKeydown(this);
        if (this._tabs.length > 0) {
          this._render();
          ui.setupStripScroll(this, { ...this._options, getItems: () => this._tabs, getClosedItems: () => this._closedTabs });
        }
      }
      disconnectedCallback() {
        this._disconnectScroll?.();
      }
      get tabs() {
        return this._tabs;
      }
      set tabs(val) {
        this._tabs = Array.isArray(val) ? val : [];
        this._render();
      }
      get closedTabs() {
        return this._closedTabs;
      }
      set closedTabs(val) {
        this._closedTabs = Array.isArray(val) ? val : [];
        this._updateOverflow?.();
      }
      get options() {
        return this._options;
      }
      set options(val) {
        this._options = val || {};
        this._render();
      }
      _render() {
        ui.reconcileTabStrip(this, this._tabs, this._options);
      }
    }
    ce.define('agy-tab-strip', AgyTabStripElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
