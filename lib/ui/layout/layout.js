(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);

  ui.bindSplitResize = function bindSplitResize(handleEl, opts = {}) {
    if (!handleEl) return null;
    let dragging = false;

    const onMove = (e) => {
      if (!dragging || e?._agySplitMoved) return;
      if (e) e._agySplitMoved = true;
      const container =
        typeof opts.containerEl === 'function'
          ? opts.containerEl()
          : opts.containerEl || handleEl.containerEl || handleEl.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dir = opts.direction || handleEl.getAttribute?.('direction') || 'vertical';
      const minR =
        opts.minRatio ?? (handleEl.hasAttribute?.('min-ratio') ? Number(handleEl.getAttribute('min-ratio')) : 0.15);
      const maxR =
        opts.maxRatio ?? (handleEl.hasAttribute?.('max-ratio') ? Number(handleEl.getAttribute('max-ratio')) : 0.85);
      const raw =
        dir === 'horizontal'
          ? ((e.clientX ?? 0) - rect.left) / Math.max(1, rect.width)
          : ((e.clientY ?? 0) - rect.top) / Math.max(1, rect.height);
      const ratio = Math.min(maxR, Math.max(minR, raw));
      opts.onResize?.(ratio, e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize', { detail: { ratio }, bubbles: true }));
    };

    const stop = (e) => {
      win.removeEventListener?.('pointermove', onMove, { capture: true });
      win.removeEventListener?.('pointerup', stop, { capture: true });
      win.removeEventListener?.('pointercancel', stop, { capture: true });
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove('dragging');
      doc.body?.classList?.remove('resizing-split');
      opts.onResizeEnd?.(e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-end', { bubbles: true }));
    };

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      try { handleEl.setPointerCapture?.(e.pointerId); } catch {}
      handleEl.classList.add('dragging');
      doc.body?.classList?.add('resizing-split');
      win.addEventListener?.('pointermove', onMove, { capture: true });
      win.addEventListener?.('pointerup', stop, { capture: true });
      win.addEventListener?.('pointercancel', stop, { capture: true });
      opts.onResizeStart?.(e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-start', { bubbles: true }));
    });
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', stop);
    handleEl.addEventListener('pointercancel', stop);

    return stop;
  };

  if (ce && BaseEl && !ce.get('agy-split-sash')) {
    class AgySplitSashElement extends BaseEl {
      connectedCallback() {
        this.classList.add('agy-split-sash');
        if (this.getAttribute('direction') === 'horizontal') {
          this.classList.add('agy-split-sash-v');
        }
        if (!this.querySelector('.sash-line')) {
          const line = doc.createElement('div');
          line.className = 'sash-line';
          this.appendChild(line);
        }
        if (!this._sashBound) {
          this._sashBound = true;
          this._cleanupResize = ui.bindSplitResize(this, {
            containerEl: () => this.containerEl || this.parentElement,
          });
        }
      }
      disconnectedCallback() {
        this._cleanupResize?.();
      }
    }
    ce.define('agy-split-sash', AgySplitSashElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
