(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});
  const ZERO_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const DEFAULT_TAB_SEL = '.agy-tab, [data-tab-id]';

  function isPinnedControl(el, pinnedRole = 'add-tab') {
    if (!el) return false;
    const role = el.dataset?.role;
    if (role === pinnedRole || role === 'add-tab' || role === 'agy-add-tab') return true;
    return Boolean(el.classList?.contains?.('agy-tab-add') || el.classList?.contains?.('agy-tab-add-btn'));
  }

  ui.setTabShift = function setTabShift(el, px) {
    if (!el) return;
    el._shiftX = px;
    el.style.transform = px ? `translateX(${px}px)` : '';
  };

  ui.getUnshiftedRect = function getUnshiftedRect(el) {
    const r = el.getBoundingClientRect();
    const s = el._shiftX || 0;
    return { left: r.left - s, right: r.right - s, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };

  ui.measureStrip = function measureStrip(
    stripEl, draggedEl, clientX = 0, clientY = 0, itemSelector = DEFAULT_TAB_SEL, pinnedRole = 'add-tab'
  ) {
    const sourceTabs = Array.from(stripEl?.querySelectorAll?.(itemSelector) || []).filter((el) => !isPinnedControl(el, pinnedRole));
    const centers = [];
    const rects = [];
    let minLeft = Infinity;
    let maxRight = -Infinity;
    let gap = 0;
    let prevRight = null;
    for (const el of sourceTabs) {
      const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : ZERO_RECT;
      rects.push(r);
      centers.push(r.left + r.width / 2);
      minLeft = Math.min(minLeft, r.left);
      maxRight = Math.max(maxRight, r.right);
      if (prevRight !== null && gap === 0) gap = Math.max(0, r.left - prevRight);
      prevRight = r.right;
    }
    const stripRect = typeof stripEl?.getBoundingClientRect === 'function' ? stripEl.getBoundingClientRect() : ZERO_RECT;
    const draggedIndex = sourceTabs.indexOf(draggedEl);
    const dRect = rects[draggedIndex] || (typeof draggedEl?.getBoundingClientRect === 'function' ? draggedEl.getBoundingClientRect() : ZERO_RECT);
    const draggedWidth = dRect.width;
    const draggedHeight = dRect.height;
    const grabOffsetX = clientX - dRect.left;
    const grabOffsetY = clientY - dRect.top;
    const minL = minLeft === Infinity ? stripRect.left : Math.max(minLeft, stripRect.left);
    const maxL = maxRight === -Infinity ? stripRect.left : Math.max(stripRect.left, Math.min(maxRight, stripRect.right) - draggedWidth);
    const step = draggedWidth + (gap || 1);

    return {
      stripEl, sourceStrip: stripEl, items: sourceTabs, sourceTabs, draggedEl, draggedIndex, fromIdx: draggedIndex,
      centers, rects, startScrollLeft: stripEl?.scrollLeft || 0, draggedWidth, draggedHeight,
      grabOffsetX, grabOffsetY, offX: grabOffsetX, offY: grabOffsetY, originalTop: dRect.top,
      minLeft: minL, maxLeft: maxL, step, draggedSlot: step, stripRect, locked: true, lockChangedAt: null,
    };
  };

  ui.bindTabDragController = function bindTabDragController(rootEl, opts = {}) {
    if (!rootEl) return null;
    const tabSel = opts.tabSelector || opts.itemSelector || DEFAULT_TAB_SEL;
    const idKey = opts.idDatasetKey || 'tabId';
    const pinnedRole = opts.pinnedRole || 'add-tab';
    let activePointerId = null, activeTabEl = null, activeStripEl = null;
    let startX = 0, startY = 0, isDragging = false, dragState = null, ghost = null, suppressClickUntil = 0;

    const onWinMove = (e) => handleMove(e);
    const onWinPointerEnd = (e) => endPointer(e, false);
    const onWinPointerCancel = (e) => endPointer(e, true);

    rootEl.addEventListener('click', (e) => {
      const hitTab = e.target?.closest?.(tabSel) || (rootEl.matches?.(tabSel) ? rootEl : null);
      if (Date.now() < suppressClickUntil || hitTab?._wasDragged) {
        if (hitTab) hitTab._wasDragged = false;
        suppressClickUntil = 0;
        e.stopImmediatePropagation?.();
        e.stopPropagation?.();
        e.preventDefault?.();
      }
    }, true);

    rootEl.addEventListener('pointerdown', (e) => {
      if ((e.button !== undefined && e.button !== 0) || (typeof opts.isBusy === 'function' && opts.isBusy())) return;
      const ignoreSel =
        '[data-role="close"], [data-role="tab-close"], [data-role="add-tab"], [data-role="agy-add-tab"], ' +
        '.agy-tab-close, .agy-tab-close-wrap, .agy-tab-pin, .agy-tab-add, .agy-tab-add-btn, input, .agy-rename-input' +
        (pinnedRole ? `, [data-role="${pinnedRole}"]` : '') +
        (opts.ignoreSelector ? `, ${opts.ignoreSelector}` : '');
      if (e.target?.closest?.(ignoreSel) || isPinnedControl(e.target, pinnedRole)) return;

      const rootIsTab = Boolean(
        rootEl.classList?.contains?.('agy-tab') || rootEl.dataset?.[idKey] !== undefined || rootEl.dataset?.tabId !== undefined || rootEl.matches?.(tabSel)
      );
      const tabEl = rootIsTab ? rootEl : e.target?.closest?.(tabSel);
      if (!tabEl || isPinnedControl(tabEl, pinnedRole) || (typeof opts.canDrag === 'function' && opts.canDrag(tabEl, e) === false)) return;

      activeTabEl = tabEl;
      activeStripEl = opts.stripEl || (rootIsTab ? tabEl.parentElement : rootEl);
      startX = e.clientX ?? 0;
      startY = e.clientY ?? 0;
      activePointerId = e.pointerId ?? 1;
      isDragging = false;
      dragState = ghost = null;
      try { tabEl.setPointerCapture?.(activePointerId); } catch {}
      win.addEventListener?.('pointermove', onWinMove, { capture: true });
      win.addEventListener?.('pointerup', onWinPointerEnd, { capture: true });
      win.addEventListener?.('pointercancel', onWinPointerCancel, { capture: true });
    });

    const handleMove = (e) => {
      if (e._agyDragMoved || activePointerId === null || !activeTabEl || !activeStripEl) return;
      if (e.pointerId !== undefined && e.pointerId !== activePointerId && e.buttons !== 1) return;
      e._agyDragMoved = true;

      const threshold = opts.thresholdPx ?? opts.dragThreshold ?? 4;
      if (!isDragging) {
        if (Math.hypot((e.clientX ?? 0) - startX, (e.clientY ?? 0) - startY) < threshold) return;
        isDragging = true;
        dragState = ui.measureStrip(activeStripEl, activeTabEl, startX, startY, tabSel, pinnedRole);
        activeTabEl.classList.add('agy-tab-dragging', 'is-dragging-source');
        activeTabEl.style.opacity = '0.35';
        doc.body?.classList?.add('dragging-tab');

        if (typeof opts.createGhost === 'function') {
          ghost = opts.createGhost(activeTabEl, dragState);
        } else {
          ghost = activeTabEl.cloneNode(true);
          ghost.className = 'agy-tab active agy-tab-drag-ghost';
          ghost.style.width = `${dragState.draggedWidth}px`;
          ghost.style.height = `${dragState.draggedHeight}px`;
          ghost.style.left = `${dragState.rects[dragState.fromIdx]?.left ?? dragState.minLeft}px`;
          ghost.style.top = `${dragState.originalTop}px`;
        }
        doc.body?.appendChild?.(ghost);
        dragState.ghost = ghost;
        opts.onDragStart?.(e, dragState);
      }

      if (!isDragging || !dragState || !ghost) return;
      const railDetachY = opts.railPadY ?? opts.railDetachY ?? 18;
      const sRect = typeof activeStripEl.getBoundingClientRect === 'function' ? activeStripEl.getBoundingClientRect() : dragState.stripRect;
      dragState.stripRect = sRect;

      const shouldDetach = typeof opts.shouldDetach === 'function' && opts.shouldDetach(e, dragState);
      const inRail = !shouldDetach && (e.clientY ?? 0) >= sRect.top - railDetachY && (e.clientY ?? 0) <= sRect.bottom + railDetachY;
      if (inRail !== dragState.locked) { dragState.locked = inRail; dragState.lockChangedAt = Date.now(); }

      if (inRail) {
        const transitionActive = dragState.lockChangedAt && Date.now() - dragState.lockChangedAt < 120;
        ghost.style.transition = transitionActive ? 'top 120ms ease-out, left 120ms ease-out' : '';
        const left = Math.min(Math.max((e.clientX ?? 0) - dragState.grabOffsetX, dragState.minLeft), dragState.maxLeft);
        ghost.style.left = `${left}px`;
        ghost.style.top = `${dragState.originalTop}px`;

        if ((activeStripEl.scrollWidth || 0) > (activeStripEl.clientWidth || 0)) {
          if (e.clientX < sRect.left + 26) activeStripEl.scrollLeft -= 8;
          else if (e.clientX > sRect.right - 26) activeStripEl.scrollLeft += 8;
        }

        const scrollDelta = (activeStripEl.scrollLeft || 0) - dragState.startScrollLeft;
        const x = left + dragState.draggedWidth / 2;
        const pinnedCount = dragState.sourceTabs.filter((t) => (opts.isItemPinned ? opts.isItemPinned(t) : t.dataset?.pinned === 'true')).length;
        const isPin = opts.isPinned ? opts.isPinned(activeTabEl) : activeTabEl.dataset?.pinned === 'true';

        let dropIdx = dragState.sourceTabs.length;
        for (let i = 0; i < dragState.centers.length; i++) {
          const factor = opts.getMergeSpanFactor ? opts.getMergeSpanFactor(dragState.sourceTabs[i], i, dragState) : 0.5;
          if (x < dragState.centers[i] - scrollDelta + dragState.draggedWidth * (factor - 0.5)) { dropIdx = i; break; }
        }

        const maxPinSlot = dragState.draggedIndex < dropIdx ? pinnedCount : Math.max(0, pinnedCount - 1);
        dropIdx = isPin ? Math.min(dropIdx, maxPinSlot) : Math.max(dropIdx, pinnedCount);
        dragState.dropIdx = dragState.targetIdx = dropIdx;

        dragState.sourceTabs.forEach((sib, i) => {
          if (i === dragState.draggedIndex) return;
          const shift =
            dragState.draggedIndex < dropIdx && i > dragState.draggedIndex && i < dropIdx
              ? -dragState.draggedSlot
              : dragState.draggedIndex > dropIdx && i >= dropIdx && i < dragState.draggedIndex
                ? dragState.draggedSlot
                : 0;
          ui.setTabShift(sib, shift);
        });
      } else {
        ghost.style.transition = '';
        ghost.style.left = `${(e.clientX ?? 0) - dragState.grabOffsetX}px`;
        ghost.style.top = `${(e.clientY ?? 0) - dragState.grabOffsetY}px`;
        dragState.sourceTabs.forEach((sib, i) => { if (i !== dragState.draggedIndex) ui.setTabShift(sib, 0); });
        opts.onOutOfRailMove?.(e, dragState);
      }
    };

    const endPointer = (e, cancelled = false) => {
      if ((activePointerId !== null && e?.pointerId !== undefined && e.pointerId !== activePointerId) || (activePointerId === null && !isDragging)) return;
      win.removeEventListener?.('pointermove', onWinMove, { capture: true });
      win.removeEventListener?.('pointerup', onWinPointerEnd, { capture: true });
      win.removeEventListener?.('pointercancel', onWinPointerCancel, { capture: true });

      const wasDragging = isDragging;
      const finishedState = dragState;
      const tabEl = activeTabEl;
      try { if (activePointerId !== null && tabEl?.hasPointerCapture?.(activePointerId)) tabEl.releasePointerCapture(activePointerId); } catch {}
      activePointerId = activeTabEl = activeStripEl = dragState = null;
      isDragging = false;

      if (finishedState) finishedState.sourceTabs.forEach((t) => ui.setTabShift(t, 0));
      if (ghost) { ghost.remove?.(); ghost = null; }
      if (tabEl) { tabEl.classList.remove('agy-tab-dragging', 'is-dragging-source'); tabEl.style.opacity = ''; }
      doc.body?.classList?.remove('dragging-tab');
      opts.onClearPreview?.();

      if (wasDragging) {
        if (tabEl) tabEl._wasDragged = true;
        suppressClickUntil = Date.now() + 80;
        opts.onDrop?.(e, finishedState, cancelled);
        if (!cancelled && finishedState?.locked && typeof opts.onReorder === 'function') {
          const ids = typeof opts.getReorderIds === 'function'
            ? [...opts.getReorderIds()]
            : finishedState.sourceTabs.map((t) => t.dataset?.[idKey] ?? t.dataset?.tabId ?? t._item?.id).filter((v) => v !== undefined);
          const fromIdx = finishedState.fromIdx;
          const dropIdx = finishedState.dropIdx ?? fromIdx;
          const toIdx = Math.max(0, Math.min(ids.length - 1, dropIdx > fromIdx ? dropIdx - 1 : dropIdx));
          if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx && ids.length > 1) {
            const [moved] = ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, moved);
            opts.onReorder(ids, finishedState, e);
          }
        }
      } else if (!cancelled) {
        opts.onClick?.(e);
        if (typeof opts.onActivate === 'function' && tabEl) {
          opts.onActivate(tabEl.dataset?.[idKey] ?? tabEl.dataset?.tabId ?? tabEl._item?.id, tabEl, e);
        }
      }
    };

    rootEl.addEventListener('pointermove', handleMove);
    rootEl.addEventListener('pointerup', (e) => endPointer(e, false));
    rootEl.addEventListener('pointercancel', (e) => endPointer(e, true));
    rootEl.addEventListener('lostpointercapture', (e) => endPointer(e, true));
  };
})(typeof window !== 'undefined' ? window : globalThis);
