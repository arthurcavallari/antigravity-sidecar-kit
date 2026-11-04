(function (win) {
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
  const NAV_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

  function getButtonKey(b) {
    return (
      b?.dataset?.toggleId ??
      b?.dataset?.id ??
      b?.dataset?.value ??
      b?.dataset?.tab ??
      b?.dataset?.subtab ??
      b?.dataset?.scope ??
      b?.dataset?.cat ??
      ''
    );
  }

  function applyToggleSelection(btns, targetBtnOrId) {
    const byNode = targetBtnOrId && typeof targetBtnOrId === 'object';
    const hasMatch = btns.some((b) => !b.disabled && (byNode ? b === targetBtnOrId : getButtonKey(b) === targetBtnOrId));
    let assignedRoving = false;
    for (const b of btns) {
      const isSel = byNode ? b === targetBtnOrId : Boolean(targetBtnOrId) && getButtonKey(b) === targetBtnOrId;
      const isRoving = (isSel && !b.disabled) || (!hasMatch && !b.disabled && !assignedRoving);
      if (isRoving) assignedRoving = true;
      b.classList.toggle('active', isSel);
      b.setAttribute('aria-selected', isSel ? 'true' : 'false');
      b.setAttribute('aria-checked', isSel ? 'true' : 'false');
      b.setAttribute('tabindex', isRoving ? '0' : '-1');
      try {
        b.tabIndex = isRoving ? 0 : -1;
      } catch {}
    }
  }

  function stepToggleFocus(btns, sourceBtn, key) {
    const enabled = btns.filter((b) => !b.disabled);
    if (!enabled.length) return null;
    const active =
      (sourceBtn && !sourceBtn.disabled ? sourceBtn : null) ||
      enabled.find((b) => b.getAttribute?.('tabindex') === '0' || b.tabIndex === 0) ||
      enabled.find((b) => b.classList?.contains?.('active')) ||
      enabled[0];
    const cur = Math.max(0, enabled.indexOf(active));
    if (key === 'Home') return enabled[0];
    if (key === 'End') return enabled[enabled.length - 1];
    const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : enabled.length - 1;
    return enabled[(cur + delta) % enabled.length];
  }

  ui.createToggleGroup = function createToggleGroup(containerEl, items = [], opts = {}) {
    if (!containerEl) return;
    containerEl.classList?.add?.('agy-toggle-group');
    containerEl.classList?.toggle?.('agy-toggle-group-grid', opts.layout === 'grid');
    if (opts.layout === 'grid' && items.length > 0) {
      containerEl.style?.setProperty?.('--agy-toggle-cols', String(items.length));
    }
    ui.clear(containerEl);

    const btns = [];
    const syncSelection = (targetBtn, e, triggerFocus = false) => {
      applyToggleSelection(btns, targetBtn);
      if (triggerFocus) targetBtn.focus?.();
      opts.onChange?.(targetBtn.dataset.toggleId, e);
    };

    const handleKey = (e, sourceBtn) => {
      if (e._agyToggleHandled || !NAV_KEYS.includes(e.key)) return;
      const nextBtn = stepToggleFocus(btns, sourceBtn, e.key);
      if (!nextBtn) return;
      e._agyToggleHandled = true;
      e.preventDefault?.();
      syncSelection(nextBtn, e, true);
    };

    for (const it of items) {
      const isDisabled = Boolean(it.disabled);
      const btn = ui.el(
        'button',
        {
          type: 'button',
          className: `agy-toggle-item${it.id === opts.activeId ? ' active' : ''}`,
          disabled: isDisabled,
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
    applyToggleSelection(btns, opts.activeId || '');

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
        this._rovingBtn = null;
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
          const btns = Array.from(this.querySelectorAll?.('.agy-toggle-item') || []);
          if (this._layout === 'grid' && btns.length > 0) {
            this.style?.setProperty?.('--agy-toggle-cols', String(btns.length));
          }
          if (!this._value) {
            const preActive = btns.find((b) => b.classList?.contains?.('active'));
            const inferred = preActive ? getButtonKey(preActive) : '';
            if (inferred) this._value = inferred;
          }
          if (this._value) {
            applyToggleSelection(btns, this._value);
          } else {
            const rovingBtn =
              (this._rovingBtn && !this._rovingBtn.disabled && btns.includes(this._rovingBtn) ? this._rovingBtn : null) ||
              btns.find((b) => !b.disabled && b.classList?.contains?.('active')) ||
              btns.find((b) => !b.disabled) ||
              null;
            for (const b of btns) {
              const isAct = Boolean(b.classList?.contains?.('active'));
              b.setAttribute?.('aria-selected', isAct ? 'true' : 'false');
              b.setAttribute?.('aria-checked', isAct ? 'true' : 'false');
              b.setAttribute?.('tabindex', b === rovingBtn ? '0' : '-1');
              try {
                b.tabIndex = b === rovingBtn ? 0 : -1;
              } catch {}
            }
          }
          if (!this._toggleKeyBound) {
            this._toggleKeyBound = true;
            this.addEventListener?.('click', (e) => {
              this._onKeyClick?.();
              if (this._items.length || this._hadItems) return;
              const btn = e.target?.closest?.('.agy-toggle-item');
              if (!btn || btn.disabled) return;
              this._rovingBtn = btn;
              const nextId = getButtonKey(btn);
              if (!nextId) {
                this._render();
                return;
              }
              this._value = nextId;
              this._render();
              if (CEvent) this.dispatchEvent(new CEvent('change', { detail: { value: nextId }, bubbles: true }));
            });
            this.addEventListener?.('keydown', (e) => {
              if (this._toggleKeyHandler) return this._toggleKeyHandler(e);
              if (e._agyToggleHandled || !NAV_KEYS.includes(e.key)) return;
              const curBtns = Array.from(this.querySelectorAll?.('.agy-toggle-item') || []);
              const target = stepToggleFocus(curBtns, e.target?.closest?.('.agy-toggle-item'), e.key);
              if (!target) return;
              e._agyToggleHandled = true;
              e.preventDefault?.();
              this._rovingBtn = target;
              const nextId = getButtonKey(target);
              let clickHandled = false;
              this._onKeyClick = () => {
                clickHandled = true;
              };
              target.focus?.();
              if (nextId) {
                target.click?.();
              }
              this._onKeyClick = null;
              if (nextId) {
                if (!clickHandled || this._value !== nextId) {
                  this._value = nextId;
                  this._render();
                  if (!clickHandled && CEvent) {
                    this.dispatchEvent(new CEvent('change', { detail: { value: nextId }, bubbles: true }));
                  }
                }
              } else {
                this._render();
              }
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
