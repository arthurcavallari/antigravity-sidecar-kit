(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});

  let activeMenuEl = null;
  let cleanupMenu = null;
  let prevMenuFocus = null;

  ui.closeContextMenu = function closeContextMenu(restoreFocus = false) {
    const toRestore = restoreFocus ? prevMenuFocus : null;
    prevMenuFocus = null;
    if (activeMenuEl) {
      activeMenuEl.remove?.();
      activeMenuEl = null;
    }
    if (cleanupMenu) {
      cleanupMenu();
      cleanupMenu = null;
    }
    if (toRestore && typeof toRestore.focus === 'function') {
      toRestore.focus();
    }
  };

  ui.openContextMenu = function openContextMenu(anchorOrEvent, items = []) {
    anchorOrEvent?.preventDefault?.();
    anchorOrEvent?.stopPropagation?.();
    const candidateFocus =
      (doc.activeElement && doc.activeElement !== doc.body && !activeMenuEl?.contains?.(doc.activeElement)
        ? doc.activeElement
        : null) ||
      (typeof anchorOrEvent?.focus === 'function' ? anchorOrEvent : null) ||
      (typeof anchorOrEvent?.currentTarget?.focus === 'function' ? anchorOrEvent.currentTarget : null) ||
      (typeof anchorOrEvent?.target?.closest === 'function'
        ? anchorOrEvent.target.closest('button, [role="tab"], [tabindex]') || anchorOrEvent.target
        : anchorOrEvent?.target) ||
      prevMenuFocus;
    ui.closeContextMenu(false);
    const validItems = items.filter(Boolean);
    if (validItems.length === 0) return null;
    prevMenuFocus = typeof candidateFocus?.focus === 'function' ? candidateFocus : null;
    const menu = doc.createElement('div');
    menu.className = 'agy-context-menu';
    menu.setAttribute?.('role', 'menu');
    const enabledBtns = [];
    let focusIdx = -1;

    for (const item of validItems) {
      if (item.separator) {
        const sep = doc.createElement('div');
        sep.className = 'agy-context-menu-sep';
        sep.setAttribute?.('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `agy-context-menu-item${item.danger ? ' danger' : ''}`;
      btn.setAttribute?.('role', 'menuitem');
      if (item.id) {
        btn.dataset.menuAction = item.id;
        btn.dataset.menuId = item.id;
      }
      btn.disabled = Boolean(item.disabled);
      const iconHtml = item.icon ? `<span class="agy-tab-icon">${ui.iconSvg(item.icon, 15)}</span>` : '';
      const checkHtml = item.checked
        ? `<span class="agy-tab-icon agy-context-menu-check">${ui.iconSvg('check', 14)}</span>`
        : '';
      btn.innerHTML = `${iconHtml}<span class="agy-context-menu-label">${ui.escHtml(item.label || '')}</span>${checkHtml}`;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation?.();
        if (btn.disabled) return;
        ui.closeContextMenu();
        item.onClick?.();
      });
      if (!btn.disabled) {
        const idx = enabledBtns.length;
        enabledBtns.push(btn);
        btn.addEventListener('focus', () => {
          focusIdx = idx;
        });
      }
      menu.appendChild(btn);
    }

    doc.body?.appendChild?.(menu);
    let anchorX = anchorOrEvent?.clientX;
    let anchorY = anchorOrEvent?.clientY;
    if ((anchorX === undefined || anchorY === undefined) && typeof anchorOrEvent?.getBoundingClientRect === 'function') {
      const r = anchorOrEvent.getBoundingClientRect();
      anchorX = r.left;
      anchorY = r.bottom + 4;
    }
    const vw = typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : 800;
    const vh = typeof win.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : 600;
    const x = Math.max(6, Math.min(anchorX || 0, Math.max(6, vw - 196)));
    const y = Math.max(6, Math.min(anchorY || 0, Math.max(6, vh - 180)));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    activeMenuEl = menu;
    if (enabledBtns.length > 0) {
      focusIdx = 0;
      enabledBtns[0].focus?.();
    }

    const onDown = (ev) => {
      if (ev === anchorOrEvent) return;
      if (!menu.contains?.(ev.target)) ui.closeContextMenu(false);
    };
    const onKey = (ev) => {
      if (ev._agyMenuKeyHandled) return;
      const key = ev.key;
      if (key === 'Escape') {
        ev._agyMenuKeyHandled = true;
        ev.preventDefault?.();
        ev.stopPropagation?.();
        ui.closeContextMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) return;
      ev._agyMenuKeyHandled = true;
      if (enabledBtns.length === 0) return;
      const activeIdx = enabledBtns.indexOf(doc.activeElement);
      if (activeIdx !== -1) focusIdx = activeIdx;
      if (key === 'ArrowDown') {
        ev.preventDefault?.();
        focusIdx = focusIdx < 0 ? 0 : (focusIdx + 1) % enabledBtns.length;
        enabledBtns[focusIdx].focus?.();
      } else if (key === 'ArrowUp') {
        ev.preventDefault?.();
        focusIdx = focusIdx <= 0 ? enabledBtns.length - 1 : focusIdx - 1;
        enabledBtns[focusIdx].focus?.();
      } else if (key === 'Home') {
        ev.preventDefault?.();
        focusIdx = 0;
        enabledBtns[0].focus?.();
      } else if (key === 'End') {
        ev.preventDefault?.();
        focusIdx = enabledBtns.length - 1;
        enabledBtns[focusIdx].focus?.();
      } else if (key === 'Enter' || key === ' ') {
        const targetBtn = enabledBtns[focusIdx >= 0 ? focusIdx : 0];
        if (targetBtn && !targetBtn.disabled) {
          ev.preventDefault?.();
          targetBtn.click();
        }
      }
    };

    menu.addEventListener('keydown', onKey);
    doc.addEventListener?.('pointerdown', onDown, true);
    doc.addEventListener?.('keydown', onKey, true);
    cleanupMenu = () => {
      menu.removeEventListener('keydown', onKey);
      doc.removeEventListener?.('pointerdown', onDown, true);
      doc.removeEventListener?.('keydown', onKey, true);
    };
    return menu;
  };

  const TOAST_EXIT_MS = 300;

  // Antigravity announces toasts from a hidden region rather than the toast itself, so the close button inside
  // the toast isn't read out with the message. Clearing first lets the same message be announced twice in a row.
  function announceToast(text, assertive) {
    const id = assertive ? 'agy-toast-live-alert' : 'agy-toast-live-status';
    let region = doc.getElementById?.(id);
    if (!region) {
      region = doc.createElement('div');
      region.id = id;
      region.className = 'agy-toast-live';
      region.setAttribute?.('role', assertive ? 'alert' : 'status');
      region.setAttribute?.('aria-live', assertive ? 'assertive' : 'polite');
      region.setAttribute?.('aria-atomic', 'true');
      doc.body?.appendChild?.(region);
    }
    region.textContent = '';
    setTimeout(() => {
      region.textContent = text;
    }, 50);
    return region;
  }

  // Shows one toast at a time, like Antigravity's (2.29): a title, an optional description and a close button.
  // It stays for durationMs (Antigravity's default is 5s; 0 keeps it until closed), and the timer pauses while
  // the pointer or focus is on the toast. Escape closes it while it has focus.
  ui.showToast = function showToast(message, opts = {}) {
    const container = opts.container || doc.body;
    const existing = container?.querySelector?.('.agy-toast') || doc.querySelector?.('.agy-toast');
    existing?.remove?.();
    const isErr = Boolean(opts.error || opts.variant === 'error');
    const title = String(message ?? '');
    const description = opts.description == null ? '' : String(opts.description);

    const toast = doc.createElement('div');
    toast.className = `agy-toast${isErr ? ' error' : ''}`;
    const text = doc.createElement('div');
    text.className = 'agy-toast-text';
    const titleEl = doc.createElement('div');
    titleEl.className = 'agy-toast-title';
    titleEl.textContent = title;
    text.appendChild(titleEl);
    if (description) {
      const descEl = doc.createElement('div');
      descEl.className = 'agy-toast-description';
      descEl.textContent = description;
      text.appendChild(descEl);
    }
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'agy-toast-close';
    close.setAttribute?.('aria-label', 'Dismiss notification');
    close.innerHTML = ui.iconSvg ? ui.iconSvg('close', 16) : '×';
    toast.appendChild(text);
    toast.appendChild(close);

    let timer = null;
    let remaining = opts.durationMs ?? 5000;
    let startedAt = 0;
    const stopTimer = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
    const startTimer = () => {
      if (timer || remaining <= 0 || toast.hasAttribute?.('data-ending')) return;
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
    };
    function dismiss() {
      if (toast.hasAttribute?.('data-ending')) return;
      stopTimer();
      toast.setAttribute?.('data-ending', '');
      setTimeout(() => toast.remove?.(), TOAST_EXIT_MS);
    }
    close.addEventListener?.('click', dismiss);
    toast.addEventListener?.('keydown', (ev) => {
      if (ev.key === 'Escape') dismiss();
    });
    toast.addEventListener?.('pointerenter', stopTimer);
    toast.addEventListener?.('pointerleave', () => {
      if (!toast.contains?.(doc.activeElement)) startTimer();
    });
    toast.addEventListener?.('focusin', stopTimer);
    toast.addEventListener?.('focusout', (ev) => {
      if (!toast.contains?.(ev.relatedTarget)) startTimer();
    });

    container?.appendChild?.(toast);
    announceToast(description ? `${title}. ${description}` : title, isErr);
    startTimer();
    return toast;
  };

  let activeDownloadModalDismiss = null;
  let activeDownloadModalPrevFocus = null;
  let nextDownloadModalSeq = 1;

  ui.openDownloadModal = function openDownloadModal(opts = {}) {
    if (!opts || typeof opts !== 'object' || !opts.blob || !doc?.body) return null;
    const inheritedFocus = activeDownloadModalDismiss ? activeDownloadModalPrevFocus : null;
    ui.closeContextMenu?.(false);
    activeDownloadModalDismiss?.(false);

    const blob = opts.blob;
    const filename = String(opts.filename || 'download').trim() || 'download';
    const title = String(opts.title || `Download ${filename}`);
    const metaText = opts.metaText == null ? '' : String(opts.metaText);
    const mime = String(blob.type || '').toLowerCase().trim();
    const canCopyText = mime.startsWith('text/') || mime.startsWith('application/json');

    const UrlApi = win.URL || (typeof URL !== 'undefined' ? URL : null);
    let objectUrl = '';
    if (typeof UrlApi?.createObjectURL === 'function') {
      try {
        objectUrl = UrlApi.createObjectURL(blob);
      } catch {}
    }
    const prevFocus =
      inheritedFocus ||
      (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null);
    activeDownloadModalPrevFocus = prevFocus;

    const inertedSiblings = [];
    for (const child of Array.from(doc.body.children || [])) {
      if (child.classList?.contains?.('agy-toast-live')) continue;
      if (typeof child.hasAttribute === 'function' && !child.hasAttribute('inert')) {
        child.setAttribute?.('inert', '');
        inertedSiblings.push(child);
      }
    }

    const seq = nextDownloadModalSeq++;
    const titleId = `agy-download-modal-title-${seq}`;
    const descId = `agy-download-modal-desc-${seq}`;

    const backdrop = doc.createElement('div');
    backdrop.className = 'agy-modal-backdrop';

    const dialog = doc.createElement('div');
    dialog.className = 'agy-modal agy-download-modal';
    dialog.setAttribute?.('role', 'dialog');
    dialog.setAttribute?.('aria-modal', 'true');
    dialog.setAttribute?.('aria-labelledby', titleId);
    dialog.setAttribute?.('aria-describedby', descId);
    dialog.setAttribute?.('tabindex', '-1');

    const header = doc.createElement('div');
    header.className = 'agy-modal-header';
    const heading = doc.createElement('h2');
    heading.id = titleId;
    heading.className = 'agy-modal-title';
    heading.textContent = title;
    const headerCloseBtn = doc.createElement('button');
    headerCloseBtn.type = 'button';
    headerCloseBtn.className = 'agy-icon-btn agy-modal-close';
    headerCloseBtn.dataset.action = 'close';
    headerCloseBtn.setAttribute?.('aria-label', 'Close dialog');
    headerCloseBtn.innerHTML = ui.iconSvg ? ui.iconSvg('close', 16) : '\u00d7';
    header.appendChild(heading);
    header.appendChild(headerCloseBtn);

    const body = doc.createElement('div');
    body.className = 'agy-modal-body';
    const desc = doc.createElement('p');
    desc.id = descId;
    desc.className = 'agy-modal-desc';
    desc.textContent = metaText || `Save ${filename} directly or copy its contents.`;
    const fileChip = doc.createElement('div');
    fileChip.className = 'agy-modal-file';
    fileChip.textContent = filename;
    body.appendChild(desc);
    body.appendChild(fileChip);

    const actions = doc.createElement('div');
    actions.className = 'agy-modal-actions';

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'agy-btn agy-btn-secondary';
    closeBtn.dataset.action = 'close';
    closeBtn.textContent = 'Close';
    actions.appendChild(closeBtn);

    let copyBtn = null;
    let copyResetTimer = null;
    if (canCopyText) {
      copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'agy-btn agy-btn-secondary';
      copyBtn.dataset.action = 'copy';
      copyBtn.textContent = 'Copy text';
      actions.appendChild(copyBtn);
    }

    const downloadLink = doc.createElement('a');
    downloadLink.className = 'agy-btn agy-btn-primary agy-download-link';
    downloadLink.dataset.action = 'download';
    if (objectUrl) {
      downloadLink.setAttribute?.('href', objectUrl);
      downloadLink.href = objectUrl;
    }
    downloadLink.setAttribute?.('download', filename);
    downloadLink.download = filename;
    downloadLink.setAttribute?.('target', '_blank');
    downloadLink.setAttribute?.('rel', 'noopener');
    downloadLink.textContent = `Download ${filename}`;
    actions.appendChild(downloadLink);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);

    const focusables = [headerCloseBtn, closeBtn, ...(copyBtn ? [copyBtn] : []), downloadLink];
    let closed = false;

    function dismiss(restoreFocus = true) {
      if (closed) return;
      closed = true;
      if (activeDownloadModalDismiss === dismiss) {
        activeDownloadModalDismiss = null;
        activeDownloadModalPrevFocus = null;
      }
      if (copyResetTimer) {
        clearTimeout(copyResetTimer);
        copyResetTimer = null;
      }
      doc.removeEventListener?.('keydown', onKeyDown, true);
      backdrop.remove?.();
      for (const sibling of inertedSiblings) {
        sibling.removeAttribute?.('inert');
      }
      if (objectUrl) {
        try {
          UrlApi?.revokeObjectURL?.(objectUrl);
        } catch {}
      }
      if (restoreFocus && prevFocus && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
    }

    const onKeyDown = (ev) => {
      if (closed) return;
      if (ev.key === 'Escape') {
        ev.preventDefault?.();
        ev.stopPropagation?.();
        dismiss(true);
        return;
      }
      if (ev.key === 'Tab' && focusables.length > 0) {
        const idx = focusables.indexOf(doc.activeElement);
        if (ev.shiftKey && (idx <= 0 || !dialog.contains?.(doc.activeElement))) {
          ev.preventDefault?.();
          focusables[focusables.length - 1].focus?.();
        } else if (!ev.shiftKey && idx === focusables.length - 1) {
          ev.preventDefault?.();
          focusables[0].focus?.();
        }
      }
    };

    let pointerDownOnBackdrop = null;
    backdrop.addEventListener?.('pointerdown', (ev) => {
      pointerDownOnBackdrop = ev.target === backdrop;
    });
    backdrop.addEventListener?.('click', (ev) => {
      const shouldClose = ev.target === backdrop && pointerDownOnBackdrop !== false;
      pointerDownOnBackdrop = null;
      if (shouldClose) dismiss(true);
    });

    headerCloseBtn.addEventListener?.('click', () => dismiss(true));
    closeBtn.addEventListener?.('click', () => dismiss(true));

    if (copyBtn) {
      copyBtn.addEventListener?.('click', async () => {
        try {
          let text = '';
          if (typeof blob.text === 'function') {
            text = await blob.text();
          } else if (typeof Response === 'function') {
            text = await new Response(blob).text();
          }
          const clip =
            win.navigator?.clipboard ||
            (typeof navigator !== 'undefined' ? navigator.clipboard : null);
          if (typeof clip?.writeText === 'function') {
            await clip.writeText(text);
          } else if (typeof doc.execCommand === 'function') {
            const ta = doc.createElement('textarea');
            ta.value = text;
            ta.setAttribute?.('readonly', '');
            if (ta.style) {
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
            }
            doc.body?.appendChild?.(ta);
            ta.select?.();
            doc.execCommand('copy');
            ta.remove?.();
          }
          if (!closed) {
            copyBtn.textContent = 'Copied';
            if (copyResetTimer) clearTimeout(copyResetTimer);
            copyResetTimer = setTimeout(() => {
              copyResetTimer = null;
              if (!closed) copyBtn.textContent = 'Copy text';
            }, 1500);
            copyResetTimer?.unref?.();
          }
        } catch {}
      });
    }

    activeDownloadModalDismiss = dismiss;
    dialog.close = () => dismiss(true);
    doc.addEventListener?.('keydown', onKeyDown, true);
    doc.body.appendChild(backdrop);
    downloadLink.focus?.();
    return dialog;
  };
})(typeof window !== 'undefined' ? window : globalThis);
