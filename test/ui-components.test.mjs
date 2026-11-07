import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { attachAgyUI } from '../lib/ui.mjs';

function createDomEnv() {
  const { window: win, document: doc } = parseHTML('<!DOCTYPE html><html><body></body></html>');
  win.innerWidth = 800;
  win.innerHeight = 600;
  const ui = attachAgyUI(win);
  return { win, doc, ui };
}

function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: rect.width ?? 0, bottom: rect.height ?? 0, width: 0, height: 0, ...rect });
}

describe('antigravity-sidecar-kit/ui components and Light-DOM Custom Elements (linkedom)', () => {
  it('reconciles tab strips in-place, handles real DOM inline rename, custom iconElement, and overflow popovers', () => {
    const { win, doc, ui } = createDomEnv();
    const stripEl = doc.createElement('nav');
    doc.body.appendChild(stripEl);

    const selected = [];
    const renamed = [];
    let addClicks = 0;

    ui.reconcileTabStrip(stripEl, [], { emptyHint: 'Drop a tab here' });
    assert.equal(stripEl.querySelector('.agy-tab-drop-hint')?.textContent, 'Drop a tab here');

    const opts = {
      addButton: { title: 'New Tab', testId: 'add-tab-btn', onClick: () => addClicks++ },
      onSelect: (id) => selected.push(id),
      onRename: (id, nextTitle) => renamed.push([id, nextTitle]),
    };

    ui.reconcileTabStrip(
      stripEl,
      [
        { id: 't1', label: 'Term 1', icon: 'terminal', active: true, renamable: true, closable: true },
        { id: 't2', label: 'Term 2', icon: 'folder', active: false, renamable: true, closable: true, externalBadge: true },
      ],
      opts
    );

    assert.equal(stripEl.querySelector('.agy-tab-drop-hint'), null);
    const [pill1, pill2] = stripEl.querySelectorAll('.agy-tab');
    assert.equal(pill1.dataset.tabId, 't1');
    assert.equal(pill1.querySelector('.agy-tab-close')?.getAttribute('tabindex'), '0');
    assert.equal(pill1.querySelector('.agy-tab-pin')?.getAttribute('tabindex'), '-1');
    assert.equal(pill2.querySelector('.agy-tab-ext-badge')?.title, 'Opened externally');

    // Custom iconElement replacement and icon: null removal without clobbering _opts
    const customImg = doc.createElement('img');
    ui.updateTabPill(pill2, { id: 't2', label: 'Term 2', iconElement: customImg });
    assert.equal(pill2.querySelector('.agy-tab-icon-slot')?.firstChild, customImg);
    ui.updateTabPill(pill2, { id: 't2', label: 'Term 2', icon: null });
    assert.equal(pill2.querySelector('.agy-tab-icon-slot'), null);
    pill2.click();
    assert.deepEqual(selected, ['t2']);

    const addBtn = stripEl.querySelector('[data-testid="add-tab-btn"]');
    assert.equal(addBtn.dataset.role, 'agy-add-tab');
    addBtn.click();
    assert.equal(addClicks, 1);

    // Real DOM inline rename without _replacedBy mock properties
    assert.equal(pill1.querySelector('.agy-tab-close-wrap')?.classList.contains('hidden'), false);
    pill1.dispatchEvent(new win.Event('dblclick', { bubbles: true }));
    assert.equal(pill1._isRenaming, true);
    assert.equal(pill1.classList.contains('is-renaming'), true);
    assert.equal(pill1.querySelector('.agy-tab-close-wrap')?.classList.contains('hidden'), true, 'close button hidden while renaming');
    const input = pill1.querySelector('input.agy-rename-input');
    assert.ok(input, 'input.agy-rename-input mounted inside pill');
    assert.equal(pill1.querySelector('.agy-tab-label'), null, 'labelEl replaced while renaming');

    // Re-reconcile mid-rename preserves exact pill1 node and active input
    ui.reconcileTabStrip(
      stripEl,
      [
        { id: 't1', label: 'Polled Name', icon: 'terminal', active: true, renamable: true },
        { id: 't2', label: 'Term 2 Updated', icon: 'folder', active: false, renamable: true },
      ],
      opts
    );
    assert.equal(stripEl.querySelectorAll('.agy-tab')[0], pill1);
    assert.equal(pill1.querySelector('input.agy-rename-input'), input);

    input.value = 'Custom Server';
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(pill1._isRenaming, false);
    assert.equal(pill1.classList.contains('is-renaming'), false);
    assert.equal(pill1.querySelector('.agy-tab-close-wrap')?.classList.contains('hidden'), false, 'close button restored after rename');
    assert.equal(pill1.querySelector('.agy-tab-label')?.textContent, 'Custom Server');
    assert.deepEqual(renamed, [['t1', 'Custom Server']]);

    // Pre-existing [data-role="add-tab"] button preserved at end of strip
    const legacyStrip = doc.createElement('div');
    const legacyAdd = doc.createElement('button');
    legacyAdd.dataset.role = 'add-tab';
    legacyStrip.appendChild(legacyAdd);
    ui.reconcileTabStrip(legacyStrip, [{ id: 's1', label: 'One' }, { id: 's2', label: 'Two' }]);
    assert.deepEqual(Array.from(legacyStrip.children).map((c) => c.dataset.tabId || c.dataset.role), ['s1', 's2', 'add-tab']);

    // Overflow scroll + hidden tabs restore with grid_view fallback icon
    const overflowBtn = doc.createElement('button');
    const popoverEl = doc.createElement('div');
    doc.body.append(overflowBtn, popoverEl);
    let reopened = null;

    ui.setupStripScroll(stripEl, {
      overflowBtn,
      popoverEl,
      getItems: () => [{ id: 't1', label: 'Tab 1', icon: 'folder', status: 'running', pinned: true }],
      onSelect: (id) => selected.push(id),
      getClosedItems: () => [{ id: 'closed-1', displayName: 'Hidden Tab' }],
      onReopenClosed: (id) => (reopened = id),
    });

    assert.equal(overflowBtn.getAttribute('aria-haspopup'), 'menu');
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(popoverEl.getAttribute('role'), 'menu');
    assert.equal(overflowBtn.querySelector('.agy-tab-overflow-badge')?.textContent, '1');
    Object.defineProperty(stripEl, 'scrollWidth', { value: 320, configurable: true });
    Object.defineProperty(stripEl, 'clientWidth', { value: 200, configurable: true });
    stripEl._updateScroll();
    assert.equal(stripEl.classList.contains('mask-right'), true);
    let overflowTriggerFocused = false;
    overflowBtn.focus = () => {
      overflowTriggerFocused = true;
    };
    overflowBtn.click();
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'true');
    const overflowItems = popoverEl.querySelectorAll('.agy-tab-overflow-item');
    assert.equal(overflowItems.length, 2);
    assert.equal(overflowItems[0].getAttribute('role'), 'menuitem');
    assert.equal(overflowItems[1].getAttribute('role'), 'menuitem');
    assert.equal(popoverEl._focusIdx, 0, 'First overflow item receives focus on open');
    const focusedOverflowIndices = [];
    overflowItems.forEach((btn, idx) => {
      btn.focus = () => {
        focusedOverflowIndices.push(idx);
      };
    });
    popoverEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(popoverEl._focusIdx, 1);
    assert.deepEqual(focusedOverflowIndices, [1]);
    popoverEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(overflowTriggerFocused, true, 'Escape inside overflow popover restores focus to overflowBtn');
    assert.ok(overflowItems[1].querySelector('svg path')?.getAttribute('d')?.includes('M120-520v-320h320'));
    assert.equal(overflowItems[1].querySelector('.agy-tab-overflow-restore')?.textContent, 'Show');
    overflowItems[1].click();
    assert.equal(reopened, 'closed-1');

    // Global Ctrl+Tab / Ctrl+Shift+Tab & Ctrl+Shift+. / Ctrl+Shift+, visual-order tab cycling + cross-iframe message forwarding
    const cycleStrip = doc.createElement('div');
    doc.body.appendChild(cycleStrip);
    let activeCycleId = 'c1';
    let tabFocused = false;
    const scrollCalls = [];
    const renderCycleTabs = () => {
      ui.reconcileTabStrip(
        cycleStrip,
        [
          { id: 'c1', label: 'First', active: activeCycleId === 'c1' },
          { id: 'c2', label: 'Second', active: activeCycleId === 'c2' },
          { id: 'c3', label: 'Third', active: activeCycleId === 'c3' },
        ],
        {
          onSelect: (id) => {
            activeCycleId = id;
            renderCycleTabs();
          },
        }
      );
      for (const pill of cycleStrip.querySelectorAll('.agy-tab')) {
        pill.scrollIntoView = (arg) => scrollCalls.push([pill.dataset.tabId, arg]);
        pill.focus = () => {
          tabFocused = true;
        };
      }
    };
    renderCycleTabs();

    assert.equal(ui.matchTabCycleShortcut({ key: 'Tab', ctrlKey: true, shiftKey: false }), 1);
    assert.equal(ui.matchTabCycleShortcut({ key: 'Tab', ctrlKey: true, shiftKey: true }), -1);
    assert.equal(ui.matchTabCycleShortcut({ key: 'Tab', ctrlKey: true, altKey: true }), 0);
    assert.equal(ui.matchTabCycleShortcut({ key: 'Tab', ctrlKey: true, metaKey: true }), 0);
    assert.equal(ui.matchTabCycleShortcut({ key: 'Tab', ctrlKey: false }), 0);
    assert.equal(ui.matchTabCycleShortcut({ code: 'Period', key: '>', ctrlKey: true, shiftKey: true }), 1);
    assert.equal(ui.matchTabCycleShortcut({ code: 'Comma', key: '<', ctrlKey: true, shiftKey: true }), -1);

    const cleanupCycle = ui.bindGlobalTabCycleKeydown(() => cycleStrip);
    assert.equal(doc._hasLocalTabCycleHandler, true);

    const textInput = doc.createElement('input');
    doc.body.appendChild(textInput);

    textInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(activeCycleId, 'c2', 'Ctrl+Tab advances to second tab even when focus is inside an input');
    assert.equal(tabFocused, false, 'Ctrl+Tab must not move DOM focus onto the tab button');
    assert.deepEqual(scrollCalls.at(-1), ['c2', { block: 'nearest', inline: 'nearest' }]);

    // Repeat events are ignored for cycling
    textInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, repeat: true, bubbles: true, cancelable: true }));
    assert.equal(activeCycleId, 'c2');

    // Ctrl+Shift+. advances to third tab and scrolls to inline: 'end'
    textInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: '>', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(activeCycleId, 'c3');
    assert.deepEqual(scrollCalls.at(-1), ['c3', { block: 'nearest', inline: 'end' }]);

    // Wrap around from last tab to first tab (inline: 'start')
    textInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(activeCycleId, 'c1');
    assert.deepEqual(scrollCalls.at(-1), ['c1', { block: 'nearest', inline: 'start' }]);

    // Ctrl+Shift+Tab wraps backwards from first tab to last tab
    textInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(activeCycleId, 'c3');

    // Forwarded message from child iframe cycles strip
    const msgEv = new win.Event('message');
    msgEv.data = { type: 'agy:shortcut-forwarded', dir: -1, repeat: false };
    win.dispatchEvent(msgEv);
    assert.equal(activeCycleId, 'c2');

    cleanupCycle();
    assert.equal(doc._hasLocalTabCycleHandler, false);
  });

  it('handles measureStrip, bindTabDragController (tab + strip level), bindSplitResize, openContextMenu, and showToast', () => {
    const { win, doc, ui } = createDomEnv();
    const dragStrip = doc.createElement('div');
    const pA = doc.createElement('button');
    pA.className = 'agy-tab';
    pA.dataset.sidecarId = 'alpha';
    const pB = doc.createElement('button');
    pB.className = 'agy-tab';
    pB.dataset.sidecarId = 'beta';
    const pAdd = doc.createElement('button');
    pAdd.dataset.role = 'add-tab';
    dragStrip.append(pA, pB, pAdd);
    doc.body.appendChild(dragStrip);

    stubRect(dragStrip, { left: 0, right: 200, top: 0, bottom: 30, width: 200, height: 30 });
    stubRect(pA, { left: 0, right: 60, top: 4, bottom: 26, width: 60, height: 22 });
    stubRect(pB, { left: 64, right: 124, top: 4, bottom: 26, width: 60, height: 22 });

    const m = ui.measureStrip(dragStrip, pA, 15, 15, '[data-sidecar-id], [data-role="add-tab"]');
    assert.equal(m.sourceTabs.length, 2, 'measureStrip excludes pinned add-tab role');
    assert.equal(m.draggedIndex, 0);
    assert.equal(m.step, 64);

    let dropMeta = null;
    let reorderedIds = null;
    let outOfRail = 0;
    ui.bindTabDragController(dragStrip, {
      tabSelector: '[data-sidecar-id]',
      idDatasetKey: 'sidecarId',
      getReorderIds: () => ['alpha', 'beta'],
      onReorder: (ids) => {
        reorderedIds = ids;
      },
      onOutOfRailMove: () => outOfRail++,
      onDrop: (_e, state) => {
        dropMeta = state;
      },
    });

    pA.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 15, clientY: 15 }));
    win.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 1, clientX: 105, clientY: 15 }));
    assert.equal(pA.classList.contains('is-dragging-source'), true);
    assert.equal(pB.style.transform, 'translateX(-64px)');

    win.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 1, clientX: 105, clientY: 120 }));
    assert.equal(outOfRail, 1);
    assert.equal(pB.style.transform, '');

    win.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 1, clientX: 105, clientY: 15 }));
    win.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 105, clientY: 15 }));
    assert.equal(pA.classList.contains('is-dragging-source'), false);
    assert.ok(dropMeta);
    assert.deepEqual(reorderedIds, ['beta', 'alpha']);

    // Dragging second tab (pB) left to outermost slot 0 (before pA)
    reorderedIds = null;
    pB.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, clientX: 90, clientY: 15 }));
    win.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 2, clientX: 10, clientY: 15 }));
    assert.equal(pA.style.transform, 'translateX(64px)');
    win.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientX: 10, clientY: 15 }));
    assert.deepEqual(reorderedIds, ['beta', 'alpha']);

    // Split resize controller
    const container = doc.createElement('div');
    const sash = doc.createElement('div');
    container.appendChild(sash);
    doc.body.appendChild(container);
    stubRect(container, { left: 0, right: 400, top: 0, bottom: 400, width: 400, height: 400 });

    const ratios = [];
    ui.bindSplitResize(sash, {
      direction: 'horizontal',
      containerEl: container,
      minRatio: 0.2,
      maxRatio: 0.8,
      onResize: (r) => ratios.push(r),
    });
    sash.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, pointerId: 2 }));
    win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 390, clientY: 50 }));
    win.dispatchEvent(new win.PointerEvent('pointerup'));
    assert.deepEqual(ratios, [0.25, 0.8]);
    assert.equal(sash.getAttribute('role'), 'separator');
    assert.equal(sash.getAttribute('tabindex'), '0');
    assert.equal(sash.getAttribute('aria-orientation'), 'vertical');
    assert.equal(sash.getAttribute('aria-valuenow'), '80');

    // Keyboard resizing (ArrowLeft / Home / End) and re-binding without duplicate listeners
    const rebindDeltas = [];
    let rebindStartX = 0;
    ui.bindSplitResize(sash, {
      direction: 'horizontal',
      containerEl: container,
      minRatio: 0.2,
      maxRatio: 0.8,
      onResizeStart: (e) => {
        rebindStartX = e.clientX;
      },
      onResize: (r, e) => {
        ratios.push(r);
        rebindDeltas.push(e.clientX - rebindStartX);
      },
    });
    sash.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    assert.deepEqual(ratios, [0.25, 0.8, 0.75]);
    assert.deepEqual(rebindDeltas, [-20]);
    sash.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    assert.equal(ratios.at(-1), 0.2);
    assert.equal(sash.getAttribute('aria-valuenow'), '20');
    sash.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    assert.equal(ratios.at(-1), 0.8);
    assert.equal(sash.getAttribute('aria-valuenow'), '80');

    // Context menu keyboard navigation, focus restoration on Escape, innerWidth=0 clamping, & toast
    win.innerWidth = 0;
    let menuClicked = false;
    let triggerRestored = false;
    const menuTrigger = doc.createElement('button');
    menuTrigger.focus = () => {
      triggerRestored = true;
    };
    const menu = ui.openContextMenu({ clientX: 140, clientY: 180, target: menuTrigger }, [
      { id: 'disabled-item', label: 'Disabled', disabled: true },
      { separator: true },
      { id: 'pin', icon: 'keep', label: 'Pin Tab', checked: true, onClick: () => (menuClicked = true) },
    ]);
    assert.equal(menu.style.left, '140px');
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(triggerRestored, true, 'Escape closes context menu and restores focus to trigger');

    ui.openContextMenu({ clientX: 140, clientY: 180, target: menuTrigger }, [
      { id: 'disabled-item', label: 'Disabled', disabled: true },
      { separator: true },
      { id: 'pin', icon: 'keep', label: 'Pin Tab', checked: true, onClick: () => (menuClicked = true) },
    ]);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(menuClicked, true);
    win.innerWidth = 800;

    const toast = ui.showToast('Saved layout', { durationMs: 0 });
    assert.equal(toast.textContent, 'Saved layout');
    assert.equal(toast.getAttribute('role'), 'status');
    assert.equal(toast.getAttribute('aria-live'), 'polite');

    const errToast = ui.showToast('Failed to save', { error: true, durationMs: 0 });
    assert.equal(errToast.className, 'agy-toast error');
    assert.equal(errToast.getAttribute('role'), 'alert');
    assert.equal(errToast.getAttribute('aria-live'), 'assertive');
  });

  it('upgrades and dispatches events on Light-DOM Custom Elements (<agy-tab>, <agy-tab-strip>, <agy-toggle-group>, <agy-split-sash>, <agy-switch>)', () => {
    const { win, doc, ui } = createDomEnv();

    // <agy-switch> click + Space/Enter keyboard activation + disabled guard
    const sw = ui.html`<agy-switch checked size="sm"></agy-switch>`;
    doc.body.appendChild(sw);
    assert.equal(sw.checked, true);
    assert.equal(sw.getAttribute('aria-checked'), 'true');
    const switchEvents = [];
    sw.addEventListener('change', (e) => switchEvents.push(e.detail.checked));
    sw.querySelector('button').click();
    sw.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    sw.disabled = true;
    sw.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(switchEvents, [false, true]);

    // <agy-toggle-group> roving tabIndex + keyboard navigation skipping disabled items
    const tg = doc.createElement('agy-toggle-group');
    tg.items = [
      { id: 'all', label: 'All', count: 4 },
      { id: 'disabled', label: 'Disabled', disabled: true },
      { id: 'running', label: 'Running', count: 2 },
    ];
    tg.value = 'all';
    doc.body.appendChild(tg);
    const toggleChanges = [];
    tg.addEventListener('change', (e) => toggleChanges.push(e.detail.value));
    tg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(tg.value, 'running');
    assert.deepEqual(
      Array.from(tg.querySelectorAll('.agy-toggle-item')).map((b) => b.tabIndex),
      [-1, -1, 0]
    );
    assert.deepEqual(toggleChanges, ['running']);

    // Pre-rendered <agy-toggle-group> children support click + keyboard + change event
    const preTg = ui.html`<agy-toggle-group>
      <button type="button" class="agy-toggle-item active" data-tab="context">Context</button>
      <button type="button" class="agy-toggle-item" data-tab="mcp">MCP</button>
    </agy-toggle-group>`;
    doc.body.appendChild(preTg);
    const preChanges = [];
    preTg.addEventListener('change', (e) => preChanges.push(e.detail.value));
    assert.equal(preTg.value, 'context');
    assert.deepEqual(
      Array.from(preTg.querySelectorAll('.agy-toggle-item')).map((b) => [b.tabIndex, b.getAttribute('aria-selected')]),
      [
        [0, 'true'],
        [-1, 'false'],
      ]
    );
    preTg.querySelector('[data-tab="mcp"]').click();
    assert.equal(preTg.value, 'mcp');
    assert.equal(preTg.querySelector('[data-tab="mcp"]').classList.contains('active'), true);
    assert.equal(preTg.querySelector('[data-tab="mcp"]').getAttribute('aria-selected'), 'true');
    assert.deepEqual(preChanges, ['mcp']);
    preTg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(preTg.value, 'context');
    assert.deepEqual(preChanges, ['mcp', 'context'], 'Arrow key navigation on pre-rendered items must dispatch change exactly once');

    const roleOnlyTg = ui.html`<agy-toggle-group layout="grid">
      <button type="button" class="agy-toggle-item active" data-role="split-dir">H</button>
      <button type="button" class="agy-toggle-item" data-role="split-swap">S</button>
    </agy-toggle-group>`;
    doc.body.appendChild(roleOnlyTg);
    assert.equal(roleOnlyTg.style.getPropertyValue('--agy-toggle-cols'), '2', 'Pre-rendered grid toggle group must set --agy-toggle-cols');
    assert.deepEqual(
      Array.from(roleOnlyTg.querySelectorAll('.agy-toggle-item')).map((b) => b.tabIndex),
      [0, -1],
      'Pre-rendered toggle group without item keys must initialize roving tabIndex'
    );
    const roleChanges = [];
    let roleClicks = 0;
    roleOnlyTg.addEventListener('change', (e) => roleChanges.push(e.detail.value));
    roleOnlyTg.addEventListener('click', () => {
      roleClicks++;
    });
    roleOnlyTg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.deepEqual(roleChanges, [], 'data-role buttons without item ids must not dispatch empty change events on keydown');
    assert.equal(roleClicks, 0, 'data-role buttons without item ids must not auto-fire click actions on arrow key navigation');
    assert.deepEqual(
      Array.from(roleOnlyTg.querySelectorAll('.agy-toggle-item')).map((b) => b.tabIndex),
      [-1, 0],
      'ArrowRight on data-role toggle group must advance roving tabIndex to target button'
    );
    roleOnlyTg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.deepEqual(
      Array.from(roleOnlyTg.querySelectorAll('.agy-toggle-item')).map((b) => b.tabIndex),
      [0, -1],
      'Second ArrowRight on data-role toggle group must advance from current roving button even when first button keeps .active'
    );

    const dataValTg = ui.html`<agy-toggle-group>
      <button type="button" class="agy-toggle-item active" data-value="v1">V1</button>
      <button type="button" class="agy-toggle-item" data-id="v2">V2</button>
    </agy-toggle-group>`;
    doc.body.appendChild(dataValTg);
    assert.equal(dataValTg.value, 'v1');
    assert.equal(dataValTg.getAttribute('role'), 'radiogroup');
    assert.equal(dataValTg.querySelector('[data-value="v1"]').getAttribute('role'), 'radio');
    dataValTg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(dataValTg.value, 'v2');

    const ttlTg = ui.html`<agy-toggle-group>
      <button type="button" class="agy-toggle-item active" data-role="ttl-5" data-ttl="5">5m</button>
      <button type="button" class="agy-toggle-item" data-role="ttl-10" data-ttl="10">10m</button>
    </agy-toggle-group>`;
    doc.body.appendChild(ttlTg);
    let ttlClicked = '';
    ttlTg.querySelector('[data-ttl="10"]').addEventListener('click', () => {
      ttlClicked = '10';
    });
    ttlTg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(ttlTg.value, '10');
    assert.equal(ttlClicked, '10');
    ttlTg.querySelector('[data-ttl="10"]').classList.remove('active');
    ttlTg.sync();
    assert.equal(ttlTg.value, '');
    assert.equal(ttlTg.querySelector('[data-ttl="10"]').getAttribute('aria-checked'), 'false');

    const tablistTg = ui.html`<agy-toggle-group role="tablist">
      <button type="button" class="agy-toggle-item active" data-subtab="installed">Installed</button>
      <button type="button" class="agy-toggle-item" data-subtab="discover">Discover</button>
    </agy-toggle-group>`;
    doc.body.appendChild(tablistTg);
    assert.equal(tablistTg.querySelector('[data-subtab="installed"]').getAttribute('role'), 'tab');
    assert.equal(tablistTg.querySelector('[data-subtab="installed"]').getAttribute('aria-selected'), 'true');
    assert.equal(tablistTg.querySelector('[data-subtab="installed"]').getAttribute('aria-checked'), null);

    // syncSwitchState syncs both outer button[role="switch"] and inner <agy-switch>
    const wrappedSw = ui.html`<button type="button" role="switch" class="agy-switch"><agy-switch></agy-switch></button>`;
    doc.body.appendChild(wrappedSw);
    ui.syncSwitchState(wrappedSw, true, true);
    assert.equal(wrappedSw.classList.contains('on'), true);
    assert.equal(wrappedSw.getAttribute('aria-checked'), 'true');
    assert.equal(wrappedSw.disabled, true);
    assert.equal(wrappedSw.querySelector('agy-switch').checked, true);

    // <agy-tab> and <agy-tab-strip>
    const strip = doc.createElement('agy-tab-strip');
    strip.tabs = [
      { id: 'a', label: 'Alpha', active: true, renamable: true },
      { id: 'b', label: 'Beta', active: false },
    ];
    doc.body.appendChild(strip);
    assert.equal(strip.querySelectorAll('.agy-tab').length, 2);

    const tabEl = doc.createElement('agy-tab');
    tabEl.tab = { id: 'custom-1', label: 'One', renamable: true };
    doc.body.appendChild(tabEl);
    const tabEvents = [];
    tabEl.addEventListener('tab-select', (e) => tabEvents.push(['select', e.detail.id]));
    tabEl.addEventListener('tab-rename', (e) => tabEvents.push(['rename', e.detail.value]));
    tabEl.click();
    const inp = tabEl.startRename();
    inp.value = 'Renamed One';
    inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));
    assert.deepEqual(tabEvents, [
      ['select', 'custom-1'],
      ['rename', 'Renamed One'],
    ]);

    // <agy-split-sash> resize + mid-drag disconnect cleanup
    const splitBox = doc.createElement('div');
    stubRect(splitBox, { left: 0, right: 200, top: 0, bottom: 200, width: 200, height: 200 });
    const sashEl = ui.html`<agy-split-sash direction="vertical" min-ratio="0.1" max-ratio="0.9"></agy-split-sash>`;
    splitBox.appendChild(sashEl);
    doc.body.appendChild(splitBox);
    const splitEvents = [];
    sashEl.addEventListener('split-resize', (e) => splitEvents.push(e.detail.ratio));
    sashEl.dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
    sashEl.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 50, clientY: 100 }));
    assert.equal(doc.body.classList.contains('resizing-split'), true);
    sashEl.remove();
    assert.equal(doc.body.classList.contains('resizing-split'), false);
    assert.deepEqual(splitEvents, [0.5]);
  });
});
