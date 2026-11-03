# `antigravity-sidecar-kit` UI v2 Design: Folder-per-Module Architecture, Tagged JSX (`html`), and Light-DOM Web Components

## 1. Intent & Why

[`lib/ui.mjs`](../../../lib/ui.mjs) (1,604 lines) and [`lib/shell.mjs`](../../../lib/shell.mjs) (322 lines) in `antigravity-sidecar-kit` currently suffer from severe architectural defects:
1. **Fake JS Modularity (`attachAgyUI.toString()`):** `lib/ui.mjs` defines a single 1,144-line function and serializes it over HTTP via `.toString()`. Requesting a subset of modules (`modules: ['core', 'controls', 'surfaces']`) or a per-module route (`/ui/controls.js`) still ships the entire 1,144-line payload to the browser.
2. **Test-Mock Pollution in Production Code:** Because [`test/ui.test.mjs`](../../../test/ui.test.mjs) uses a hand-rolled fake DOM (`makeDomNode`), production methods (`updateTabPill`, `startInlineRename`, `reconcileTabStrip`) contain branches checking `!btn.nodeType`, `labelEl._replacedBy`, and `pillEl.childNodes.splice(...)` that never execute in real browsers.
3. **Consumer Leaks in the Shared SDK:** `lib/shell.mjs` unconditionally creates `window.Hangar` in every sidecar, while `lib/ui.mjs` hardcodes Hangar selectors (`[data-role="hangar-update-banner"]`, `[data-sidecar-id]`, `'hub-add-tab'`), Hangar globals (`win.Hangar?.tabIconElement`, `win.Hangar?.EXTENSIONS_TAB_ID`), a nonexistent `'grid_view'` icon fallback, and Context Monitor private CSS variables (`--cm-green`, `--cm-yellow`, `--cm-red`, `--cm-blue`, `.is-Connected`, `.is-Reconnecting`, `.is-Disconnected`).
4. **Imperative DOM-Bag Soup & Missing `AgyUI.el`:** Stateful widgets (`reconcileTabStrip`, `setupStripScroll`, `createToggleGroup`, `bindSplitResize`) mutate DOM expando properties (`_scrollBound`, `_slots`, `_isRenaming`, `_shiftX`) across 7-argument functions, while `AgyUI.el` is documented in `SKILL.md` and called by consumers but missing from `lib/ui.mjs`.

This design replaces the monolithic string-serialized `lib/ui.mjs` and `lib/shell.mjs` with a **folder-per-module (`lib/ui/<module>/`)** layout containing real `.css` and `.js` files (`<= 250 lines` each), a **zero-build tagged JSX (`html\`...\``) DOM engine**, and **Light-DOM Custom Elements** (`<agy-tab-strip>`, `<agy-tab>`, `<agy-toggle-group>`, `<agy-split-sash>`, `<agy-switch>`).

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Hard 300-Line Ceiling on All UI & Entrypoint Files (Builder Call):** Every UI and entrypoint file touched by this migration (`lib/ui.mjs`, `lib/shell.mjs`, `lib/server.mjs`, `lib/scaffolder.mjs`, `lib/ui/**`, and `test/ui*.test.mjs`) must be `<= 300 lines` (targeting `<= 220 lines` per file). Unrelated backend modules (`lib/state-sync.mjs`, `lib/rpc.mjs`, `lib/setup.mjs`) are out of scope for this UI v2 refactor.
- **True Per-Module Payloads:** `buildAgyUiCss(modules)` and `buildAgyUiJs(modules)` concatenate only the files from the requested `lib/ui/<module>/` directories. `/ui/<module>.(css|js)` serves only that module's files (plus `core` if standalone).
- **Zero-Build Tagged JSX (`AgyUI.html`):** Provide an `htm`-style tagged template engine (`html\`<div class="agy-card" onClick=${fn}>${text}</div>\``) in `lib/ui/core/html.js` that returns real `HTMLElement` / `DocumentFragment` nodes with automatic text-node XSS escaping, direct event listener binding (`onClick`, `onKeydown`, etc.), boolean attribute toggling, and JS property forwarding on Custom Elements.
- **Light-DOM Custom Elements for Stateful Widgets:** Implement `<agy-tab>`, `<agy-tab-strip>`, `<agy-toggle-group>`, `<agy-split-sash>`, and `<agy-switch>` as autonomous Light-DOM Custom Elements (`extends HTMLElement`), while retaining backwards-compatible imperative wrappers (`reconcileTabStrip`, `createTabPill`, `updateTabPill`, `setupStripScroll`, `createToggleGroup`, `bindSplitResize`, `renderSwitch`) that delegate to or wrap those elements.
- **Zero Consumer Leaks in `lib/shell.mjs` and `lib/ui/**` (Builder Call):** Remove all `window.Hangar`, `--cm-*`, `.is-Connected`, and Hangar-specific strings/selectors from `lib/shell.mjs` and `lib/ui/**` (while preserving `resolveHostTheme().vars` in `lib/theme.mjs` so existing backend telemetry contracts remain non-breaking).
- **Real Spec-Compliant DOM in Unit Tests:** Add `linkedom` (or `happy-dom`) to `devDependencies` and delete all fake-DOM mock branches from production code.

### Non-Goals
- Introducing a virtual DOM framework (React) or a mandatory client-side bundler step (`webpack` / `vite`) for sidecar consumers.
- Using Shadow DOM (which would block `/compiled_tailwind.css`, `/shell.css`, and `/ui.css` rules from styling elements without duplicating `adoptedStyleSheets` across every element).
- Refactoring unrelated backend modules (`lib/state-sync.mjs`, `lib/rpc.mjs`, `lib/setup.mjs`, `lib/theme.mjs`).

### Anti-Goals (Failure Conditions Even If Tests Pass)
- Using `Function.prototype.toString()` to serve client JS.
- Embedding multi-hundred-line JS or CSS strings inside `.mjs` files.
- Any branch in `lib/ui/**` that checks for test-harness mock properties (`_replacedBy`, `!btn.nodeType`, `Array.isArray(el.childNodes)`).
- Any reference to `Hangar` or `ContextMonitor` (`--cm-*`) inside `lib/shell.mjs` or `lib/ui/**`.

---

## 3. Platform & Packaging Constraints

1. **Direct Execution (`node server.mjs`):** Sidecars run directly without a pre-start build step; Hangar installs remote sidecars with `npm install --omit=dev --ignore-scripts`.
2. **`bundleSidecarKit` (`lib/setup.mjs:112-121`):** When a sidecar is installed via `npx`, `setup.mjs` copies `antigravity-sidecar-kit` into `destDir/node_modules/antigravity-sidecar-kit`, stripping nested `node_modules` and `test/`. Therefore:
   - Any runtime client code (`html.js`, custom elements, stylesheets) **must** live inside `lib/ui/` as plain `.js` and `.css` files so `cpSync` includes it automatically.
   - Test-only DOM environments (`linkedom`) belong in `devDependencies` of `package.json`.
3. **HTML Asset Token Rewriting (`lib/server.mjs:39-60`):** `createAssetHandler` rewrites `src="/..."` and `href="/..."` in `.html` files to append `?token=<uiToken>&v=<bootTs>&conversationId=<id>`. Serving assembled `/shell.css`, `/shell.js`, `/ui.css`, and `/ui.js` routes via `SidecarApp.page()` preserves single-request loading and automatic cache-busting.

---

## 4. Approaches Considered

### Approach 1 (Selected): Folder-per-Module (`lib/ui/<module>/`) + Zero-Build Tagged JSX (`html\`...\``) + Light-DOM Custom Elements
- **Structure:** Each UI module (`shell`, `core`, `tabs`, `tab-drag`, `layout`, `overlays`, `controls`, `surfaces`) lives in its own folder under `lib/ui/<module>/` with real `.css` and `.js` files. `lib/ui.mjs` reads and caches each module's files via `readFileSync` and concatenates only the requested modules.
- **Templating & Components:** `lib/ui/core/html.js` provides `AgyUI.html` (tagged JSX returning real DOM nodes) and `AgyUI.el`. Stateful widgets (`<agy-tab>`, `<agy-tab-strip>`, `<agy-toggle-group>`, `<agy-split-sash>`, `<agy-switch>`) are registered via `customElements.define()` using Light DOM.
- **Tradeoffs:** Zero build step; zero runtime NPM dependencies; works in both `<script type="module">` and classic `<script defer>` environments; eliminates both `el()` pyramids and `innerHTML` string concatenation.

### Approach 2: Compiled `.jsx` Files via `esbuild` (`devDependency`)
- **Structure:** Author `.jsx` files and compile them with `esbuild` before commit/publish.
- **Why Rejected:** Requires every sidecar repository to maintain a build step and commit compiled `dist/` artifacts to git because Hangar installs remote sidecars with `--omit=dev --ignore-scripts`.

### Approach 3: Imperative Helper Functions Only (No Custom Elements, No Tagged JSX)
- **Structure:** Keep all components as imperative `AgyUI.reconcileTabStrip(...)` / `AgyUI.el(...)` functions split across files.
- **Why Rejected:** Leaves stateful widgets relying on fragile DOM expando properties (`_scrollBound`, `_slots`, `_isRenaming`) and leaves consumer sidecars stuck with verbose `el()` pyramids or unsafe `innerHTML` string concatenation.

---

## 5. Detailed Architecture & Module Specifications

### 5.1 Directory Structure (`lib/ui/`)

```text
lib/
├── index.mjs                   # Public barrel export (<= 30 lines)
├── server.mjs                  # Route factories & registerUiRoutes (<= 115 lines)
├── shell.mjs                   # Reads & exports AGY_SHELL_CSS / AGY_CLIENT_JS from lib/ui/shell/ (<= 35 lines)
├── ui.mjs                      # Module resolver + disk-cached CSS/JS concatenation (<= 90 lines)
└── ui/
    ├── shell/
    │   ├── shell.css           # --agy-* adaptive tokens, [data-follow-host], forced-colors (<= 140 lines)
    │   └── shell.js            # window.AgyShell: color parser, luminance, theme sync, SSE, notifyAgent (<= 190 lines)
    ├── core/
    │   ├── core.css            # .agy-icon, .agy-icon-wrap, .hidden, :not(:defined) fail-open guard (<= 30 lines)
    │   ├── icons.js            # Material Symbols SVG registry (including grid_view) + iconSvg / iconEl (<= 120 lines)
    │   ├── html.js             # Zero-build tagged JSX compiler (`html`) + `el()` + `clear()` + `escHtml()` (<= 160 lines)
    │   └── runtime.js          # apiCall(), formatStatusBadge(), formatBadgeLabel(), readHostVisibility() (<= 70 lines)
    ├── tabs/
    │   ├── tabs.css            # .agy-tab-strip, .agy-tab, .agy-tab-overflow-*, .agy-toggle-group (<= 175 lines)
    │   ├── tab-pill.js         # <agy-tab> Custom Element + startInlineRename, createTabPill, updateTabPill (<= 210 lines)
    │   ├── tab-strip.js        # <agy-tab-strip> Custom Element + reconcileTabStrip, setupStripScroll (<= 220 lines)
    │   └── toggle-group.js     # <agy-toggle-group> Custom Element + createToggleGroup (<= 110 lines)
    ├── tab-drag/
    │   ├── tab-drag.css        # .agy-tab-drag-ghost, body.dragging-tab, .is-dragging-source (<= 30 lines)
    │   └── tab-drag.js         # measureStrip, setTabShift, getUnshiftedRect, bindTabDragController (<= 230 lines)
    ├── layout/
    │   ├── layout.css          # .agy-chrome-bar, .agy-toolbar, .agy-split-sash (<= 45 lines)
    │   └── layout.js           # <agy-split-sash> Custom Element + bindSplitResize (<= 100 lines)
    ├── overlays/
    │   ├── overlays.css        # .agy-context-menu, .agy-toast, .agy-consent-bar, .agy-banner (<= 75 lines)
    │   └── overlays.js         # openContextMenu, closeContextMenu, showToast (<= 120 lines)
    ├── controls/
    │   ├── controls.css        # .agy-btn, .agy-icon-btn, .agy-switch, .agy-search-box, .agy-select (<= 105 lines)
    │   └── controls.js         # <agy-switch> Custom Element + renderSwitch (<= 95 lines)
    └── surfaces/
        ├── surfaces.css        # .agy-card, .agy-badge, .agy-status-dot, .agy-count-pill, .agy-empty-state (<= 90 lines)
        └── surfaces.js         # renderCountPill, renderEmptyState (<= 40 lines)
```

### 5.2 Server Assembler (`lib/ui.mjs` & `lib/shell.mjs`)
- `lib/shell.mjs` reads `lib/ui/shell/shell.css` and `lib/ui/shell/shell.js` once at module load and exports `AGY_SHELL_CSS` and `AGY_CLIENT_JS`. `window.Hangar` is **not** created or touched in `shell.js`.
- `lib/ui.mjs` maps each module name in `ALL_AGY_UI_MODULES` (`['core', 'tabs', 'tab-drag', 'layout', 'overlays', 'controls', 'surfaces']`) to its ordered list of `.css` and `.js` files inside `lib/ui/<module>/`.
- Every `lib/ui/<module>/<module>.css` file begins with `/* AgyUI Module: <module> */` so `AGY_UI_CSS_MODULES[module]` and `buildAgyUiCss(modules)` preserve the module banner contract expected by downstream consumers.
- `buildAgyUiCss(modules)` and `buildAgyUiJs(modules)`:
  - Resolve the module list via `resolveAgyUiModules(modules)` (always prepending `'core'`).
  - Concatenate only the `.css` or `.js` files for those modules, plus a 1-line footer on `buildAgyUiJs` recording `window.AgyUI.enabledModules = [...]`.
- `attachAgyUI(globalObj, options)` is preserved as a thin Node helper that normalizes `const win = globalObj?.window || globalObj; const doc = globalObj?.document || win?.document; win.document = doc;` and executes `buildAgyUiJs(options.modules)` with `window` and `document` bound to `win` and `doc` (without `Function.prototype.toString()`).

### 5.3 Tagged JSX Engine (`lib/ui/core/html.js`)
- Provides `AgyUI.html` (and `AgyUI.h` / `AgyUI.el`):
  - Parses standard JSX-like template literals (`<tag attr=${val} onClick=${fn} .prop=${obj} ?disabled=${bool}>${children}</tag>`, self-closing `<tag />`, and `<>...</>` fragments).
  - Caches compiled template ASTs by `TemplateStringsArray` identity (`WeakMap`) so repeated renders have zero re-parse cost.
  - **Attribute & Property Binding Rules:**
    - `on<Event>=${fn}` (e.g., `onClick`, `onKeydown`, `onTabSelect`, `onChange`): registers `el.addEventListener(eventName.slice(2).toLowerCase(), fn)` (and also supports camelCase custom events via a map or standard lowercase DOM event names).
    - `.prop=${val}` (or non-primitive values when `key in el` on custom elements): assigns directly to `el[prop] = val`.
    - `?attr=${bool}` or boolean attributes (`disabled`, `checked`, `hidden`, `selected`, `readonly`, `multiple`): calls `el.toggleAttribute(attr, Boolean(val))`.
    - `dataset=${obj}`: assigns each defined entry into `el.dataset`.
    - `style=${objOrStr}`: supports both string (`el.style.cssText`) and object (`Object.assign(el.style, obj)`).
    - `ref=${fnOrObj}`: calls `fn(el)` or sets `obj.current = el`.
  - **Children Handling:**
    - `null`, `undefined`, `false`, `true` are ignored.
    - `Node` instances are appended directly.
    - Arrays / `Iterable`s are flattened recursively.
    - Strings and numbers are appended via `doc.createTextNode(String(val))` (preventing XSS without manual escaping).
- `AgyUI.escHtml(str)` escapes `&`, `<`, `>`, `"`, and `'` (`&#39;`).

### 5.4 Light-DOM Custom Elements & Backwards-Compatible Wrappers

All custom elements resolve `HTMLElement`, `customElements`, `CustomEvent`, `MutationObserver`, and `ResizeObserver` from `win` (falling back to global scope) so they work identically in browser globals, `vm` contexts, and `linkedom` via `attachAgyUI(win)`. Registration is guarded with `if (ce && BaseElement && !ce.get(name))`, and classes follow the `custom-elements` and `web-components` rules:
- Call `super()` first in `constructor()`.
- Keep setup in `connectedCallback()` idempotent and clean up `ResizeObserver` / `MutationObserver` / window listeners in `disconnectedCallback()`.
- Include fail-open `:not(:defined)` CSS in `core.css` (`opacity: 0; animation: agy-defined-fallback 0.2s 2s forwards`).

1. **`<agy-tab>` (`AgyTabElement` in `lib/ui/tabs/tab-pill.js`):**
   - Renders (or upgrades) a `.agy-tab` button pill with icon slot, label slot, badge, external badge (`extBadgeTitle` configurable via `item.externalTitle || opts.externalTitle || 'Opened externally'`, no hardcoded `"Hangar"`), status dot, pin button, and close button.
   - Supports inline rename via `.startRename(opts)` and dispatches `tab-select`, `tab-close`, `tab-unpin`, `tab-rename`, and `tab-contextmenu` `CustomEvent`s (`bubbles: true`).
   - `AgyUI.createTabPill`, `AgyUI.updateTabPill`, and `AgyUI.startInlineRename` remain available and operate cleanly on standard DOM nodes without test-mock branches.

2. **`<agy-tab-strip>` (`AgyTabStripElement` in `lib/ui/tabs/tab-strip.js`):**
   - Properties: `.tabs` (array of tab descriptors), `.closedTabs` (array of hidden/closed tab descriptors), `.options` (configuration object: `idDatasetKey`, `emptyHint`, `addButton`, `renderOverflowIcon`, callbacks).
   - Manages scroll masks (`mask-left`, `mask-right`, `mask-both`) via `ResizeObserver` + `MutationObserver`, horizontal wheel scrolling, and an optional overflow popover button without referencing `window.Hangar`.
   - `AgyUI.reconcileTabStrip` and `AgyUI.setupStripScroll` delegate to the shared strip reconciliation and scroll/overflow controller logic, with `setupStripScroll` accepting a generic `opts.renderItemIcon(tab)` / `tab.icon` resolver instead of `win.Hangar.tabIconElement`.

3. **`<agy-toggle-group>` (`AgyToggleGroupElement` in `lib/ui/tabs/toggle-group.js`):**
   - Properties/Attributes: `.items` (`[{ id, label, count, title, dataset, disabled }]`), `value` / `activeId`, `layout` (`'inline' | 'grid'`).
   - Dispatches `change` (`CustomEvent('change', { detail: { value: id }, bubbles: true })`) and calls `opts.onChange?.(id, event)`.
   - `AgyUI.createToggleGroup(containerEl, items, opts)` uses the exact same renderer.

4. **`<agy-split-sash>` (`AgySplitSashElement` in `lib/ui/layout/layout.js`):**
   - Attributes: `direction="vertical|horizontal"`, `min-ratio="0.15"`, `max-ratio="0.85"`.
   - Encapsulates pointer capture and dispatches `split-resize-start`, `split-resize` (`detail: { ratio }`), and `split-resize-end`.
   - `AgyUI.bindSplitResize(handleEl, opts)` remains available for existing `<div class="agy-split-sash">` markup.

5. **`<agy-switch>` (`AgySwitchElement` in `lib/ui/controls/controls.js`):**
   - Wraps an accessible `<button type="button" role="switch" class="agy-switch">` (preserving native button focus and keyboard activation).
   - Reflected boolean attributes/properties: `checked`, `disabled`, `size` (`'sm' | 'md'`).
   - Dispatches `change` (`detail: { checked }`) when clicked.

### 5.5 `measureStrip` Contract (`lib/ui/tab-drag/tab-drag.js`)
- Return canonical keys (`sourceTabs`, `draggedIndex`, `draggedWidth`, `draggedHeight`, `grabOffsetX`, `grabOffsetY`, `draggedSlot`, `rects`, `centers`, `stripRect`, `locked`, `lockChangedAt`) alongside backwards-compatible aliases (`items`, `fromIdx`, `offX`, `offY`, `step`) so existing tests and consumers remain non-breaking across waves.

### 5.6 Scaffolder & Skill Template Fixes (`lib/scaffolder.mjs`)
- Update `lib/scaffolder.mjs`:
  - Add `defer` to `<script defer src="/ui.js"></script>` so `/shell.js` and `/ui.js` execute in deterministic order after HTML parsing.
  - Import `registerUiRoutes` from `'antigravity-sidecar-kit/server'`.
  - Use `var(--agy-canvas)` and `var(--agy-ink)` in scaffolded `ui/styles.css`.

### 5.7 Test Architecture (`test/`)
- Add `linkedom` to `devDependencies` in `package.json`.
- Split the 528-line [`test/ui.test.mjs`](../../../test/ui.test.mjs) into focused test files under the 300-line ceiling:
  - `test/ui-core-routes.test.mjs`: route handlers (`/shell.css`, `/shell.js`, `/ui.css`, `/ui.js`, `/ui/<mod>.(css|js)`), `html\`...\`` tagged JSX, `el()`, `escHtml()`, `iconSvg()`.
  - `test/ui-components.test.mjs`: `<agy-tab-strip>`, `<agy-toggle-group>`, `<agy-split-sash>`, `<agy-switch>`, `reconcileTabStrip`, `startInlineRename`, `bindTabDragController`, `openContextMenu`, `showToast` running against a real `linkedom` `Window`/`Document`.

---

## 6. What Is Left to the Builder
- Exact internal helper decomposition inside each `lib/ui/<module>/` file, provided every file stays `<= 250 lines` and exports the public `window.AgyUI` contract.
- Choice between `linkedom` and `happy-dom` in `devDependencies` (defaulting to `linkedom` for minimal install size and fast startup).
