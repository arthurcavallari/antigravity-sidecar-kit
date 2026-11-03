(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);

  ui.renderSwitch = function renderSwitch({ on = false, size = 'md', disabled = false, title = '', attrs = '' } = {}) {
    const cls = `agy-switch${size === 'sm' ? ' sm' : ''}${on ? ' on' : ''}`;
    return `<button type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" class="${cls}"${
      disabled ? ' disabled' : ''
    }${title ? ` title="${ui.escHtml(title)}"` : ''}${attrs ? ` ${attrs}` : ''}><span class="agy-switch-thumb"></span></button>`;
  };

  if (ce && BaseEl && !ce.get('agy-switch')) {
    class AgySwitchElement extends BaseEl {
      static get observedAttributes() {
        return ['checked', 'disabled', 'size', 'title'];
      }
      constructor() {
        super();
        this._checked = false;
        this._disabled = false;
        this._size = 'md';
        this._btn = null;
        this._syncing = false;
      }
      connectedCallback() {
        const p = this.parentElement;
        const inSwitchBtn = p?.getAttribute?.('role') === 'switch';
        if (this.hasAttribute('checked')) this._checked = this.getAttribute('checked') !== 'false';
        else if (
          this.classList?.contains?.('on') ||
          this.getAttribute?.('aria-checked') === 'true' ||
          (inSwitchBtn && (p?.classList?.contains?.('on') || p?.getAttribute?.('aria-checked') === 'true'))
        ) {
          this._checked = true;
        }
        if (this.hasAttribute('disabled')) this._disabled = this.getAttribute('disabled') !== 'false';
        else if (inSwitchBtn && p?.disabled) this._disabled = true;
        if (this.hasAttribute('size')) this._size = this.getAttribute('size') || 'md';
        else if (this.classList?.contains?.('sm') || (inSwitchBtn && p?.classList?.contains?.('sm'))) this._size = 'sm';
        this._ensureDom();
        this._sync();
      }
      attributeChangedCallback(name, oldVal, newVal) {
        if (oldVal === newVal || this._syncing) return;
        if (name === 'checked') this._checked = newVal !== null && newVal !== 'false';
        if (name === 'disabled') this._disabled = newVal !== null && newVal !== 'false';
        if (name === 'size') this._size = newVal || 'md';
        this._sync();
      }
      get checked() {
        return this._checked;
      }
      set checked(val) {
        const next = Boolean(val);
        this._checked = next;
        this._syncing = true;
        if (next) this.setAttribute('checked', '');
        else this.removeAttribute('checked');
        this._syncing = false;
        this._sync();
      }
      get disabled() {
        return this._disabled;
      }
      set disabled(val) {
        const next = Boolean(val);
        this._disabled = next;
        this._syncing = true;
        if (next) this.setAttribute('disabled', '');
        else this.removeAttribute('disabled');
        this._syncing = false;
        this._sync();
      }
      get size() {
        return this._size;
      }
      set size(val) {
        this._size = val === 'sm' ? 'sm' : 'md';
        this._syncing = true;
        this.setAttribute('size', this._size);
        this._syncing = false;
        this._sync();
      }
      _toggle() {
        if (this._disabled) return;
        this.checked = !this._checked;
        if (CEvent) {
          this.dispatchEvent(new CEvent('change', { detail: { checked: this._checked }, bubbles: true }));
        }
      }
      _ensureDom() {
        if (this.parentElement?.getAttribute?.('role') === 'switch') {
          if (!this.querySelector?.('.agy-switch-thumb')) {
            const thumb = doc.createElement('span');
            thumb.className = 'agy-switch-thumb';
            this.appendChild(thumb);
          }
          return;
        }
        if (this._btn) return;
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'switch');
        const thumb = doc.createElement('span');
        thumb.className = 'agy-switch-thumb';
        btn.appendChild(thumb);
        const onKey = (e) => {
          if (e._agySwitchHandled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e._agySwitchHandled = true;
            e.preventDefault?.();
            e.stopPropagation?.();
            this._toggle();
          }
        };
        btn.addEventListener('click', (e) => {
          e.stopPropagation?.();
          this._toggle();
        });
        btn.addEventListener('keydown', onKey);
        this.addEventListener('keydown', onKey);
        this.replaceChildren(btn);
        this._btn = btn;
      }
      _sync() {
        const p = this.parentElement;
        if (p?.getAttribute?.('role') === 'switch') {
          this._ensureDom();
          if (!p.classList?.contains?.('agy-switch')) {
            this.className = `agy-switch${this._size === 'sm' ? ' sm' : ''}${this._checked ? ' on' : ''}${
              this._disabled ? ' disabled' : ''
            }`;
          }
          return;
        }
        this._ensureDom();
        const btn = this._btn;
        const checkedStr = this._checked ? 'true' : 'false';
        btn.className = `agy-switch${this._size === 'sm' ? ' sm' : ''}${this._checked ? ' on' : ''}${
          this._disabled ? ' disabled' : ''
        }`;
        btn.setAttribute('aria-checked', checkedStr);
        this.setAttribute('aria-checked', checkedStr);
        btn.disabled = this._disabled;
        if (this.hasAttribute('title')) btn.title = this.getAttribute('title') || '';
      }
    }
    ce.define('agy-switch', AgySwitchElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
