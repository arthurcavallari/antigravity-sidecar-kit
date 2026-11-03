import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  AGY_UI_CSS,
  AGY_UI_JS,
  ALL_AGY_UI_MODULES,
  attachAgyUI,
  buildAgyUiCss,
  buildAgyUiJs,
  resolveAgyUiModules,
} from '../lib/ui.mjs';
import {
  createShellClientHandler,
  createUiCssHandler,
  createUiJsHandler,
  createShellCssHandler,
  registerUiRoutes,
} from '../lib/server.mjs';

function makeDomNode(tag = 'div', rect = { left: 0, right: 80, top: 0, bottom: 28, width: 80, height: 28 }) {
  const classes = new Set();
  const listeners = {};
  const childNodes = [];
  let html = '';
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    value: '',
    title: '',
    textContent: '',
    scrollLeft: 0,
    scrollWidth: 200,
    clientWidth: 200,
    offsetWidth: rect.width,
    offsetHeight: rect.height,
    childNodes,
    get children() {
      return childNodes;
    },
    get firstElementChild() {
      return childNodes[0] || makeDomNode('svg');
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(v) {
      html = String(v);
      if (v === '') childNodes.length = 0;
    },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : Boolean(on);
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c) || node.className.split(/\s+/).includes(c),
    },
    getBoundingClientRect: () => rect,
    cloneNode: () => makeDomNode(tag, rect),
    appendChild(ch) {
      const idx = childNodes.indexOf(ch);
      if (idx !== -1) childNodes.splice(idx, 1);
      ch.parentElement = node;
      childNodes.push(ch);
      return ch;
    },
    append(...items) {
      for (const it of items) node.appendChild(it);
    },
    insertBefore(newNode, refNode) {
      const existingIdx = childNodes.indexOf(newNode);
      if (existingIdx !== -1) childNodes.splice(existingIdx, 1);
      newNode.parentElement = node;
      if (!refNode) {
        childNodes.push(newNode);
        return newNode;
      }
      const refIdx = childNodes.indexOf(refNode);
      if (refIdx === -1) childNodes.push(newNode);
      else childNodes.splice(refIdx, 0, newNode);
      return newNode;
    },
    replaceWith(replacement) {
      if (node.parentElement) {
        const list = node.parentElement.childNodes;
        const idx = list.indexOf(node);
        if (idx !== -1) {
          list[idx] = replacement;
          if (replacement) replacement.parentElement = node.parentElement;
        }
      }
      node._replacedBy = replacement;
    },
    remove() {
      if (node.parentElement) {
        const list = node.parentElement.childNodes;
        const idx = list.indexOf(node);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    focus() {
      node._focused = true;
    },
    select() {
      node._selected = true;
    },
    setPointerCapture(id) {
      node._capturedPointer = id;
    },
    querySelector(sel) {
      if (sel.includes('tab-label')) {
        return childNodes.find((c) => c.dataset?.role === 'tab-label') || null;
      }
      return childNodes[0] || null;
    },
    querySelectorAll(sel) {
      if (sel === '.agy-tab') {
        return childNodes.filter((c) => (c.className || '').split(/\s+/).includes('agy-tab'));
      }
      return [...childNodes];
    },
    addEventListener(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    emit(ev, payload = {}) {
      for (const fn of listeners[ev] || []) fn(payload);
    },
  };
  return node;
}

describe('antigravity-sidecar-kit/ui (AgyUI modular component library)', () => {
  it('keeps /shell.css and /shell.js strictly baseline and serves modular AgyUI routes', () => {
    const shellCss = createShellCssHandler()().body;
    const clientJs = createShellClientHandler()().body;
    assert.equal(shellCss.includes('.agy-tab-strip'), false, '/shell.css must not bundle component CSS');
    assert.equal(clientJs.includes('reconcileTabStrip'), false, '/shell.js must not bundle component JS');

    const subsetMods = resolveAgyUiModules(['controls', 'surfaces']);
    assert.deepEqual(subsetMods, ['core', 'controls', 'surfaces']);

    const subsetCss = buildAgyUiCss(['controls', 'surfaces']);
    assert.ok(subsetCss.includes('.agy-btn'));
    assert.ok(subsetCss.includes('.agy-card'));
    assert.equal(subsetCss.includes('.agy-tab-strip'), false);

    const win = {};
    const doc = { createElement: (t) => makeDomNode(t), body: makeDomNode('body') };
    const ctx = vm.createContext({ window: win, document: doc, setTimeout, clearTimeout });
    vm.runInContext(buildAgyUiJs(['controls', 'surfaces']), ctx);
    assert.ok(win.AgyUI);
    assert.equal(typeof win.AgyUI.escHtml, 'function');
    assert.equal(typeof win.AgyUI.renderSwitch, 'function');
    assert.equal(typeof win.AgyUI.renderCountPill, 'function');
    assert.equal(win.AgyUI.reconcileTabStrip, undefined, 'tabs module was not subscribed');

    const pages = new Map();
    registerUiRoutes({ page: (p, fn) => pages.set(p, fn) }, { modules: ['tabs', 'controls'] });
    assert.equal(pages.has('/ui.css'), true);
    assert.equal(pages.has('/ui.js'), true);
    for (const m of ALL_AGY_UI_MODULES) {
      assert.equal(pages.has(`/ui/${m}.css`), true);
      assert.equal(pages.has(`/ui/${m}.js`), true);
    }
    const routeCss = pages.get('/ui.css')().body;
    assert.ok(routeCss.includes('.agy-tab-strip'));
    assert.ok(routeCss.includes('.agy-btn'));
    assert.equal(routeCss.includes('.agy-context-menu'), false);

    assert.ok(AGY_UI_CSS.includes('.agy-context-menu'));
    assert.ok(AGY_UI_JS.includes('openContextMenu'));
    assert.ok(createUiCssHandler()().body.includes('.agy-tab'));
    assert.ok(createUiJsHandler()().body.includes('reconcileTabStrip'));
  });

  it('reconciles tab strips in-place, preserves active inline rename inputs, and handles drag + split + menus', () => {
    const win = { innerWidth: 800, innerHeight: 600 };
    const doc = {
      createElement: (t) => makeDomNode(t),
      body: makeDomNode('body'),
      addEventListener() {},
      removeEventListener() {},
    };
    const ui = attachAgyUI({ window: win, document: doc });

    assert.ok(ui.iconSvg('terminal', 16).includes('viewBox="0 0 24 24"'));
    assert.ok(ui.iconSvg('globe', 15).includes('viewBox="0 -960 960 960"'));
    assert.deepEqual(ui.formatStatusBadge('RUNNING', true, false), { label: 'Running', state: 'running' });
    assert.equal(ui.formatBadgeLabel('READY'), 'Ready');
    assert.equal(ui.formatBadgeLabel('PID 999'), 'PID 999');

    const stripEl = makeDomNode('nav', { left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30 });
    const selectedIds = [];
    const renamed = [];
    let addClicked = 0;

    const opts = {
      idDatasetKey: 'sidecarId',
      addButton: {
        title: 'New Tab',
        testId: 'hangar-new-tab-button',
        onClick: () => addClicked++,
      },
      onSelect: (id) => selectedIds.push(id),
      onRename: (id, nextTitle) => renamed.push([id, nextTitle]),
    };

    ui.reconcileTabStrip(
      stripEl,
      [
        { id: 't1', label: 'Term 1', icon: 'terminal', active: true, renamable: true, closable: true },
        { id: 't2', label: 'Term 2', icon: 'terminal', active: false, renamable: true, closable: true, externalBadge: true },
      ],
      opts
    );

    assert.equal(stripEl.childNodes.length, 3);
    const [pill1, pill2, addBtn] = stripEl.childNodes;
    assert.equal(pill1.className, 'agy-tab active');
    assert.equal(pill2.className, 'agy-tab');
    assert.ok(pill2.innerHTML.includes('agy-tab-ext-badge'));
    assert.equal(addBtn.dataset.testid, 'hangar-new-tab-button');
    addBtn.emit('click', {});
    assert.equal(addClicked, 1);

    // Start inline rename on pill1 and verify a re-reconcile preserves pill1's rename state
    pill1.emit('dblclick', { stopPropagation() {} });
    assert.equal(pill1._isRenaming, true);
    const renameInput = pill1._slots.labelEl._replacedBy;
    assert.ok(renameInput);
    assert.equal(renameInput.className, 'agy-rename-input');

    // Reconcile while pill1 is mid-rename: pill1 instance is preserved and not clobbered
    ui.reconcileTabStrip(
      stripEl,
      [
        { id: 't1', label: 'Background Poll Label', icon: 'terminal', active: true, renamable: true },
        { id: 't2', label: 'Term 2 Updated', icon: 'terminal', active: false, renamable: true },
      ],
      opts
    );
    assert.equal(stripEl.childNodes[0], pill1, 'keyed reconciliation keeps the exact DOM element');
    assert.equal(pill1._isRenaming, true);

    renameInput.value = 'Custom Server';
    renameInput.emit('keydown', { key: 'Enter', stopPropagation() {} });
    assert.equal(pill1._isRenaming, false);
    assert.deepEqual(renamed, [['t1', 'Custom Server']]);

    // Test pointer-capture drag controller
    const pA = makeDomNode('button', { left: 0, right: 60, top: 4, bottom: 26, width: 60, height: 22 });
    pA.className = 'agy-tab';
    const pB = makeDomNode('button', { left: 64, right: 124, top: 4, bottom: 26, width: 60, height: 22 });
    pB.className = 'agy-tab';
    const dragStrip = makeDomNode('div', { left: 0, right: 200, top: 0, bottom: 30, width: 200, height: 30 });
    dragStrip.append(pA, pB);

    let dropMeta = null;
    ui.bindTabDragController(pA, {
      stripEl: dragStrip,
      itemSelector: '.agy-tab',
      isPinned: () => false,
      isItemPinned: () => false,
      onDrop: (_e, finished) => {
        dropMeta = finished;
      },
    });
    pA.emit('pointerdown', { button: 0, pointerId: 1, clientX: 15, clientY: 15 });
    pA.emit('pointermove', { buttons: 1, pointerId: 1, clientX: 105, clientY: 15 });
    assert.equal(pA.classList.contains('is-dragging-source'), true);
    assert.equal(pB.style.transform, 'translateX(-64px)');
    pA.emit('pointerup', { pointerId: 1, clientX: 105, clientY: 15 });
    assert.equal(pA.classList.contains('is-dragging-source'), false);
    assert.equal(dropMeta.dropIdx, 2);

    // Test split pane sash controller
    const sash = makeDomNode('div');
    const container = makeDomNode('div', { left: 0, right: 400, top: 0, bottom: 400, width: 400, height: 400 });
    const ratios = [];
    ui.bindSplitResize(sash, {
      direction: 'horizontal',
      containerEl: container,
      minRatio: 0.2,
      maxRatio: 0.8,
      onResize: (r) => ratios.push(r),
    });
    sash.emit('pointerdown', { button: 0, pointerId: 2 });
    sash.emit('pointermove', { clientX: 100, clientY: 50 });
    sash.emit('pointermove', { clientX: 390, clientY: 50 });
    sash.emit('pointerup', {});
    assert.deepEqual(ratios, [0.25, 0.8]);

    // Test context menu and toast
    let actionFired = false;
    const menu = ui.openContextMenu({ clientX: 20, clientY: 30 }, [
      { id: 'pin', label: 'Pin Tab', onClick: () => (actionFired = true) },
      { separator: true },
      { id: 'close', label: 'Close', danger: true },
    ]);
    assert.equal(menu.className, 'agy-context-menu');
    assert.equal(menu.childNodes[0].className, 'agy-context-menu-item');
    assert.equal(menu.childNodes[1].className, 'agy-context-menu-sep');
    menu.childNodes[0].emit('click', { stopPropagation() {} });
    assert.equal(actionFired, true);

    const toast = ui.showToast('Saved layout', { durationMs: 0 });
    assert.equal(toast.className, 'agy-toast');
    assert.equal(toast.textContent, 'Saved layout');
  });

  it('Step 0 parity: startInlineRename restoration, reconcileTabStrip emptyHint, measureStrip contract, and bindTabDragController lifecycle', () => {
    const sandbox = {
      window: {
        addEventListener() {},
        removeEventListener() {},
      },
      document: {
        body: makeDomNode('body'),
        createElement: (tag) => makeDomNode(tag),
        querySelectorAll: () => [],
      },
      performance: { now: () => Date.now() },
      setTimeout: (fn) => fn(),
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    const code = buildAgyUiJs('all');
    vm.runInContext(code, sandbox);
    const ui = sandbox.window.AgyUI;

    // 1. startInlineRename label restoration
    const pill = makeDomNode('button');
    const label = makeDomNode('span');
    label.className = 'agy-tab-label';
    label.textContent = 'Old Label';
    pill.appendChild(label);

    let committedVal = null;
    const inp = ui.startInlineRename(pill, label, {
      onCommit: (val) => { committedVal = val; },
    });
    assert.ok(inp, 'input created');
    assert.equal(pill.childNodes[0], inp, 'input replaced label in DOM');
    assert.equal(pill._isRenaming, true);

    inp.value = 'New Label';
    inp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    assert.equal(committedVal, 'New Label');
    assert.equal(pill._isRenaming, false);
    assert.equal(pill.childNodes[0], label, 'label restored to pill DOM upon finish');

    // 2. reconcileTabStrip emptyHint
    const strip = makeDomNode('div');
    ui.reconcileTabStrip(strip, [], { emptyHint: 'Drop a terminal tab here' });
    const hint = strip.childNodes.find((c) => c.className.includes('agy-tab-drop-hint'));
    assert.ok(hint, 'emptyHint rendered');
    assert.equal(hint.textContent, 'Drop a terminal tab here');

    // Non-empty items removes hint
    ui.reconcileTabStrip(strip, [{ id: 'term-1', label: 'Terminal 1' }], { emptyHint: 'Drop a terminal tab here' });
    const hintAfter = strip.childNodes.find((c) => c.className.includes('agy-tab-drop-hint'));
    assert.equal(hintAfter, undefined, 'emptyHint removed when items present');

    // 3. measureStrip return contract (no ghost appended to body)
    const bodyChildrenBefore = sandbox.document.body.childNodes.length;
    const stripEl = makeDomNode('div', { left: 0, right: 300, top: 0, bottom: 30, width: 300, height: 30 });
    const tab1 = makeDomNode('button', { left: 0, right: 80, top: 4, bottom: 26, width: 80, height: 22 });
    tab1.className = 'agy-tab';
    const tab2 = makeDomNode('button', { left: 84, right: 164, top: 4, bottom: 26, width: 80, height: 22 });
    tab2.className = 'agy-tab';
    stripEl.append(tab1, tab2);

    const m = ui.measureStrip(stripEl, tab1, 20, 15, '.agy-tab');
    assert.equal(sandbox.document.body.childNodes.length, bodyChildrenBefore, 'measureStrip must NOT append ghost to document.body');
    assert.equal(m.draggedIndex, 0);
    assert.equal(m.fromIdx, 0);
    assert.equal(m.draggedWidth, 80);
    assert.equal(m.draggedHeight, 22);
    assert.equal(m.grabOffsetX, 20);
    assert.equal(m.grabOffsetY, 11);
    assert.equal(m.offX, 20);
    assert.equal(m.offY, 11);
    assert.equal(m.step, 84);
    assert.equal(m.draggedSlot, 84);
    assert.equal(m.locked, true);
    assert.equal(m.lockChangedAt, null);
    assert.deepEqual(m.rects.length, 2);
    assert.deepEqual(m.centers.length, 2);

    // 4. bindTabDragController full pointermove/reorder/out-of-rail/drop lifecycle
    let droppedState = null;
    let outOfRailCount = 0;
    ui.bindTabDragController(tab1, {
      stripEl,
      itemSelector: '.agy-tab',
      onOutOfRailMove: () => { outOfRailCount++; },
      onDrop: (_e, state) => { droppedState = state; },
    });

    // pointerdown
    tab1.emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 15 });
    // move in-rail past threshold to reorder
    tab1.emit('pointermove', { buttons: 1, pointerId: 1, clientX: 130, clientY: 15 });
    assert.ok(tab1.classList.contains('agy-tab-dragging'));
    assert.equal(tab1.style.opacity, '0.35');
    assert.equal(tab2.style.transform, 'translateX(-84px)');

    // move out-of-rail: sibling shift resets and onOutOfRailMove fires
    tab1.emit('pointermove', { buttons: 1, pointerId: 1, clientX: 130, clientY: 150 });
    assert.equal(outOfRailCount > 0, true, 'onOutOfRailMove fired');
    assert.equal(tab2.style.transform, '', 'sibling shifts reset out-of-rail');

    // drop finishes cleanly
    tab1.emit('pointerup', { pointerId: 1, clientX: 130, clientY: 150 });
    assert.ok(droppedState, 'onDrop called');
    assert.equal(tab1.classList.contains('agy-tab-dragging'), false);
    assert.equal(tab1.style.opacity, '');
  });

  it('enforces Antigravity 2.0 native CSS spec, overflow badge/restore pills, and context menu icon alignment', () => {
    for (const rule of [
      '.agy-tab-overflow-badge',
      '.agy-tab-overflow-restore',
      '.agy-tab-overflow-item-left',
      '.agy-tab-overflow-item-title',
      '.agy-context-menu-check',
      '.agy-badge.is-Connected',
      '.agy-badge.is-Reconnecting',
      '.agy-badge.is-Disconnected',
      '.agy-badge.off',
      '.agy-empty',
      'padding: 4px 0; overflow-x: auto;',
      'height: 22px; padding: 0 8px; gap: 4px;',
      'height: 24px; padding: 0 8px; gap: 4px; border-radius: var(--radius-md, 0.375rem);',
      'height: 7px; opacity: 0.5;',
      'border-color: rgba(243, 201, 73, 0.3);',
      '.agy-switch.disabled { opacity: 0.4; cursor: not-allowed; }',
    ]) {
      assert.ok(AGY_UI_CSS.includes(rule), `AGY_UI_CSS must include ${rule}`);
    }

    const win = { innerWidth: 800, innerHeight: 600 };
    const doc = {
      createElement: (t) => makeDomNode(t),
      body: makeDomNode('body'),
      addEventListener() {},
      removeEventListener() {},
    };
    const ui = attachAgyUI({ window: win, document: doc });

    // Context menu: left-aligned icon, label, right-aligned check, data-menu-id + data-menu-action
    const menu = ui.openContextMenu({ clientX: 16, clientY: 24 }, [
      { id: 'new-terminal', icon: 'terminal', label: 'New Terminal', checked: true },
    ]);
    const itemBtn = menu.childNodes[0];
    assert.equal(itemBtn.dataset.menuId, 'new-terminal');
    assert.equal(itemBtn.dataset.menuAction, 'new-terminal');
    assert.ok(itemBtn.innerHTML.includes('<span class="agy-tab-icon"><svg'));
    assert.ok(itemBtn.innerHTML.includes('<span class="agy-context-menu-label">New Terminal</span>'));
    assert.ok(itemBtn.innerHTML.includes('agy-context-menu-check'));

    // setupStripScroll: idempotent binding, overflow badge, and restore pill rendering
    const stripEl = makeDomNode('div');
    stripEl.scrollWidth = 100;
    stripEl.clientWidth = 200;
    const overflowBtn = makeDomNode('button');
    overflowBtn.querySelector = (sel) =>
      sel === '.agy-tab-overflow-badge'
        ? overflowBtn.childNodes.find((c) => c.className === 'agy-tab-overflow-badge') || null
        : null;
    const popoverEl = makeDomNode('div');
    let reopenedId = null;

    ui.setupStripScroll(
      stripEl,
      overflowBtn,
      () => [{ id: 't1', label: 'Tab 1', icon: 'folder', status: 'running', pinned: true }],
      () => {},
      popoverEl,
      () => [{ id: 'closed-1', displayName: 'Hidden Sidecar', scope: 'global' }],
      (id) => { reopenedId = id; }
    );
    // Re-invoking setupStripScroll updates callbacks without double-binding
    ui.setupStripScroll(
      stripEl,
      overflowBtn,
      () => [{ id: 't1', label: 'Tab 1', icon: 'folder', status: 'running', pinned: true }],
      () => {},
      popoverEl,
      () => [{ id: 'closed-1', displayName: 'Hidden Sidecar', scope: 'global' }],
      (id) => { reopenedId = id; }
    );
    assert.equal(stripEl._scrollBound, true);
    assert.equal(overflowBtn.classList.contains('hidden'), false);
    assert.equal(overflowBtn.classList.contains('has-hidden-tabs'), true);
    const badge = overflowBtn.querySelector('.agy-tab-overflow-badge');
    assert.ok(badge);
    assert.equal(badge.textContent, '1');

    stripEl.scrollWidth = 320;
    stripEl._updateScroll();
    assert.equal(stripEl.classList.contains('mask-right'), true);

    overflowBtn.emit('click', { stopPropagation() {} });
    const [openHdr, openItem, hiddenHdr, closedItem] = popoverEl.childNodes;
    assert.equal(openHdr.textContent, 'Open Tabs');
    assert.equal(openItem.className, 'agy-tab-overflow-item');
    assert.equal(openItem.childNodes[0].className, 'agy-tab-overflow-item-left');
    assert.equal(openItem.childNodes[1].className, 'agy-status-dot running');
    assert.equal(openItem.childNodes[2].className, 'agy-tab-pin');
    assert.equal(hiddenHdr.textContent, 'Hidden Tabs (1)');
    assert.equal(closedItem.className, 'agy-tab-overflow-item is-hidden-tab');
    assert.equal(closedItem.childNodes[1].className, 'agy-tab-overflow-restore');
    assert.equal(closedItem.childNodes[1].textContent, 'Show');
    closedItem.emit('click', {});
    assert.equal(reopenedId, 'closed-1');
  });

  it('exposes createVisibilityPoller in AGY_CLIENT_JS combining sidecar-visibility message, IntersectionObserver, and document.hidden', async () => {
    const clientJs = createShellClientHandler()().body;
    assert.ok(clientJs.includes('createVisibilityPoller'));

    const winListeners = {};
    const docListeners = {};
    let ioCallback = null;
    let observedTarget = null;

    const doc = {
      hidden: false,
      documentElement: makeDomNode('html'),
      addEventListener(ev, fn) {
        (docListeners[ev] = docListeners[ev] || []).push(fn);
      },
    };
    const win = {
      parent: null,
      addEventListener(ev, fn) {
        (winListeners[ev] = winListeners[ev] || []).push(fn);
      },
    };
    win.parent = win;

    class MockIntersectionObserver {
      constructor(cb) {
        ioCallback = cb;
      }
      observe(target) {
        observedTarget = target;
      }
    }

    const timers = new Map();
    let nextTimerId = 1;
    const ctx = vm.createContext({
      window: win,
      document: doc,
      IntersectionObserver: MockIntersectionObserver,
      setTimeout(fn, ms) {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    });
    vm.runInContext(clientJs, ctx);

    assert.equal(typeof win.AgyShell?.createVisibilityPoller, 'function');
    let pollCount = 0;
    const poller = win.AgyShell.createVisibilityPoller({
      onPoll: () => {
        pollCount++;
      },
      intervalMs: 2500,
    });

    assert.equal(observedTarget, doc.documentElement);
    assert.equal(poller.isVisible(), true);

    poller.start();
    assert.equal(pollCount, 1, 'starts immediate poll when visible');
    assert.equal(timers.size, 1);

    // Hide via postMessage('sidecar-visibility')
    for (const fn of winListeners.message || []) {
      fn({ source: win.parent, data: { type: 'sidecar-visibility', payload: { visible: false } } });
    }
    assert.equal(poller.isVisible(), false);
    assert.equal(timers.size, 0, 'timer cleared when hidden by host');

    // Restore via postMessage('sidecar-visibility')
    for (const fn of winListeners.message || []) {
      fn({ source: win.parent, data: { type: 'sidecar-visibility', payload: { visible: true } } });
    }
    assert.equal(poller.isVisible(), true);
    assert.equal(pollCount, 2, 'polls immediately on becoming visible');

    // Hide via IntersectionObserver
    ioCallback([{ isIntersecting: false }]);
    assert.equal(poller.isVisible(), false);
    assert.equal(timers.size, 0);

    // Restore via IntersectionObserver
    ioCallback([{ isIntersecting: true }]);
    assert.equal(poller.isVisible(), true);
    assert.equal(pollCount, 3);

    // Hide via document.hidden + visibilitychange
    doc.hidden = true;
    for (const fn of docListeners.visibilitychange || []) fn();
    assert.equal(poller.isVisible(), false);
    assert.equal(timers.size, 0);

    // Restore via document.hidden + visibilitychange
    doc.hidden = false;
    for (const fn of docListeners.visibilitychange || []) fn();
    assert.equal(poller.isVisible(), true);
    assert.equal(pollCount, 4);

    // triggerNow and stop
    poller.triggerNow();
    assert.equal(pollCount, 5);

    // Single-flight async guard: overlapping triggerNow calls must not run onPoll concurrently (F-04)
    let resolveAsyncPoll = null;
    let asyncPollCalls = 0;
    const asyncPoller = win.AgyShell.createVisibilityPoller({
      onPoll: () => {
        asyncPollCalls++;
        return new Promise((r) => {
          resolveAsyncPoll = r;
        });
      },
      intervalMs: 2500,
    });
    asyncPoller.start();
    assert.equal(asyncPollCalls, 1);
    asyncPoller.triggerNow();
    assert.equal(asyncPollCalls, 1, 'must not overlap in-flight async poll');
    resolveAsyncPoll();
    asyncPoller.stop();

    poller.stop();
    assert.equal(timers.size, 0);

    // ASK-02 & hiddenPollMs: verify notifyAgent and AgyUI.apiCall attach X-Sidecar-Token in direct webPort iframe mode
    const capturedRequests = [];
    const iframeWin = {
      location: { href: 'http://127.0.0.1:52000/?token=direct-tok-777&conversationId=conv-9', search: '?token=direct-tok-777&conversationId=conv-9' },
      fetch: async (url, init) => {
        capturedRequests.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const iframeDoc = {
      hidden: false,
      readyState: 'complete',
      documentElement: makeDomNode('html'),
      createElement: (t) => makeDomNode(t),
      body: makeDomNode('body'),
      addEventListener() {},
      removeEventListener() {},
    };
    iframeWin.document = iframeDoc;
    vm.runInNewContext(clientJs, { window: iframeWin, document: iframeDoc, fetch: iframeWin.fetch, URLSearchParams, URL, setTimeout, clearTimeout });
    await iframeWin.AgyShell.notifyAgent('hello from direct iframe');
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].init.headers['X-Sidecar-Token'], 'direct-tok-777');

    const iframeUi = attachAgyUI({ window: iframeWin, document: iframeDoc });
    await iframeUi.apiCall('/api/mutate', { a: 1 });
    assert.equal(capturedRequests.length, 2);
    assert.equal(capturedRequests[1].init.headers['X-Sidecar-Token'], 'direct-tok-777');

    // Verify hiddenPollMs schedules slow background polling when hidden
    let hiddenTicks = 0;
    const bgPoller = win.AgyShell.createVisibilityPoller({
      onPoll: () => { hiddenTicks++; },
      intervalMs: 1000,
      hiddenPollMs: 10000,
    });
    doc.hidden = true;
    bgPoller.start();
    assert.equal(timers.size, 1, 'hiddenPollMs schedules timer even when hidden');
    const scheduledDelay = [...timers.values()][0].ms;
    assert.equal(scheduledDelay, 10000);
    bgPoller.stop();
  });
});

