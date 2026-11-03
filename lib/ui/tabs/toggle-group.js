(function (win) {
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);

  ui.createToggleGroup = function createToggleGroup(containerEl, items = [], opts = {}) {
    if (!containerEl) return;
    containerEl.classList?.add?.('agy-toggle-group');
    containerEl.classList?.toggle?.('agy-toggle-group-grid', opts.layout === 'grid');
    if (opts.layout === 'grid' && items.length > 0) {
      containerEl.style?.setProperty?.('--agy-toggle-cols', String(items.length));
    }
    ui.clear(containerEl);

    const btns = [];
    const hasActiveEnabled = items.some((it) => it.id === opts.activeId && !it.disabled);
    let assignedRoving = false;

    const syncSelection = (targetBtn, e, triggerFocus = false) => {
      for (const b of btns) {
        const isSel = b === targetBtn;
        b.classList.toggle('active', isSel);
        b.setAttribute('aria-selected', isSel ? 'true' : 'false');
        b.setAttribute('aria-checked', isSel ? 'true' : 'false');
        b.setAttribute('tabindex', isSel ? '0' : '-1');
        try { b.tabIndex = isSel ? 0 : -1; } catch {}
      }
      if (triggerFocus) targetBtn.focus?.();
      opts.onChange?.(targetBtn.dataset.toggleId, e);
    };

    const handleKey = (e, sourceBtn) => {
      if (e._agyToggleHandled) return;
      const key = e.key;
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(key)) return;
      e._agyToggleHandled = true;
      e.preventDefault?.();
      const enabled = btns.filter((b) => !b.disabled);
      if (enabled.length === 0) return;
      const activeBtn =
        sourceBtn && !sourceBtn.disabled ? sourceBtn : enabled.find((b) => b.classList.contains('active')) || enabled[0];
      const curIdx = Math.max(0, enabled.indexOf(activeBtn));
      let nextIdx = curIdx;
      if (key === 'ArrowRight' || key === 'ArrowDown') nextIdx = (curIdx + 1) % enabled.length;
      else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIdx = (curIdx - 1 + enabled.length) % enabled.length;
      else if (key === 'Home') nextIdx = 0;
      else if (key === 'End') nextIdx = enabled.length - 1;
      syncSelection(enabled[nextIdx], e, true);
    };

    for (const it of items) {
      const isDisabled = Boolean(it.disabled);
      const isActive = it.id === opts.activeId && !isDisabled;
      const isRoving = isActive || (!hasActiveEnabled && !isDisabled && !assignedRoving);
      if (isRoving) assignedRoving = true;

      const btn = ui.el(
        'button',
        {
          type: 'button',
          className: `agy-toggle-item${it.id === opts.activeId ? ' active' : ''}`,
          disabled: isDisabled,
          tabIndex: isRoving ? 0 : -1,
          'aria-selected': it.id === opts.activeId ? 'true' : 'false',
          'aria-checked': it.id === opts.activeId ? 'true' : 'false',
          title: it.title || undefined,
          dataset: { ...(it.dataset || {}), toggleId: it.id },
          onClick: (e) => {
            if (isDisabled) return;
            syncSelection(btn, e, false);
          },
          onKeyDown: (e) => handleKey(e, btn),
        },
        it.label,
        it.count !== undefined && it.count !== null
          ? ui.el('span', { className: 'agy-count-pill agy-toggle-count' }, String(it.count))
          : null
      );
      btns.push(btn);
      containerEl.appendChild(btn);
    }

    containerEl._toggleKeyHandler = (e) => {
      const targetBtn = e.target?.closest?.('.agy-toggle-item');
      handleKey(e, targetBtn);
    };
    if (!containerEl._toggleKeyBound) {
      containerEl._toggleKeyBound = true;
      containerEl.addEventListener?.('keydown', (e) => containerEl._toggleKeyHandler?.(e));
    }
  };

  if (ce && BaseEl && !ce.get('agy-toggle-group')) {
    class AgyToggleGroupElement extends BaseEl {
      static get observedAttributes() {
        return ['value', 'layout'];
      }
      constructor() {
        super();
        this._items = [];
        this._value = '';
        this._layout = 'inline';
      }
      connectedCallback() {
        if (this.hasAttribute('value')) this._value = this.getAttribute('value') || '';
        if (this.hasAttribute('layout')) this._layout = this.getAttribute('layout') || 'inline';
        this._render();
      }
      attributeChangedCallback(name, oldVal, newVal) {
        if (oldVal === newVal) return;
        if (name === 'value') this._value = newVal || '';
        if (name === 'layout') this._layout = newVal || 'inline';
        this._render();
      }
      get items() {
        return this._items;
      }
      set items(val) {
        this._hadItems = true;
        this._items = Array.isArray(val) ? val : [];
        this._render();
      }
      get value() {
        return this._value;
      }
      set value(val) {
        this._value = String(val ?? '');
        this._render();
      }
      get activeId() {
        return this._value;
      }
      set activeId(val) {
        this.value = val;
      }
      get layout() {
        return this._layout;
      }
      set layout(val) {
        this._layout = val === 'grid' ? 'grid' : 'inline';
        this._render();
      }
      _render() {
        if (!this._items.length && !this._hadItems) {
          this.classList?.add?.('agy-toggle-group');
          this.classList?.toggle?.('agy-toggle-group-grid', this._layout === 'grid');
          const getKey = (b) => b.dataset?.toggleId ?? b.dataset?.tab ?? b.dataset?.subtab ?? b.dataset?.scope ?? b.dataset?.cat ?? '';
          if (this._value) {
            for (const b of this.querySelectorAll?.('.agy-toggle-item') || []) {
              const isSel = getKey(b) === this._value;
              b.classList.toggle('active', isSel);
              b.setAttribute('aria-selected', isSel ? 'true' : 'false');
              b.setAttribute('aria-checked', isSel ? 'true' : 'false');
              b.setAttribute('tabindex', isSel ? '0' : '-1');
              try { b.tabIndex = isSel ? 0 : -1; } catch {}
            }
          }
          if (!this._toggleKeyBound) {
            this._toggleKeyBound = true;
            this.addEventListener?.('keydown', (e) => {
              if (this._toggleKeyHandler) return this._toggleKeyHandler(e);
              if (e._agyToggleHandled || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
              const enabled = Array.from(this.querySelectorAll?.('.agy-toggle-item') || []).filter((b) => !b.disabled);
              if (!enabled.length) return;
              e._agyToggleHandled = true;
              e.preventDefault?.();
              const active = e.target?.closest?.('.agy-toggle-item') || enabled.find((b) => b.classList.contains('active')) || enabled[0];
              const cur = Math.max(0, enabled.indexOf(active));
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length;
              const target = enabled[next];
              const nextId = getKey(target);
              this._value = nextId;
              this._render();
              target.focus?.();
              target.click?.();
              if (CEvent) this.dispatchEvent(new CEvent('change', { detail: { value: nextId }, bubbles: true }));
            });
          }
          return;
        }
        ui.createToggleGroup(this, this._items, {
          activeId: this._value,
          layout: this._layout,
          onChange: (id) => {
            this._value = id;
            if (CEvent) {
              this.dispatchEvent(new CEvent('change', { detail: { value: id }, bubbles: true }));
            }
          },
        });
      }
    }
    ce.define('agy-toggle-group', AgyToggleGroupElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
