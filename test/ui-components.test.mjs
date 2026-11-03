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

    assert.equal(overflowBtn.querySelector('.agy-tab-overflow-badge')?.textContent, '1');
    Object.defineProperty(stripEl, 'scrollWidth', { value: 320, configurable: true });
    Object.defineProperty(stripEl, 'clientWidth', { value: 200, configurable: true });
    stripEl._updateScroll();
    assert.equal(stripEl.classList.contains('mask-right'), true);
    overflowBtn.click();
    const overflowItems = popoverEl.querySelectorAll('.agy-tab-overflow-item');
    assert.equal(overflowItems.length, 2);
    assert.ok(overflowItems[1].querySelector('svg path')?.getAttribute('d')?.includes('M120-520v-320h320'));
    assert.equal(overflowItems[1].querySelector('.agy-tab-overflow-restore')?.textContent, 'Show');
    overflowItems[1].click();
    assert.equal(reopened, 'closed-1');
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

    // Context menu keyboard navigation, innerWidth=0 clamping, & toast
    win.innerWidth = 0;
    let menuClicked = false;
    const menu = ui.openContextMenu({ clientX: 140, clientY: 180 }, [
      { id: 'disabled-item', label: 'Disabled', disabled: true },
      { separator: true },
      { id: 'pin', icon: 'keep', label: 'Pin Tab', checked: true, onClick: () => (menuClicked = true) },
    ]);
    assert.equal(menu.style.left, '140px');
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(menuClicked, true);
    win.innerWidth = 800;

    const toast = ui.showToast('Saved layout', { durationMs: 0 });
    assert.equal(toast.textContent, 'Saved layout');
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
