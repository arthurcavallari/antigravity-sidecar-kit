(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const BaseEl = win.HTMLElement || (typeof HTMLElement !== 'undefined' ? HTMLElement : null);
  const ce = win.customElements || (typeof customElements !== 'undefined' ? customElements : null);
  const CEvent = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);

  ui.bindSplitResize = function bindSplitResize(handleEl, opts = {}) {
    if (!handleEl) return null;
    handleEl._cleanupResize?.();
    let dragging = false;

    const resolveContainer = () =>
      typeof opts.containerEl === 'function'
        ? opts.containerEl()
        : opts.containerEl || handleEl.containerEl || handleEl.parentElement;
    const resolveDir = () => opts.direction || handleEl.getAttribute?.('direction') || 'vertical';
    const resolveBounds = () => {
      const minR =
        opts.minRatio ?? (handleEl.hasAttribute?.('min-ratio') ? Number(handleEl.getAttribute('min-ratio')) : 0.15);
      const maxR =
        opts.maxRatio ?? (handleEl.hasAttribute?.('max-ratio') ? Number(handleEl.getAttribute('max-ratio')) : 0.85);
      return { minR, maxR };
    };

    if (!handleEl.hasAttribute?.('role')) handleEl.setAttribute?.('role', 'separator');
    if (!handleEl.hasAttribute?.('tabindex')) handleEl.setAttribute?.('tabindex', '0');
    if (!handleEl.hasAttribute?.('aria-orientation')) {
      handleEl.setAttribute?.('aria-orientation', resolveDir() === 'horizontal' ? 'vertical' : 'horizontal');
    }

    const syncAriaRatio = (ratio, minR, maxR) => {
      handleEl._lastRatio = ratio;
      handleEl.setAttribute?.('aria-valuemin', String(Math.round(minR * 100)));
      handleEl.setAttribute?.('aria-valuemax', String(Math.round(maxR * 100)));
      handleEl.setAttribute?.('aria-valuenow', String(Math.round(ratio * 100)));
    };

    const onMove = (e) => {
      if (!dragging || e?._agySplitMoved) return;
      if (e) e._agySplitMoved = true;
      const container = resolveContainer();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dir = resolveDir();
      const { minR, maxR } = resolveBounds();
      const raw =
        dir === 'horizontal'
          ? ((e.clientX ?? 0) - rect.left) / Math.max(1, rect.width)
          : ((e.clientY ?? 0) - rect.top) / Math.max(1, rect.height);
      const ratio = Math.min(maxR, Math.max(minR, raw));
      syncAriaRatio(ratio, minR, maxR);
      opts.onResize?.(ratio, e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize', { detail: { ratio }, bubbles: true }));
    };

    const stop = (e) => {
      win.removeEventListener?.('pointermove', onMove, { capture: true });
      win.removeEventListener?.('pointerup', stop, { capture: true });
      win.removeEventListener?.('pointercancel', stop, { capture: true });
      if (!dragging) return;
      dragging = false;
      handleEl.classList?.remove?.('dragging');
      doc.body?.classList?.remove('resizing-split');
      opts.onResizeEnd?.(e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-end', { bubbles: true }));
    };

    const onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      try { handleEl.setPointerCapture?.(e.pointerId); } catch {}
      handleEl.classList?.add?.('dragging');
      doc.body?.classList?.add('resizing-split');
      win.addEventListener?.('pointermove', onMove, { capture: true });
      win.addEventListener?.('pointerup', stop, { capture: true });
      win.addEventListener?.('pointercancel', stop, { capture: true });
      opts.onResizeStart?.(e);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-start', { bubbles: true }));
    };

    const onKeyDown = (e) => {
      const dir = resolveDir();
      const isHoriz = dir === 'horizontal';
      const decKey = isHoriz ? 'ArrowLeft' : 'ArrowUp';
      const incKey = isHoriz ? 'ArrowRight' : 'ArrowDown';
      const key = e?.key;
      if (key !== decKey && key !== incKey && key !== 'Home' && key !== 'End') return;
      const container = resolveContainer();
      if (!container) return;
      e.preventDefault?.();
      e.stopPropagation?.();
      const rect = container.getBoundingClientRect?.() || { left: 0, top: 0, width: 400, height: 400 };
      const span = Math.max(1, (isHoriz ? rect.width : rect.height) || 400);
      const { minR, maxR } = resolveBounds();
      const sashRect = handleEl.getBoundingClientRect?.();
      let curRatio = typeof handleEl._lastRatio === 'number' ? handleEl._lastRatio : 0.5;
      if (sashRect) {
        const sashPos = isHoriz ? sashRect.left - rect.left : sashRect.top - rect.top;
        if (sashPos > 0 && sashPos < span) curRatio = sashPos / span;
      }
      const stepPx = opts.stepPx || (e.shiftKey ? 40 : 20);
      const stepRatio = stepPx / span;
      let nextRatio = curRatio;
      let deltaPx = 0;
      if (key === decKey) {
        nextRatio = Math.min(maxR, Math.max(minR, curRatio - stepRatio));
        deltaPx = -stepPx;
      } else if (key === incKey) {
        nextRatio = Math.min(maxR, Math.max(minR, curRatio + stepRatio));
        deltaPx = stepPx;
      } else if (key === 'Home') {
        nextRatio = minR;
        deltaPx = Math.round((minR - curRatio) * span);
      } else if (key === 'End') {
        nextRatio = maxR;
        deltaPx = Math.round((maxR - curRatio) * span);
      }
      syncAriaRatio(nextRatio, minR, maxR);
      const basePos = Math.round(curRatio * span);
      const startEv = {
        clientX: isHoriz ? rect.left + basePos : rect.left,
        clientY: isHoriz ? rect.top : rect.top + basePos,
        key,
        isKeyboard: true,
      };
      const moveEv = {
        clientX: startEv.clientX + (isHoriz ? deltaPx : 0),
        clientY: startEv.clientY + (isHoriz ? 0 : deltaPx),
        key,
        isKeyboard: true,
      };
      opts.onResizeStart?.(startEv);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-start', { bubbles: true }));
      opts.onResize?.(nextRatio, moveEv);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize', { detail: { ratio: nextRatio }, bubbles: true }));
      opts.onResizeEnd?.(moveEv);
      if (CEvent) handleEl.dispatchEvent?.(new CEvent('split-resize-end', { bubbles: true }));
    };

    handleEl.addEventListener('pointerdown', onPointerDown);
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', stop);
    handleEl.addEventListener('pointercancel', stop);
    handleEl.addEventListener('keydown', onKeyDown);

    const cleanup = () => {
      stop();
      handleEl.removeEventListener?.('pointerdown', onPointerDown);
      handleEl.removeEventListener?.('pointermove', onMove);
      handleEl.removeEventListener?.('pointerup', stop);
      handleEl.removeEventListener?.('pointercancel', stop);
      handleEl.removeEventListener?.('keydown', onKeyDown);
      if (handleEl._cleanupResize === cleanup) handleEl._cleanupResize = null;
    };
    handleEl._cleanupResize = cleanup;
    return cleanup;
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
