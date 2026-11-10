import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { AGY_CLIENT_JS, AGY_SHELL_CSS } from '../lib/shell.mjs';
import {
  AGY_UI_CSS,
  AGY_UI_CSS_MODULES,
  AGY_UI_JS,
  AGY_UI_JS_MODULES,
  ALL_AGY_UI_MODULES,
  attachAgyUI,
  buildAgyUiCss,
  buildAgyUiJs,
  readModuleCss,
  readModuleJs,
  resolveAgyUiModules,
} from '../lib/ui.mjs';
import {
  createShellClientHandler,
  createShellCssHandler,
  createUiCssHandler,
  createUiJsHandler,
  enforceSidecarToken,
  registerUiRoutes,
} from '../lib/server.mjs';

describe('antigravity-sidecar-kit/ui core routes, modularity, leak guards, and tagged JSX', () => {
  it('serves true per-module CSS and JS payloads and preserves module CSS banners', () => {
    const shellCss = createShellCssHandler()().body;
    const clientJs = createShellClientHandler()().body;
    assert.equal(shellCss.includes('.agy-tab-strip'), false);
    assert.equal(clientJs.includes('reconcileTabStrip'), false);

    for (const mod of ALL_AGY_UI_MODULES) {
      assert.ok(
        AGY_UI_CSS_MODULES[mod].startsWith(`/* AgyUI Module: ${mod} */`),
        `${mod}.css must start with /* AgyUI Module: ${mod} */`
      );
      assert.equal(readModuleCss(mod), AGY_UI_CSS_MODULES[mod]);
      assert.equal(readModuleJs(mod), AGY_UI_JS_MODULES[mod]);
      assert.ok(AGY_UI_CSS.includes(`/* AgyUI Module: ${mod} */`));
    }
    assert.equal(readModuleCss('controls').includes('/* AgyUI Module: core */'), false);
    assert.equal(readModuleJs('controls').includes('compileTemplate'), false);

    assert.deepEqual(resolveAgyUiModules(['controls', 'surfaces']), ['core', 'controls', 'surfaces']);
    const subsetCss = buildAgyUiCss(['controls', 'surfaces']);
    assert.ok(subsetCss.includes('.agy-btn'));
    assert.ok(subsetCss.includes('.agy-card'));
    assert.equal(subsetCss.includes('.agy-tab-strip'), false);

    const subsetJs = buildAgyUiJs(['controls', 'surfaces']);
    assert.ok(subsetJs.includes('renderSwitch'));
    assert.ok(subsetJs.includes('renderCountPill'));
    assert.equal(subsetJs.includes('reconcileTabStrip'), false);
    assert.equal(subsetJs.includes('bindTabDragController'), false);
    assert.equal(subsetJs.includes('bindSplitResize'), false);
    assert.equal(subsetJs.includes('openContextMenu'), false);

    const { window: win } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const ui = attachAgyUI(win, { modules: ['controls', 'surfaces'] });
    assert.equal(typeof ui.escHtml, 'function');
    assert.equal(typeof ui.renderSwitch, 'function');
    assert.equal(typeof ui.renderCountPill, 'function');
    assert.equal(ui.reconcileTabStrip, undefined);

    const pages = new Map();
    registerUiRoutes({ page: (p, fn) => pages.set(p, fn) }, { modules: ['tabs', 'controls'] });
    assert.equal(pages.has('/ui.css'), true);
    assert.equal(pages.has('/ui.js'), true);
    for (const m of ALL_AGY_UI_MODULES) {
      assert.equal(pages.has(`/ui/${m}.css`), true);
      assert.equal(pages.has(`/ui/${m}.js`), true);
    }
    const controlsRouteCss = pages.get('/ui/controls.css')().body;
    const controlsRouteJs = pages.get('/ui/controls.js')().body;
    assert.equal(controlsRouteCss, AGY_UI_CSS_MODULES.controls);
    assert.equal(controlsRouteCss.includes('/* AgyUI Module: core */'), false);
    assert.equal(controlsRouteJs, AGY_UI_JS_MODULES.controls);
    assert.ok(controlsRouteJs.includes('renderSwitch'));
    assert.equal(controlsRouteJs.includes('reconcileTabStrip'), false);
    assert.ok(createUiCssHandler()().body.includes('.agy-tab'));
    assert.ok(createUiJsHandler()().body.includes('reconcileTabStrip'));

    const tabsCss = readModuleCss('tabs');
    assert.ok(tabsCss.includes('border-radius: var(--nux-radius-pill, var(--agy-radius-pill, 9999px));'));
    assert.ok(tabsCss.includes('background: none;'));
    assert.ok(tabsCss.includes('mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent calc(100% - 18px));'));
    assert.ok(tabsCss.includes(':has(> :is(.agy-tab-badge, .agy-tab-ext-badge):not(.hidden))'));
    assert.match(tabsCss, /\.agy-tab-close\s*\{[^}]*min-width:\s*22px;[^}]*min-height:\s*22px;/s);
    assert.ok(tabsCss.includes('mask-image: none;'));
    assert.equal(tabsCss.includes('calc(100% - 14px)'), false);
    assert.equal(tabsCss.includes('linear-gradient(to right, transparent 0%, var(--agy-hover) 25%)'), false);
    assert.equal(tabsCss.includes('linear-gradient(to right, transparent 0%, var(--agy-control) 25%)'), false);
    const tabDragCss = readModuleCss('tab-drag');
    assert.ok(tabDragCss.includes('border-radius: var(--nux-radius-pill, var(--agy-radius-pill, 9999px));'));
    assert.equal(tabDragCss.includes('border-radius: var(--radius-lg, 0.5rem);'), false);
    assert.ok(tabsCss.includes('.agy-tab:focus-visible'));
    assert.ok(tabsCss.includes('.agy-tab-pin:focus-visible'));
    assert.ok(tabsCss.includes('.agy-tab-close:focus-visible'));
    assert.ok(tabsCss.includes('.agy-tab-overflow-item:focus-visible'));
    assert.ok(tabsCss.includes('.agy-toggle-item:focus-visible:not(:disabled)'));
    assert.ok(controlsRouteCss.includes('.agy-icon-btn:focus-visible:not(:disabled)'));
    assert.ok(controlsRouteCss.includes('.agy-btn:focus-visible:not(:disabled)'));
    assert.ok(controlsRouteCss.includes('.agy-switch:focus-visible:not(:disabled):not(.disabled)'));
    assert.ok(controlsRouteCss.includes('.agy-select:is(:focus, :focus-visible)'));
    // The select's fill is translucent, so its option list gets an opaque one (else it shows white in dark themes)
    assert.match(controlsRouteCss, /\.agy-select :is\(option, optgroup\)\s*\{[^}]*background-color:\s*var\(--agy-card\);[^}]*color:\s*var\(--agy-ink\);/s);
    // The text field matches Antigravity's: a pill on the host's --muted fill, with its focus ring and placeholder
    assert.match(controlsRouteCss, /\.agy-input\s*\{[^}]*height:\s*32px;[^}]*border-radius:\s*var\(--nux-radius-pill[^}]*background:\s*var\(--agy-sunken\);/s);
    assert.ok(controlsRouteCss.includes('.agy-input:focus-visible'));
    assert.ok(controlsRouteCss.includes('.agy-input::placeholder'));
    assert.match(controlsRouteCss, /textarea\.agy-input\s*\{[^}]*border-radius:\s*var\(--nux-radius-md/s);
    assert.ok(controlsRouteCss.includes('.agy-form-field.is-invalid .agy-input'));
    assert.match(controlsRouteCss, /\.agy-search-box\s*>\s*svg,\s*\.agy-search-icon\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/s);
    assert.equal(controlsRouteCss.includes('.agy-search-box svg'), false);

    // Components match Antigravity 2.29's own: buttons default to its "sm" size, with its xs/md/lg sizes
    assert.match(controlsRouteCss, /\.agy-btn\s*\{[^}]*height:\s*28px;[^}]*padding:\s*0 10px;[^}]*font-size:\s*var\(--text-sm/s);
    assert.match(controlsRouteCss, /\.agy-btn\.agy-btn-xs\s*\{[^}]*height:\s*24px;/s);
    assert.match(controlsRouteCss, /\.agy-btn\.agy-btn-md\s*\{[^}]*height:\s*32px;/s);
    assert.match(controlsRouteCss, /\.agy-btn\.agy-btn-lg\s*\{[^}]*height:\s*36px;/s);
    assert.match(controlsRouteCss, /:is\(\.agy-btn-danger, \.agy-btn\.danger\)\s*\{[^}]*background:\s*var\(--color-red-500, #de5555\);[^}]*color:\s*#ffffff;/s);
    assert.match(controlsRouteCss, /\.agy-search-input\s*\{[^}]*height:\s*32px;[^}]*border-radius:\s*var\(--nux-radius-pill[^}]*background:\s*var\(--agy-sunken\);/s);
    const surfacesCss = readModuleCss('surfaces');
    assert.match(surfacesCss, /\.agy-card\s*\{[^}]*border-radius:\s*var\(--nux-radius-lg[^}]*background:\s*var\(--agy-card\);/s, 'cards: the 16px radius and the card fill');
    assert.match(surfacesCss, /\.agy-badge\s*\{[^}]*font-weight:\s*var\(--font-weight-normal, 400\);[^}]*background:\s*var\(--agy-sunken\);/s);
    assert.match(readModuleCss('overlays'), /\.agy-banner\s*\{[^}]*padding:\s*10px 12px;[^}]*border-radius:\s*var\(--nux-radius-lg[^}]*font-size:\s*var\(--text-sm[^}]*background:\s*var\(--agy-card\);/s, 'banners match the callout');
    assert.match(
      readModuleCss('overlays'),
      /\.agy-toast\s*\{[^}]*max-width:\s*24rem;[^}]*padding:\s*12px;[^}]*border-radius:\s*var\(--nux-radius-lg[^}]*background:\s*var\(--glass, var\(--agy-card\)\);[^}]*font-size:\s*var\(--text-sm/s,
      'toasts match the native toast',
    );
    assert.ok(readModuleCss('overlays').includes('.agy-context-menu-item:focus-visible:not(:disabled)'));
    assert.ok(readModuleCss('layout').includes(':is(agy-split-sash, .agy-split-sash):focus-visible .sash-line'));
  });

  it('contains zero consumer leaks (Hangar, --cm-*, .is-Connected, hub-add-tab) across shell and ui payloads', () => {
    const combined = [AGY_SHELL_CSS, AGY_CLIENT_JS, AGY_UI_CSS, AGY_UI_JS].join('\n');
    for (const forbidden of [
      'Hangar',
      'hangar',
      '--cm-',
      'is-Connected',
      'is-Reconnecting',
      'is-Disconnected',
      'hub-add-tab',
      '_replacedBy',
      'sidecarId',
      'sidecar-id',
    ]) {
      assert.equal(
        combined.includes(forbidden),
        false,
        `Shared SDK payload must not contain consumer leak: ${forbidden}`
      );
    }
    assert.equal(readModuleJs('core').includes("Object.defineProperty(elProto, 'tabIndex'"), false);
    assert.equal(AGY_UI_JS.includes("Object.defineProperty(elProto, 'tabIndex'"), false);
  });

  it('enforces readable multi-line formatting across all lib/ui CSS and shell CSS modules', () => {
    for (const mod of ALL_AGY_UI_MODULES) {
      const css = readModuleCss(mod);
      const multiPropLines = css
        .split(/\r?\n/)
        .filter((line) => (line.match(/;/g) || []).length >= 3);
      assert.deepEqual(
        multiPropLines,
        [],
        `${mod}.css contains horizontally golfed multi-property lines`
      );
    }
    const shellMultiProp = AGY_SHELL_CSS.split(/\r?\n/).filter(
      (line) => (line.match(/;/g) || []).length >= 3
    );
    assert.deepEqual(
      shellMultiProp,
      [],
      'shell.css contains horizontally golfed multi-property lines'
    );

    const jsBundles = [
      ['shell-client', AGY_CLIENT_JS],
      ...ALL_AGY_UI_MODULES.map((m) => [m, readModuleJs(m)]),
    ];
    for (const [name, js] of jsBundles) {
      const commaDecls = js
        .split(/\r?\n/)
        .filter((l) => /^\s*(let|const)\s+[A-Za-z0-9_$]+\s*=\s*[^,;(]+,\s*[A-Za-z0-9_$]+\s*=/.test(l));
      assert.deepEqual(commaDecls, [], `${name}.js contains comma-chained variable declarations`);
      const multiStmtLines = js
        .split(/\r?\n/)
        .filter((l) => !l.includes('for (') && (l.match(/;/g) || []).length >= 3);
      assert.deepEqual(multiStmtLines, [], `${name}.js contains packed multi-statement single lines`);
    }
  });

  it('compiles AgyUI.html tagged JSX with AST caching, XSS escaping, SVG namespace, and attribute edge cases', () => {
    const { window: win, document: doc } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const ui = attachAgyUI(win);

    const renderRow = (title, count) => ui.html`<div class="row" data-count="${count}">${title}</div>`;
    const row1 = renderRow('First', 1);
    const row2 = renderRow('Second', 2);
    assert.equal(row1.className, 'row');
    assert.equal(row1.getAttribute('data-count'), '1');
    assert.equal(row2.textContent, 'Second');

    let clicked = 0;
    let ctxClicked = 0;
    const xssPayload = '<img src=x onerror=alert(1)>';
    const nestedBadge = ui.html`<span class="agy-badge ok">Safe</span>`;
    const icon = ui.iconEl('grid_view', 14);
    const card = ui.html`<div
      class="agy-card ${'mod-a'} ${'mod-b'}"
      style="width: ${75}%; height: ${24}px"
      title = "a > b"
      data-lt = "x < y"
      onClick=${() => clicked++}
      onMouseDown=${false}
      onTabContextMenu=${() => ctxClicked++}
      .customMeta=${{ ready: true }}
      ?disabled=${true}
      ?hidden=${false}
    >
      ${xssPayload}
      ${nestedBadge}
      ${icon}
      ${0}${NaN}
    </div>`;

    doc.body.appendChild(card);
    assert.equal(card.querySelector('img'), null, 'Interpolated string must be escaped as a Text node');
    assert.ok(card.textContent.includes(xssPayload));
    assert.equal(card.className, 'agy-card mod-a mod-b');
    assert.equal(card.getAttribute('style'), 'width: 75%; height: 24px');
    assert.equal(card.getAttribute('title'), 'a > b');
    assert.equal(card.getAttribute('data-lt'), 'x < y');
    assert.equal(card.hasAttribute('onmousedown'), false);
    assert.equal(card.querySelector('.agy-badge'), nestedBadge);
    assert.ok(card.querySelector('svg'));
    assert.deepEqual(card.customMeta, { ready: true });
    assert.equal(card.hasAttribute('disabled'), true);
    assert.equal(card.hasAttribute('hidden'), false);

    card.dispatchEvent(new win.Event('click'));
    card.dispatchEvent(new win.CustomEvent('tab-contextmenu', { bubbles: true }));
    assert.equal(clicked, 1);
    assert.equal(ctxClicked, 1);

    // Self-closing boolean attributes & SVG namespace
    const selfClosed = ui.html`<div><input disabled/><input ?disabled=${true}/><input ?disabled=${null}/></div>`;
    const inputs = selfClosed.querySelectorAll('input');
    assert.equal(inputs[0].hasAttribute('disabled'), true);
    assert.equal(inputs[1].hasAttribute('disabled'), true);
    assert.equal(inputs[2].hasAttribute('disabled'), false);

    const svgNode = ui.html`<svg viewBox="0 0 24 24" class="vec"><path d="M0 0"/></svg>`;
    assert.equal(svgNode.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svgNode.firstElementChild.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svgNode.getAttribute('class'), 'vec');

    const frag = ui.html`<><span>Alpha</span><span>Beta</span></>`;
    const host = doc.createElement('section');
    host.appendChild(frag);
    assert.equal(host.children.length, 2);

    const mixedAttrEl = ui.html`<div class="btn ${false && 'active'} ${null} ${undefined} ${NaN} ${'ok'}"></div>`;
    assert.equal(mixedAttrEl.className, 'btn ok');
  });

  it('supports createVisibilityPoller and X-Sidecar-Token forwarding in notifyAgent and apiCall', async () => {
    const { window: domWin, document: domDoc } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const winListeners = {};
    const docListeners = {};
    let ioCallback = null;

    const doc = {
      hidden: false,
      documentElement: domDoc.documentElement,
      addEventListener(ev, fn) {
        (docListeners[ev] = docListeners[ev] || []).push(fn);
      },
      removeEventListener() {},
    };
    const win = {
      parent: null,
      addEventListener(ev, fn) {
        (winListeners[ev] = winListeners[ev] || []).push(fn);
      },
      removeEventListener() {},
    };
    win.parent = win;

    class MockIntersectionObserver {
      constructor(cb) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {}
    }

    const timers = new Map();
    let nextTimerId = 1;
    vm.runInNewContext(AGY_CLIENT_JS, {
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

    assert.equal(win.Hangar, undefined, 'AGY_CLIENT_JS must not pollute window.Hangar');
    let pollCount = 0;
    let hostMessages = 0;
    let resolveInFlight = null;
    const poller = win.AgyShell.createVisibilityPoller({
      onPoll: () => {
        pollCount++;
        if (resolveInFlight) {
          const p = new Promise((r) => {
            resolveInFlight = r;
          });
          return p;
        }
      },
      onHostMessage: () => {
        hostMessages++;
      },
      intervalMs: 2500,
    });
    for (const fn of winListeners.message || []) {
      fn({ source: win.parent, data: { type: 'custom-msg' } });
    }
    assert.equal(hostMessages, 0, 'listeners must not fire before start() when autoStart is false');
    poller.start();
    assert.equal(pollCount, 1);

    for (const fn of winListeners.message || []) {
      fn({ source: win.parent, data: { type: 'sidecar-visibility', payload: { visible: false } } });
    }
    assert.equal(poller.isVisible(), false);
    assert.equal(timers.size, 0);

    for (const fn of winListeners.message || []) {
      fn({ source: win.parent, data: { type: 'sidecar-visibility', payload: { visible: true } } });
    }
    assert.equal(poller.isVisible(), true);
    assert.equal(pollCount, 2);

    ioCallback([{ isIntersecting: false }]);
    assert.equal(poller.isVisible(), false);
    ioCallback([{ isIntersecting: true }]);
    assert.equal(pollCount, 3);

    doc.hidden = true;
    for (const fn of docListeners.visibilitychange || []) fn();
    assert.equal(poller.isVisible(), false);
    doc.hidden = false;
    for (const fn of docListeners.visibilitychange || []) fn();
    assert.equal(pollCount, 4);

    // triggerNow() while a poll is in-flight queues pendingWake
    resolveInFlight = true;
    const inflightPromise = poller.triggerNow();
    assert.equal(pollCount, 5);
    poller.triggerNow();
    const finishFirst = resolveInFlight;
    resolveInFlight = null;
    finishFirst();
    await inflightPromise;
    assert.equal(pollCount, 6, 'triggerNow during inFlight must queue a pendingWake tick upon completion');
    poller.stop();

    const captured = [];
    domWin.location = {
      href: 'http://127.0.0.1:52000/?token=direct-tok-777&conversationId=conv-9',
      search: '?token=direct-tok-777&conversationId=conv-9',
    };
    domWin.fetch = async (url, init) => {
      captured.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    vm.runInNewContext(AGY_CLIENT_JS, {
      window: domWin,
      document: domDoc,
      fetch: domWin.fetch,
      URLSearchParams,
      URL,
      setTimeout,
      clearTimeout,
    });
    await domWin.AgyShell.notifyAgent('hello from direct iframe');
    assert.equal(captured[0].init.headers['X-Sidecar-Token'], 'direct-tok-777');

    const iframeUi = attachAgyUI(domWin);
    await iframeUi.apiCall('/api/mutate', { a: 1 });
    assert.equal(captured[1].init.headers['X-Sidecar-Token'], 'direct-tok-777');

    assert.equal(enforceSidecarToken({ headers: { 'X-Sidecar-Token': ['direct-tok-777'] } }, 'direct-tok-777'), true);
    assert.equal(enforceSidecarToken({ req: { url: '/page?token=direct-tok-777', headers: {} } }, 'direct-tok-777'), true);
    assert.equal(enforceSidecarToken({ req: { url: 'http://[invalid', headers: {} } }, 'direct-tok-777'), false);

    // Child iframe forwards Ctrl+Tab / Ctrl+Shift+Tab to window.parent when no local tab cycle handler is bound
    const forwardedToParent = [];
    domWin.parent = {
      postMessage(msg, targetOrigin) {
        forwardedToParent.push({ msg, targetOrigin });
      },
    };
    domWin.AgyShell.bindParentShortcutForwarder({ root: domDoc.documentElement });
    domDoc.documentElement.dispatchEvent(
      new domWin.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    );
    assert.deepEqual(JSON.parse(JSON.stringify(forwardedToParent)), [
      { msg: { type: 'agy:shortcut-forwarded', dir: -1, repeat: false }, targetOrigin: '*' },
    ]);
  });
});
