/**
 * @fileoverview Modular Antigravity Sidecar Component Library (AgyUI).
 * Provides opt-in CSS and JS modules ('core', 'tabs', 'tab-drag', 'layout',
 * 'overlays', 'controls', 'surfaces') built on the --agy-* token system.
 */

export const ALL_AGY_UI_MODULES = Object.freeze([
    'core',
    'tabs',
    'tab-drag',
    'layout',
    'overlays',
    'controls',
    'surfaces',
]);

export function resolveAgyUiModules(modules) {
    if (!modules || modules === 'all' || (Array.isArray(modules) && modules.includes('all'))) {
        return [...ALL_AGY_UI_MODULES];
    }
    const list = Array.isArray(modules)
        ? modules
        : String(modules)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    const valid = list.filter((m) => ALL_AGY_UI_MODULES.includes(m));
    if (!valid.includes('core')) valid.unshift('core');
    return [...new Set(valid)];
}

export const AGY_UI_CSS_MODULES = Object.freeze({
    core: `/* AgyUI Module: core */
.agy-icon { flex-shrink: 0; display: inline-block; vertical-align: middle; }
.agy-icon-wrap { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; line-height: 0; }
.hidden { display: none !important; }
`,
    tabs: `/* AgyUI Module: tabs */
.agy-tab-strip {
  display: flex; align-items: center; gap: 1px; flex: 1 1 0%; min-width: 0;
  padding: 4px 0; overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: none;
}
.agy-tab-strip::-webkit-scrollbar { display: none; }
.agy-tab-strip.mask-left { mask-image: linear-gradient(to right, transparent 0px, black 38px); -webkit-mask-image: linear-gradient(to right, transparent 0px, black 38px); }
.agy-tab-strip.mask-right { mask-image: linear-gradient(to left, transparent 0px, black 38px); -webkit-mask-image: linear-gradient(to left, transparent 0px, black 38px); }
.agy-tab-strip.mask-both { mask-image: linear-gradient(to right, transparent 0px, black 38px, black calc(100% - 38px), transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0px, black 38px, black calc(100% - 38px), transparent 100%); }
.agy-tab-strip.drop-target { background: color-mix(in srgb, var(--agy-accent) 16%, transparent); outline: 1px dashed var(--agy-accent); }
.agy-tab-strip-sm { height: 32px; padding: 2px 0; gap: 1px; border-radius: var(--radius-md, 0.375rem); }
.agy-tab {
  position: relative; display: inline-flex; align-items: center; gap: 4px;
  height: 28px; overflow: hidden; padding: 4px 8px 4px 6px;
  border-radius: var(--radius-lg, 0.5rem); border: none; outline: none;
  background: transparent; color: var(--agy-ink-soft); font-family: inherit;
  font-size: var(--text-sm, 0.875rem); line-height: 1.25rem;
  font-weight: var(--font-weight-normal, 400); cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease), transform 150ms ease;
}
.agy-tab:hover { background: var(--agy-hover); color: var(--agy-ink); }
.agy-tab.active { background: var(--agy-control); color: var(--agy-ink); }
.agy-tab-icon {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; flex-shrink: 0;
}
.agy-tab-label { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agy-tab-badge { opacity: 0.78; font-size: var(--text-sm, 0.875rem); line-height: 1.25rem; flex-shrink: 0; }
.agy-tab-ext-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; border-radius: 3px;
  color: #60a5fa; background: rgba(59, 130, 246, 0.12); flex-shrink: 0;
}
.agy-tab-pin {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-left: 2px; border-radius: 4px;
  color: var(--agy-ink-soft); background: transparent; border: none; padding: 0;
  outline: none; cursor: pointer; flex-shrink: 0;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease);
}
.agy-tab-pin:hover { color: var(--agy-ink); background: var(--agy-rule); }
.agy-tab-close-wrap {
  position: absolute; top: 0; bottom: 0; right: 0; z-index: 10;
  display: flex; align-items: center; padding-left: 16px; padding-right: 6px;
  border-top-right-radius: var(--radius-lg, 0.5rem); border-bottom-right-radius: var(--radius-lg, 0.5rem);
  background: linear-gradient(to right, transparent 0%, var(--agy-hover) 25%);
  opacity: 0; pointer-events: none; transition: opacity var(--agy-dur) var(--agy-ease);
}
.agy-tab.active .agy-tab-close-wrap {
  background: linear-gradient(to right, transparent 0%, var(--agy-control) 25%);
}
.agy-tab:hover .agy-tab-close-wrap,
.agy-tab:focus-visible .agy-tab-close-wrap,
.agy-tab:has(:focus-visible) .agy-tab-close-wrap { opacity: 1; pointer-events: auto; }
.agy-tab[data-pinned="true"] .agy-tab-close-wrap { display: none !important; }
.agy-tab-close {
  display: flex; align-items: center; justify-content: center; padding: 2px;
  border-radius: 4px; color: var(--agy-ink-soft); background: transparent;
  border: none; outline: none; cursor: pointer; flex-shrink: 0;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease);
}
.agy-tab-close:hover { color: var(--agy-ink); background: var(--agy-rule); }
.agy-tab-add-btn { margin-left: 2px; flex-shrink: 0; }
.agy-tab-drop-hint { font-size: var(--text-xs, 0.75rem); color: var(--agy-ink-soft); padding: 0 8px; user-select: none; }
.agy-tab-rename-input,
.agy-rename-input {
  width: 100px; height: 20px; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--agy-accent); background: var(--agy-canvas);
  color: var(--agy-ink); font-family: inherit; font-size: 12px; outline: none;
}
.agy-tab-overflow-btn { margin-left: 2px; flex-shrink: 0; }
.agy-tab-overflow-btn.has-hidden-tabs {
  width: auto; padding: 0 6px; gap: 3px;
  background: color-mix(in srgb, var(--agy-control) 55%, transparent); color: var(--agy-ink-soft);
}
.agy-tab-overflow-btn.has-hidden-tabs:hover { background: var(--agy-control); color: var(--agy-ink); }
.agy-tab-overflow-badge { font-size: 11px; line-height: 1; font-weight: 500; font-variant-numeric: tabular-nums; }
.agy-tab-overflow-popover {
  position: fixed; inset: auto; padding: 4px; border-radius: var(--radius-lg, 0.5rem);
  border: 1px solid var(--agy-rule); background: var(--agy-card); color: var(--agy-ink);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
  width: 220px; max-height: 20rem; overflow-y: auto; user-select: none; z-index: 2600;
}
.agy-tab-overflow-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; padding: 6px 8px; border-radius: var(--radius-md, 0.375rem);
  border: none; outline: none; background: transparent; color: var(--agy-ink-soft);
  font-family: inherit; font-size: var(--text-xs, 0.75rem); line-height: 1rem;
  cursor: pointer; text-align: left;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease), opacity var(--agy-dur) var(--agy-ease);
}
.agy-tab-overflow-item:hover { background: var(--agy-hover); color: var(--agy-ink); }
.agy-tab-overflow-item.active { background: var(--agy-control); color: var(--agy-ink); font-weight: var(--font-weight-medium, 500); }
.agy-tab-overflow-item.is-hidden-tab { opacity: 0.78; }
.agy-tab-overflow-item.is-hidden-tab:hover { opacity: 1; }
.agy-tab-overflow-restore {
  font-size: 10px; line-height: 14px; padding: 1px 5px; border-radius: 4px;
  background: var(--agy-control); color: var(--agy-ink); opacity: 0.65; flex-shrink: 0;
}
.agy-tab-overflow-item.is-hidden-tab:hover .agy-tab-overflow-restore { opacity: 1; }
.agy-tab-overflow-item-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.agy-tab-overflow-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agy-tab-overflow-section {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 8px 2px; font-size: 10px; font-weight: 600;
  color: var(--agy-ink-soft); text-transform: uppercase; letter-spacing: 0.04em;
  border-top: 1px solid var(--agy-rule); margin-top: 2px;
}
.agy-tab-overflow-section:first-child { border-top: none; margin-top: 0; padding-top: 2px; }
.agy-toggle-group {
  display: inline-flex; align-items: center; border-radius: var(--radius-lg, 0.5rem);
  border: 1px solid var(--agy-rule);
  background: color-mix(in srgb, var(--agy-control) 20%, transparent);
  padding: 2px; gap: 2px; user-select: none;
}
.agy-toggle-group-grid {
  display: grid; grid-template-columns: repeat(var(--agy-toggle-cols, 3), minmax(0, 1fr)); width: 100%;
}
.agy-toggle-item {
  display: inline-flex; align-items: center; justify-content: center;
  height: 22px; padding: 0 8px; gap: 4px; border-radius: var(--radius-md, 0.375rem);
  border: none; outline: none; background: transparent; color: var(--agy-ink-soft);
  font-family: inherit; font-size: var(--text-xs, 0.75rem); line-height: 1rem;
  font-weight: var(--font-weight-medium, 500); cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease);
}
.agy-toggle-item:hover:not(:disabled) { color: var(--agy-ink); }
.agy-toggle-item:disabled { opacity: 0.5; pointer-events: none; cursor: default; }
.agy-toggle-item.active { background: var(--agy-control); color: var(--agy-ink); }
`,
    'tab-drag': `/* AgyUI Module: tab-drag */
body.dragging-tab, body.dragging-tab * { cursor: grabbing !important; user-select: none !important; }
body.dragging-tab iframe { pointer-events: none !important; }
.agy-tab.is-dragging-source { opacity: 0 !important; pointer-events: none; }
.agy-tab.is-dragging { opacity: 0.45; }
.agy-tab-drag-ghost {
  position: fixed !important; z-index: 8600; pointer-events: none; overflow: hidden;
  border-radius: var(--radius-lg, 0.5rem); background: var(--agy-hover) !important;
  color: var(--agy-ink) !important; border: 1px solid var(--agy-rule);
  box-shadow: none; transform: none !important; margin: 0 !important;
}
.agy-tab-drag-ghost .agy-tab-close-wrap { display: none !important; }
`,
    layout: `/* AgyUI Module: layout */
.agy-chrome-bar {
  display: flex; align-items: center; gap: 2px; height: 40px; min-height: 40px;
  padding: 0 8px 0 6px; background: var(--agy-canvas);
  border-bottom: 1px solid var(--agy-rule); user-select: none;
}
.agy-chrome-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.agy-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; border-bottom: 1px solid var(--agy-rule);
  background: var(--agy-sunken); flex-shrink: 0; flex-wrap: wrap;
}
.agy-split-sash {
  position: relative; z-index: 20; height: 8px; margin: -3px 0 -4px 0;
  flex-shrink: 0; cursor: row-resize; background: transparent;
  touch-action: none; display: flex; align-items: center; justify-content: center;
}
.agy-split-sash .sash-line {
  width: 100%; height: 1px; background: var(--agy-rule);
  transition: height var(--agy-dur) var(--agy-ease), opacity var(--agy-dur) var(--agy-ease);
  pointer-events: none;
}
.agy-split-sash:hover .sash-line,
body.resizing-split .agy-split-sash .sash-line { height: 7px; opacity: 0.5; }
.agy-split-sash-v {
  width: 6px; height: 100%; margin: 0 -3px; cursor: col-resize;
  flex-shrink: 0; position: relative; z-index: 20; background: transparent; touch-action: none;
}
body.resizing-split { cursor: row-resize !important; user-select: none !important; }
body.resizing-split iframe { pointer-events: none !important; }
`,
    overlays: `/* AgyUI Module: overlays */
.agy-context-menu {
  position: fixed; z-index: 8800; min-width: 168px; padding: 4px;
  border-radius: 10px; border: 1px solid var(--agy-rule);
  background: var(--agy-card); color: var(--agy-ink);
  box-shadow: 0 6px 16px -2px rgba(0, 0, 0, 0.28), 0 2px 6px -1px rgba(0, 0, 0, 0.18);
  display: flex; flex-direction: column; gap: 1px; user-select: none; outline: none;
}
.agy-context-menu-item {
  width: 100%; padding: 5px 8px; border: none; border-radius: 6px;
  background: transparent; color: var(--agy-ink); font-family: inherit;
  font-size: 13px; line-height: 18px; text-align: left; cursor: pointer;
  display: flex; align-items: center; gap: 6px; outline: none;
  transition: background-color 100ms ease, color 100ms ease;
}
.agy-context-menu-item:hover:not(:disabled),
.agy-context-menu-item:focus-visible:not(:disabled) {
  background: var(--agy-control); color: var(--agy-ink);
}
.agy-context-menu-item:disabled { opacity: 0.45; cursor: not-allowed; }
.agy-context-menu-item.danger { color: var(--agy-bad); }
.agy-context-menu-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agy-context-menu-check { margin-left: 6px; color: var(--agy-accent); }
.agy-context-menu-sep { height: 1px; margin: 3px 4px; background: var(--agy-rule); }
.agy-toast {
  position: fixed; right: 12px; bottom: 12px; z-index: 9500;
  padding: 6px 10px; border-radius: 5px; background: var(--agy-card);
  color: var(--agy-ink); border: 1px solid var(--agy-accent); font-size: 11px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); pointer-events: none;
}
.agy-toast.error { border-color: var(--agy-bad); color: var(--agy-bad); }
.agy-consent-bar {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 8px; margin-top: 8px; padding: 8px 10px; border-radius: var(--radius-md, 0.375rem);
  background: rgba(243, 201, 73, 0.1); border: 1px solid rgba(243, 201, 73, 0.3);
  font-size: var(--text-xs, 0.75rem); color: var(--agy-ink);
}
.agy-banner {
  padding: 8px 10px; border-radius: var(--radius-lg, 0.5rem);
  font-size: var(--text-xs, 0.75rem); margin-bottom: 10px;
  border: 1px solid var(--agy-rule); background: transparent; color: var(--agy-ink);
}
.agy-banner.ok, .agy-banner.is-success {
  border-color: rgba(99, 152, 79, 0.3); background: rgba(99, 152, 79, 0.12);
  color: var(--status-ok, var(--agy-ok));
}
.agy-banner.warn, .agy-banner.is-warning {
  border-color: rgba(243, 201, 73, 0.3); background: rgba(243, 201, 73, 0.1);
  color: var(--status-warn, var(--agy-warn));
}
.agy-banner.err, .agy-banner.is-error {
  border-color: rgba(222, 85, 85, 0.3); background: rgba(222, 85, 85, 0.12);
  color: var(--status-err, var(--agy-err, var(--agy-bad)));
}
.agy-banner.update, .agy-banner.is-info, .agy-banner.accent, [data-role="hangar-update-banner"].agy-banner {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 8px; padding: 8px 12px;
  background: color-mix(in srgb, var(--agy-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--agy-accent) 35%, transparent);
  color: var(--agy-ink);
}
`,
    controls: `/* AgyUI Module: controls */
.agy-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: var(--radius-md, 0.375rem);
  border: none; outline: none; background: transparent; color: var(--agy-ink-soft);
  cursor: pointer; flex-shrink: 0; padding: 0;
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease);
}
.agy-icon-btn:hover:not(:disabled),
.agy-icon-btn:focus-visible:not(:disabled),
.agy-icon-btn.active { background: var(--agy-control); color: var(--agy-ink); }
.agy-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.agy-icon-btn.spinning svg { animation: agy-spin 0.8s linear infinite; }
@keyframes agy-spin { to { transform: rotate(360deg); } }
.agy-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 24px; padding: 0 8px; gap: 4px; border-radius: var(--radius-md, 0.375rem);
  font-family: inherit; font-size: var(--text-xs, 0.75rem); line-height: 1rem;
  font-weight: var(--font-weight-medium, 500); border: none; outline: none;
  cursor: pointer; user-select: none; white-space: nowrap;
  background: var(--agy-control); color: var(--agy-ink-soft);
  transition: background-color var(--agy-dur) var(--agy-ease), color var(--agy-dur) var(--agy-ease), opacity var(--agy-dur) var(--agy-ease);
}
.agy-btn.has-icon { padding-left: 6px; padding-right: 8px; gap: 4px; }
.agy-btn:hover:not(:disabled) { color: var(--agy-ink); }
.agy-btn:disabled { opacity: 0.5; pointer-events: none; cursor: default; }
.agy-btn.active,
.agy-btn[aria-pressed="true"] { background: var(--agy-control); color: var(--agy-ink); }
.agy-btn-primary,
.agy-btn.primary {
  background: var(--agy-accent); color: var(--primary-foreground, #ffffff);
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}
.agy-btn-primary:hover:not(:disabled),
.agy-btn.primary:hover:not(:disabled) {
  background: var(--agy-accent); color: var(--primary-foreground, #ffffff); opacity: 0.9;
}
.agy-btn-secondary { background: var(--agy-control); color: var(--agy-ink-soft); }
.agy-btn-secondary:hover:not(:disabled) { color: var(--agy-ink); }
.agy-btn-outline,
.agy-btn.outline { background: transparent; border: 1px solid var(--agy-rule); color: var(--agy-ink-soft); }
.agy-btn-outline:hover:not(:disabled),
.agy-btn.outline:hover:not(:disabled) { background: var(--agy-control); color: var(--agy-ink); }
.agy-btn-danger,
.agy-btn.danger { background: rgba(222, 85, 85, 0.12); color: var(--status-err, var(--agy-err, var(--agy-bad))); }
.agy-btn-danger:hover:not(:disabled),
.agy-btn.danger:hover:not(:disabled) { background: rgba(222, 85, 85, 0.22); color: var(--status-err, var(--agy-err, var(--agy-bad))); }
.agy-btn-ghost { background: transparent; color: var(--agy-ink-soft); }
.agy-btn-ghost:hover:not(:disabled) { background: var(--agy-control); color: var(--agy-ink); }
.agy-switch {
  position: relative; display: inline-flex; align-items: center;
  width: 44px; height: 24px; border-radius: 9999px;
  background: var(--agy-control); border: none; padding: 0;
  cursor: pointer; transition: background-color 200ms ease-in-out; flex-shrink: 0;
}
.agy-switch.on, .agy-switch[aria-checked="true"] { background: var(--agy-accent); }
.agy-switch:disabled,
.agy-switch.disabled { opacity: 0.4; cursor: not-allowed; }
.agy-switch-thumb {
  display: inline-block; width: 16px; height: 16px; border-radius: 9999px;
  background: #ffffff; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  transform: translateX(4px); transition: transform 200ms ease-in-out; pointer-events: none;
}
.agy-switch.on .agy-switch-thumb,
.agy-switch[aria-checked="true"] .agy-switch-thumb { transform: translateX(24px); }
.agy-switch.sm { width: 28px; height: 16px; }
.agy-switch.sm .agy-switch-thumb { width: 12px; height: 12px; transform: translateX(2px); }
.agy-switch.sm.on .agy-switch-thumb,
.agy-switch.sm[aria-checked="true"] .agy-switch-thumb { transform: translateX(14px); }
.agy-search-box {
  position: relative; display: flex; align-items: center; gap: 6px;
  flex: 1; min-width: 180px;
}
.agy-search-box svg,
.agy-search-icon { position: absolute; left: 10px; color: var(--agy-ink-soft); pointer-events: none; display: inline-flex; }
.agy-search-box:focus-within svg,
.agy-search-box:focus-within .agy-search-icon { color: var(--agy-ink); }
.agy-search-input {
  width: 100%; height: 28px; padding: 0 10px 0 30px; border-radius: var(--radius-lg, 0.5rem);
  border: 1px solid var(--agy-rule); background: var(--agy-card); color: var(--agy-ink);
  font-family: inherit; font-size: var(--text-xs, 0.75rem); outline: none;
  transition: border-color var(--agy-dur) var(--agy-ease);
}
.agy-search-input::placeholder { color: var(--agy-ink-soft); }
.agy-search-input:focus { border-color: var(--agy-accent); }
.agy-select {
  height: 28px; padding: 2px 8px; border-radius: var(--radius-lg, 0.5rem);
  border: 1px solid var(--agy-rule); background: var(--agy-card);
  color: var(--agy-ink); font-family: inherit; font-size: var(--text-xs, 0.75rem);
  outline: none; cursor: pointer;
}
`,
    surfaces: `/* AgyUI Module: surfaces */
.agy-card {
  padding: 12px; border-radius: var(--radius-xl, 0.75rem);
  border: 1px solid var(--agy-rule); background: var(--agy-card); margin-bottom: 8px;
}
.agy-card-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
.agy-card-title {
  display: flex; align-items: center; gap: 8px; font-weight: var(--font-weight-medium, 500);
  font-size: var(--text-sm, 0.875rem); line-height: 1.25rem; color: var(--agy-ink); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.agy-card-desc { font-size: var(--text-xs, 0.75rem); line-height: 1.5; color: var(--agy-ink-soft); margin-bottom: 10px; }
.agy-card-meta { display: flex; align-items: center; gap: 6px; font-family: var(--agy-font-mono, monospace); font-size: 11px; color: var(--agy-ink-soft); }
.agy-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.agy-card-section-bar {
  grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 4px 2px 2px; border-bottom: 1px solid var(--agy-rule);
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--agy-ink-soft);
}
.agy-badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
  border-radius: 9999px; font-family: inherit; font-size: 11px; line-height: 16px;
  font-weight: var(--font-weight-medium, 500); border: none; flex-shrink: 0;
  white-space: nowrap; background: rgba(142, 142, 142, 0.12); color: var(--agy-ink-soft);
}
.agy-badge-dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; flex-shrink: 0; }
.agy-badge.running, .agy-badge.ready, .agy-badge.ok, .agy-badge.is-Connected {
  background: rgba(99, 152, 79, 0.12); color: var(--status-ok, var(--cm-green, var(--agy-ok)));
}
.agy-badge.running .agy-badge-dot, .agy-badge.ready .agy-badge-dot,
.agy-badge.ok .agy-badge-dot, .agy-badge.is-Connected .agy-badge-dot {
  background: var(--status-ok-dot, var(--cm-green-dot, var(--agy-ok)));
}
.agy-badge.hibernated, .agy-badge.warn, .agy-badge.is-Reconnecting {
  background: rgba(243, 201, 73, 0.12); color: var(--status-warn, var(--cm-yellow, var(--agy-warn)));
}
.agy-badge.hibernated .agy-badge-dot, .agy-badge.warn .agy-badge-dot,
.agy-badge.is-Reconnecting .agy-badge-dot {
  background: var(--status-warn-dot, var(--cm-yellow, var(--agy-warn)));
}
.agy-badge.stopped, .agy-badge.off, .agy-badge.builtin {
  background: rgba(142, 142, 142, 0.12); color: var(--agy-ink-soft);
}
.agy-badge.stopped .agy-badge-dot, .agy-badge.off .agy-badge-dot { background: var(--agy-ink-soft); }
.agy-badge.errored, .agy-badge.error, .agy-badge.crit, .agy-badge.is-Disconnected {
  background: rgba(222, 85, 85, 0.12); color: var(--status-err, var(--cm-red, var(--agy-err, var(--agy-bad))));
}
.agy-badge.errored .agy-badge-dot, .agy-badge.error .agy-badge-dot,
.agy-badge.crit .agy-badge-dot, .agy-badge.is-Disconnected .agy-badge-dot {
  background: var(--status-err-dot, var(--cm-red, var(--agy-err, var(--agy-bad))));
}
.agy-badge.starting, .agy-badge.active, .agy-badge.update, .agy-badge.accent {
  background: rgba(67, 128, 180, 0.12); color: var(--status-info, var(--cm-blue, var(--agy-info, var(--agy-accent))));
}
.agy-badge.starting .agy-badge-dot, .agy-badge.active .agy-badge-dot,
.agy-badge.update .agy-badge-dot, .agy-badge.accent .agy-badge-dot {
  background: var(--status-info-dot, var(--cm-blue-dot, var(--agy-info, var(--agy-accent))));
}
.agy-status-dot { width: 6px; height: 6px; border-radius: 9999px; background: var(--agy-ink-soft); flex-shrink: 0; }
.agy-status-dot.running { background: var(--status-ok-dot, var(--agy-ok)); }
.agy-status-dot.hibernated { background: var(--status-warn-dot, var(--agy-warn)); }
.agy-status-dot.errored { background: var(--status-err-dot, var(--agy-err, var(--agy-bad))); }
.agy-status-dot.update { background: var(--status-info-dot, var(--agy-info, var(--agy-accent))); }
.agy-count-pill {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px;
  padding: 2px 8px; border-radius: 9999px; background: var(--agy-sunken);
  color: var(--agy-ink-soft); font-weight: var(--font-weight-normal, 400);
}
.agy-empty,
.agy-empty-state {
  padding: 32px 16px; text-align: center; color: var(--agy-ink-soft);
  font-size: var(--text-xs, 0.75rem); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
}
`,
});

export function buildAgyUiCss(modules = 'all') {
    const selected = resolveAgyUiModules(modules);
    return selected.map((m) => AGY_UI_CSS_MODULES[m] || '').filter(Boolean).join('\n');
}

export const AGY_UI_CSS = buildAgyUiCss('all');

export function attachAgyUI(globalObj = globalThis, options = {}) {
    const win = globalObj.window || globalObj;
    const doc = globalObj.document || win.document;
    const allMods = ['core', 'tabs', 'tab-drag', 'layout', 'overlays', 'controls', 'surfaces'];
    const rawMods = options.modules;
    const modList =
        !rawMods || rawMods === 'all' || (Array.isArray(rawMods) && rawMods.includes('all'))
            ? allMods
            : (Array.isArray(rawMods) ? rawMods : String(rawMods).split(',').map((s) => s.trim())).filter((m) =>
                allMods.includes(m)
            );
    if (!modList.includes('core')) modList.unshift('core');
    const selected = new Set(modList);
    const ui = (win.AgyUI = win.AgyUI || {});
    ui.enabledModules = [...selected];

    // --- 1. Core Module ---
    const ICONS = (ui.ICONS = ui.ICONS || {
        folder:
            'M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80,80H787.69Q818-700 839-679t21,51.31v375.38Q860-222 839-201t-51.31,21H172.31Zm0-60H787.69q5.39,0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39,0-8.85,3.46T160-707.69v455.38q0,5.39 3.46,8.85t8.85,3.46Z',
        globe:
            'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm0-82q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z',
        keep:
            'M620-471.54L691.54-400v60H510v220L480-90l-30-30V-340H268.46v-60L340-471.54V-760H300v-60H660v60H620v288.46ZM354-400H606l-46-46V-760H400v314l-46,46Zm126,0Z',
        extension:
            'M208.85-197.69H713.46q3.85,0 6.35-2.69t2.5-6.54V-383.23l36.92-15.85q18.31-6.85 29.54-23.54T800-461.15q0-21.62-11.23-38.42t-29.54-24.04l-36.92-15.23V-715.38q0-4.23-2.5-6.73t-6.35-2.5H534.92l-7.31-51.08q-3.77-25.85-22.38-43.92t-44.08-18.08q-26.08,0-44.69,18.08t-22.38,43.92l-7.31,51.08H208.46q-3.46,0-5.96,2.5t-2.5,6.73V-624q51.77,17.15 84.15,62.04t32.38,100.81q0,57.31-32.19,102.19T200-297.69v90.77q0,3.85 2.5,6.54t6.35,2.69Zm0,60q-29,0-48.92-20.12T140-206.92V-347q48-1.54 82.27-33.58t34.27-80.58q0-45.62-34.46-78.12T140-575.69V-715.38q0-28.77 20.04-49t48.42-20.23H334.69q6.62-47.92 42.15-80.5t84.31-32.58q48.15,0 83.69,32.58t42.77,80.5H713.46q28.38,0 48.61,20.23t20.23,49v136.69q34.85,14.15 56.27,46.23T860-461.15q0,39.08-21.42,70.96t-56.27,46.58v136.69q0,29-20.23,49.11t-48.61,20.12H208.85Z',
        splitscreen:
            'M212.31-527.31q-30.31,0-51.31-21t-21-51.31V-747.69Q140-778 161-799t51.31-21H747.69Q778-820 799-799t21,51.31v148.08q0,30.31-21,51.31t-51.31,21H212.31Zm0-60H747.69q5.39,0 8.85-3.46t3.46-8.85V-747.69q0-5.39-3.46-8.85T747.69-760H212.31q-5.39,0-8.85,3.46T200-747.69v148.08q0,5.39 3.46,8.85t8.85,3.46Zm0,447.31Q182-140 161-161t-21-51.31V-360q0-30.31 21-51.31t51.31-21H747.69q30.31,0 51.31,21T820-360v147.69Q820-182 799-161t-51.31,21H212.31Zm0-60H747.69q5.39,0 8.85-3.46t3.46-8.85V-360q0-5.39-3.46-8.85t-8.85-3.46H212.31q-5.39,0-8.85,3.46T200-360v147.69q0,5.39 3.46,8.85t8.85,3.46Z',
        splitscreen_vertical_add:
            'M180-160q-24.75 0-42.37-17.63Q120-195.25 120-220v-520q0-24.75 17.63-42.38Q155.25-800 180-800h210q24.75 0 42.38 17.62Q450-764.75 450-740v520q0 24.75-17.62 42.37Q414.75-160 390-160H180Zm0-60h210v-520H180v520Zm390 60q-24.75 0-42.38-17.63Q510-195.25 510-220v-520q0-24.75 17.62-42.38Q545.25-800 570-800h210q24.75 0 42.38 17.62Q840-764.75 840-740v210h-60v-210H570v520h110v60H570Zm180-40v-100H650v-60h100v-100h60v100h100v60H810v100h-60Z',
        add:
            'M450-450H250q-12.75,0-21.37-8.63T220-480.01t8.62-21.37T250-510H450V-710q0-12.75 8.63-21.37T480.01-740t21.37,8.62T510-710v200H710q12.75,0 21.37,8.63T740-479.99t-8.62,21.37T710-450H510v200q0,12.75-8.63,21.37T479.99-220t-21.37-8.62T450-250V-450Z',
        play_arrow:
            'M340-236.16V-723.84L723.07-480L340-236.16ZM400-480Zm0,134L610.77-480L400-614v268Z',
        pause:
            'M530-220V-740H740v520H530Zm-310,0V-740H430v520H220Zm370-60h90V-680H590v400Zm-310,0h90V-680H280v400Z',
        refresh:
            'M481.54-180q-125.62,0-212.81-87.17T181.54-479.94t87.19-212.83T481.54-780q70.15,0 132.77,31.19t104.15,88.04V-780h60v244.61H533.85v-60h158q-31.62-57.92-87.69-91.27T481.54-720q-100,0-170,70t-70,170t70,170t170,70q77,0 139-44t87-116h63.23Q743.54-302.08 663.5-241.04T481.54-180Z',
        close:
            'M480-437.85L277.08-234.92q-8.31,8.31-20.88,8.5t-21.27-8.5T226.23-256t8.69-21.08L437.85-480L234.92-682.92q-8.31-8.31-8.5-20.88t8.5-21.27T256-733.77t21.08,8.69L480-522.15L682.92-725.08q8.31-8.31 20.88-8.5t21.27,8.5T733.77-704t-8.69,21.08L522.15-480L725.08-277.08q8.31,8.31 8.5,20.88t-8.5,21.27T704-226.23t-21.08-8.69L480-437.85Z',
        bolt:
            'M422-232L629-480H469l29-227L313-440H452L422-232ZM343.08-102.31l40-277.69h-185L527.69-855.77h49.23L537.31-540h220l-365,437.69H343.08Z',
        check:
            'M382-339.38L727.54-684.92q8.92-8.92 20.88-9.12t21.27,9.12T779-663.54t-9.31,21.38l-362.38,363Q396.46-268.31 382-268.31t-25.31-10.85l-167-167q-8.92-8.92-8.81-21.19t9.42-21.58t21.38-9.31t21.38,9.31L382-339.38Z',
        code_blocks:
            'M384-349.85l42.15-42.77L338.77-480l87-87l-42.15-42.77L253.85-480L384-349.85Zm192,0L706.15-480L576-610.15l-42.15,42.77L621.23-480l-87.38,87.38L576-349.85ZM212.31-140Q182-140 161-161t-21-51.31V-747.69Q140-778 161-799t51.31-21H747.69Q778-820 799-799t21,51.31v535.38Q820-182 799-161t-51.31,21H212.31Zm0-60H747.69q4.62,0 8.46-3.85t3.85-8.46V-747.69q0-4.62-3.85-8.46T747.69-760H212.31q-4.62,0-8.46,3.85T200-747.69v535.38q0,4.62 3.85,8.46t8.46,3.85Z',
        dock_to_right:
            'M212.31-140q-29.92,0-51.11-21.19T140-212.31V-747.69q0-29.92 21.19-51.11T212.31-820H747.69q29.92,0 51.11,21.19T820-747.69v535.38q0,29.92-21.19,51.11T747.69-140H212.31ZM320-200V-760H212.31q-4.62,0-8.46-3.85T200-747.69v535.38q0,4.62 3.85,8.46t8.46,3.85H320Zm60,0H747.69q4.62,0 8.46-3.85t3.85-8.46V-747.69q0-4.62-3.85-8.46T747.69-760H380v560Z',
        delete:
            'M280-120q-33,0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0,33-23.5,56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160,0h80v-360h-80v360ZM280-720v520-520Z',
        download:
            'M480-320L280-520l56-58l104,104v-326h80v326l104-104l56,58L480-320ZM240-160q-33,0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0,33-23.5,56.5T720-160H240Z',
        link:
            'M440-280H280q-83,0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50,0-85,35t-35,85q0,50 35,85t85,35h160v80ZM320-440v-80h320v80H320Zm200,160v-80h160q50,0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83,0 141.5,58.5T880-480q0,83-58.5,141.5T680-280H520Z',
        search:
            'M784-120L532-372q-30,24-69,38t-83,14q-109,0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109,0 184.5,75.5T640-580q0,44-14,83t-38,69l252,252l-56,56ZM380-400q75,0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75,0-127.5,52.5T200-580q0,75 52.5,127.5T380-400Z',
        verified:
            'M344-60L268-188l-144-32l14-148L40-480l98-112l-14-148l144-32l76-128l136,58l136-58l76,128l144,32l-14,148l98,112l-98,112l14,148l-144,32l-76,128l-136-58l-136,58Zm94-278l226-226l-56-58l-170,170l-86-84l-56,56l142,142Z',
        shield:
            'M480-80q-139-35-229.5-159.5T160-516v-244l320-120l320,120v244q0,152-90.5,276.5T480-80Zm0-84q104-33 172-132t68-220v-189l-240-90l-240,90v189q0,121 68,220t172,132Zm0-316Z',
        settings:
            'M370-80l-16-128q-13-5-24.5-12T307-235l-119,50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190l119,50q11-8 23-15t24-12l16-128h220l16,128q13,5 24.5,12t22.5,15l119-50l110,190l-103,78q1,7 1,13.5v27q0,6.5-2,13.5l103,78l-110,190l-118-50q-11,8-23,15t-24,12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99,41l39-68l-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65l-39-68l-99,42q-22-23-48.5-38.5T533-694l-13-106h-79l-14,106q-31,8-57.5,23.5T321-633l-99-41l-39,68l86,64q-5,15-7,30t-2,32q0,16 2,31t7,30l-86,65l39,68l99-42q22,23 48.5,38.5T427-266l13,106Zm42-180q58,0 99-41t41-99q0-58-41-99t-99-41q-59,0-99.5,41T342-480q0,58 40.5,99t99.5,41Zm-2-140Z',
        terminal:
            'M160-160q-33,0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33,0 56.5,23.5T880-720v480q0,33-23.5,56.5T800-160H160Zm0-80h640v-400H160v400Zm140-40l-56-56l103-104l-104-104l57-56l160,160l-160,160Zm180,0v-80h240v80H480Z',
        chat:
            'M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z',
        open_in_new:
            'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z',
        expand_more:
            'M480-345 240-585l56-56 184 183 184-183 56 56-240 240Z',
        overview:
            'M290-290H550v-60H290v60Zm0-160H670v-60H290v60Zm0-160H670v-60H290v60ZM212.31-140Q182-140 161-161t-21-51.31V-747.69Q140-778 161-799t51.31-21H747.69Q778-820 799-799t21,51.31v535.38Q820-182 799-161t-51.31,21H212.31Zm0-60H747.69q4.62,0 8.46-3.85t3.85-8.46V-747.69q0-4.62-3.85-8.46T747.69-760H212.31q-4.62,0-8.46,3.85T200-747.69v535.38q0,4.62 3.85,8.46t8.46,3.85Z',
        warning:
            'M40-120l440-760 440 760H40Zm138-80h604L480-720 178-200Zm302-40q17 0 28.5-11.5T520-280q0-17-11.5-28.5T480-320q-17 0-28.5 11.5T440-280q0 17 11.5 28.5T480-240Zm-40-120h80v-200h-80v200Z',
        error:
            'M480-280q17 0 28.5-11.5T520-320q0-17-11.5-28.5T480-360q-17 0-28.5 11.5T440-320q0 17 11.5 28.5T480-280Zm-40-160h80v-240h-80v240Zm40 360q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z',
        restart_alt:
            'M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z',
    });

    ui.registerIcons = function registerIcons(customMap = {}) {
        Object.assign(ICONS, customMap);
    };

    ui.VISIBILITY_MESSAGE_TYPE = 'sidecar-visibility';

    ui.escHtml = function escHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    };

    ui.clear = function clear(el) {
        if (!el) return;
        if (typeof el.replaceChildren === 'function') el.replaceChildren();
        else el.innerHTML = '';
    };

    ui.iconSvg = function iconSvg(name, size = 16, className = '') {
        const cls = ['agy-icon', className].filter(Boolean).join(' ');
        if (name === 'terminal') {
            return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" class="${cls}" aria-hidden="true"><path transform="translate(18.775, 19.85) rotate(-180)" d="M10.925 14.05L11.975 13L8.9 9.925L11.975 6.85L10.925 5.8L6.8 9.925L10.925 14.05Z" fill="currentColor"/><path d="M11.675 14.95H16.175V13.45H11.675V14.95Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3 5.25C3 4.00736 4.00736 3 5.25 3H18.75C19.9926 3 21 4.00736 21 5.25V18.75C21 19.9926 19.9926 21 18.75 21H5.25C4.00736 21 3 19.9926 3 18.75V5.25ZM5.25 4.5C4.83579 4.5 4.5 4.83579 4.5 5.25V18.75C4.5 19.1642 4.83579 19.5 5.25 19.5H18.75C19.1642 19.5 19.5 19.1642 19.5 18.75V5.25C19.5 4.83579 19.1642 4.5 18.75 4.5H5.25Z" fill="currentColor"/></svg>`;
        }
        const d = ICONS[name] || ICONS.code_blocks;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" class="${cls}" aria-hidden="true"><path d="${d}"/></svg>`;
    };

    ui.iconEl = function iconEl(name, size = 16, className = '') {
        const wrap = doc.createElement('span');
        wrap.className = 'agy-icon-wrap';
        wrap.innerHTML = ui.iconSvg(name, size, className);
        return wrap.firstElementChild;
    };

    ui.apiCall = async function apiCall(path, body = {}) {
        const fn = win.sidecar?.fetch || win.fetch.bind(win);
        const urlToken = new URLSearchParams(win.location?.search || '').get('token') || win.__AGY_TOKEN__ || '';
        const res = await fn(path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(urlToken ? { 'X-Sidecar-Token': urlToken } : {}),
            },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
    };

    ui.formatStatusBadge = function formatStatusBadge(rawBadge = '', isRunning = false, isErrored = false) {
        if (isRunning || rawBadge === 'RUNNING') return { label: 'Running', state: 'running' };
        if (isErrored || rawBadge === 'ERRORED') return { label: 'Error', state: 'errored' };
        if (rawBadge === 'HIBERNATED') return { label: 'Hibernated', state: 'hibernated' };
        if (rawBadge === 'STOPPED') return { label: 'Stopped', state: 'stopped' };
        if (rawBadge === 'STARTING') return { label: 'Starting', state: 'starting' };
        return {
            label: rawBadge ? rawBadge.charAt(0).toUpperCase() + rawBadge.slice(1).toLowerCase() : 'Stopped',
            state: 'stopped',
        };
    };

    ui.formatBadgeLabel = function formatBadgeLabel(rawBadge = '') {
        const s = String(rawBadge || '').trim();
        if (!s) return '';
        if (/^PID\b/i.test(s)) return s;
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    };

    ui.readHostVisibility = function readHostVisibility(msgData) {
        if (!msgData || msgData.type !== ui.VISIBILITY_MESSAGE_TYPE) return null;
        const v = msgData.payload?.visible;
        return typeof v === 'boolean' ? v : null;
    };

    // --- 2. Tabs Module ---
    if (selected.has('tabs')) {
        ui.startInlineRename = function startInlineRename(pillEl, labelElOrOpts = {}, maybeOpts = {}) {
            if (!pillEl || pillEl._isRenaming) return;
            let labelEl = null;
            let opts = {};
            if (
                labelElOrOpts &&
                (labelElOrOpts.nodeType || typeof labelElOrOpts.replaceWith === 'function' || labelElOrOpts.textContent !== undefined)
            ) {
                labelEl = labelElOrOpts;
                opts = maybeOpts || {};
            } else {
                opts = labelElOrOpts || {};
            }
            const labelSel = opts.labelSelector || '[data-role="tab-label"], .agy-tab-label';
            if (!labelEl) {
                labelEl = pillEl.querySelector?.(labelSel);
            }
            if (!labelEl) return;
            pillEl._isRenaming = true;
            const inp = doc.createElement('input');
            inp.type = 'text';
            inp.className = opts.inputClassName || 'agy-rename-input';
            inp.value = String(opts.initialValue ?? (labelEl.textContent ? labelEl.textContent.trim() : ''));
            let done = false;
            const finish = (commit) => {
                if (done) return;
                done = true;
                pillEl._isRenaming = false;
                try {
                    if (typeof inp.replaceWith === 'function') {
                        inp.replaceWith(labelEl);
                    }
                } catch {
                }
                try {
                    inp.remove?.();
                } catch {
                }
                if (Array.isArray(pillEl.childNodes)) {
                    const idx = pillEl.childNodes.indexOf(inp);
                    if (idx !== -1) pillEl.childNodes.splice(idx, 1);
                }
                if (Array.isArray(pillEl.children)) {
                    const idx = pillEl.children.indexOf(inp);
                    if (idx !== -1) pillEl.children.splice(idx, 1);
                }
                if (commit) opts.onCommit?.(inp.value);
                else opts.onCancel?.();
            };
            inp.addEventListener('keydown', (e) => {
                e.stopPropagation?.();
                if (e.key === 'Enter') finish(true);
                else if (e.key === 'Escape') finish(false);
            });
            inp.addEventListener('blur', () => finish(true));
            inp.addEventListener('click', (e) => e.stopPropagation?.());
            inp.addEventListener('dblclick', (e) => e.stopPropagation?.());
            inp.addEventListener('pointerdown', (e) => e.stopPropagation?.());

            let replaced = false;
            try {
                if (typeof labelEl.replaceWith === 'function') {
                    labelEl.replaceWith(inp);
                    replaced = Boolean(labelEl._replacedBy === inp || (pillEl.contains && pillEl.contains(inp)));
                }
            } catch {
            }
            if (!replaced && typeof pillEl.appendChild === 'function') {
                pillEl.appendChild(inp);
            }
            inp.focus?.();
            inp.select?.();
            return inp;
        };

        ui.createTabPill = function createTabPill(item, opts = {}) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            const idKey = opts.idDatasetKey || 'tabId';
            btn.dataset[idKey] = String(item.id);
            btn.dataset.tabId = String(item.id);

            const iconSlot = doc.createElement('span');
            iconSlot.className = 'agy-tab-icon';
            iconSlot.dataset.role = 'tab-icon';

            const labelEl = doc.createElement('span');
            labelEl.className = 'agy-tab-label';
            labelEl.dataset.role = 'tab-label';

            const badgeEl = doc.createElement('span');
            badgeEl.className = 'agy-tab-badge hidden';
            badgeEl.dataset.role = 'tab-badge';

            const extBadge = doc.createElement('span');
            extBadge.className = 'agy-tab-ext-badge hidden';
            extBadge.dataset.role = 'tab-ext-badge';
            extBadge.title = 'Opened outside Hangar (shared with Antigravity)';
            extBadge.innerHTML = ui.iconSvg('open_in_new', 11);

            const dotEl = doc.createElement('span');
            dotEl.className = 'agy-status-dot hidden';
            dotEl.dataset.role = 'tab-dot';

            const pinBtn = doc.createElement('span');
            pinBtn.className = 'agy-tab-pin hidden';
            pinBtn.dataset.role = 'tab-pin';
            pinBtn.title = 'Unpin Tab';
            pinBtn.innerHTML = ui.iconSvg('keep', 16);

            const closeWrap = doc.createElement('span');
            closeWrap.className = 'agy-tab-close-wrap';
            closeWrap.dataset.role = 'tab-close-wrap';
            const closeBtn = doc.createElement('span');
            closeBtn.className = 'agy-tab-close';
            closeBtn.dataset.role = 'tab-close';
            closeBtn.title = item.closeTitle || opts.closeTitle || 'Close Tab';
            closeBtn.innerHTML = ui.iconSvg('close', 14);
            closeWrap.appendChild(closeBtn);

            btn.append(iconSlot, labelEl, badgeEl, extBadge, dotEl, pinBtn, closeWrap);
            btn._slots = { iconSlot, labelEl, badgeEl, extBadge, dotEl, pinBtn, closeWrap, closeBtn };
            btn._opts = opts;

            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation?.();
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                if (cur.pinned) curOpts.onUnpin?.(cur.id, cur, e);
            });
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation?.();
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                if (cur.closable && !cur.pinned) curOpts.onClose?.(cur.id, cur, e);
            });
            btn.addEventListener('click', (e) => {
                if (btn._wasDragged) {
                    btn._wasDragged = false;
                    return;
                }
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                curOpts.onSelect?.(cur.id, cur, e);
            });
            btn.addEventListener('auxclick', (e) => {
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                if (e.button === 1 && cur.closable && !cur.pinned) {
                    e.preventDefault?.();
                    e.stopPropagation?.();
                    curOpts.onClose?.(cur.id, cur, e);
                }
            });
            btn.addEventListener('contextmenu', (e) => {
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                curOpts.onContextMenu?.(cur.id, cur, e, btn);
            });
            btn.addEventListener('dblclick', (e) => {
                const cur = btn._item || item;
                const curOpts = btn._opts || opts;
                if (!cur.renamable || !curOpts.onRename) return;
                e.stopPropagation?.();
                curOpts.onRenameStart?.(cur.id, cur, btn);
                ui.startInlineRename(btn, {
                    initialValue: cur.renameValue ?? cur.label ?? '',
                    onCommit: (val) => curOpts.onRename(cur.id, val, cur),
                    onCancel: () => {
                        curOpts.onRenameCancel?.(cur.id, cur, btn);
                        ui.updateTabPill(btn, btn._item || cur, btn._opts || curOpts);
                    },
                });
            });

            ui.updateTabPill(btn, item, opts);
            opts.bindDrag?.(btn, item);
            return btn;
        };

        ui.updateTabPill = function updateTabPill(btn, item, opts = {}) {
            btn._item = item;
            btn._opts = opts;
            const baseCls = opts.pillClass || 'agy-tab';
            btn.className = `${baseCls}${item.active ? ' active' : ''}`;
            btn.dataset.pinned = item.pinned ? 'true' : 'false';
            btn.title = item.title || item.label || item.id;
            if (item.dataset && typeof item.dataset === 'object') {
                for (const [k, v] of Object.entries(item.dataset)) {
                    btn.dataset[k] = String(v);
                }
            }
            if (btn._isRenaming) return;

            const slots = btn._slots || {};
            const iconName = item.icon || 'folder';
            const iconSize = item.iconSize || 16;
            const iconKey = `${iconName}:${iconSize}`;
            if (slots.iconSlot && slots.iconSlot.dataset.iconKey !== iconKey) {
                slots.iconSlot.dataset.iconKey = iconKey;
                slots.iconSlot.innerHTML = ui.iconSvg(iconName, iconSize);
            }
            if (slots.labelEl) {
                slots.labelEl.textContent = item.label || item.id;
            }
            if (slots.badgeEl) {
                slots.badgeEl.textContent = item.badgeText || '';
                slots.badgeEl.classList.toggle('hidden', !item.badgeText);
            }
            if (slots.extBadge) {
                slots.extBadge.classList.toggle('hidden', !item.externalBadge);
            }
            if (slots.dotEl) {
                if (!item.statusDot) {
                    slots.dotEl.className = 'agy-status-dot hidden';
                } else {
                    slots.dotEl.className = `agy-status-dot ${item.statusDot}`;
                }
            }
            if (slots.pinBtn) {
                slots.pinBtn.classList.toggle('hidden', !item.pinned);
            }
            if (slots.closeBtn) {
                slots.closeBtn.title = item.closeTitle || opts.closeTitle || 'Close Tab';
            }
            if (slots.closeWrap) {
                slots.closeWrap.classList.toggle('hidden', Boolean(item.pinned || !item.closable));
            }

            // Sync serialized innerHTML only for lightweight test-harness element mocks
            if (!btn.nodeType && Array.isArray(btn.childNodes)) {
                btn.innerHTML =
                    `${ui.iconSvg(iconName, iconSize)}` +
                    `<span class="agy-tab-label" data-role="tab-label">${ui.escHtml(item.label || item.id)}</span>` +
                    (item.badgeText ? `<span class="agy-tab-badge" data-role="tab-badge">${ui.escHtml(item.badgeText)}</span>` : '') +
                    (item.externalBadge
                        ? `<span class="agy-tab-ext-badge" data-role="tab-ext-badge">${ui.iconSvg('open_in_new', 11)}</span>`
                        : '') +
                    (item.statusDot ? `<span class="agy-status-dot ${item.statusDot}" data-role="tab-dot"></span>` : '') +
                    (item.pinned
                        ? `<span class="agy-tab-pin" data-role="tab-pin">${ui.iconSvg('keep', 16)}</span>`
                        : item.closable
                            ? `<span class="agy-tab-close-wrap" data-role="tab-close-wrap"><span class="agy-tab-close" data-role="tab-close">${ui.iconSvg('close', 14)}</span></span>`
                            : '');
                if (slots.iconSlot) {
                    btn.childNodes.length = 0;
                    btn.childNodes.push(
                        slots.iconSlot,
                        slots.labelEl,
                        slots.badgeEl,
                        slots.extBadge,
                        slots.dotEl,
                        slots.pinBtn,
                        slots.closeWrap
                    );
                }
            }
        };

        ui.reconcileTabStrip = function reconcileTabStrip(stripEl, items = [], opts = {}) {
            if (!stripEl) return;
            const idKey = opts.idDatasetKey || 'tabId';
            const existingById = new Map();
            let addBtn = null;
            let hintEl = null;
            const childrenList = Array.from(stripEl.children || stripEl.childNodes || []);
            for (const ch of childrenList) {
                if (ch?.dataset?.role === (opts.addButton?.role || 'hub-add-tab') || ch?.classList?.contains?.('agy-tab-add-btn')) {
                    addBtn = ch;
                } else if (ch?.classList?.contains?.('agy-tab-drop-hint') || ch?.className === 'agy-tab-drop-hint') {
                    hintEl = ch;
                } else if (ch?.dataset?.[idKey]) {
                    existingById.set(ch.dataset[idKey], ch);
                }
            }

            const desiredIds = new Set(items.map((it) => String(it.id)));
            for (const [id, el] of existingById.entries()) {
                if (!desiredIds.has(id)) {
                    el.remove?.();
                    existingById.delete(id);
                }
            }

            const orderedNodes = [];
            if (items.length === 0 && opts.emptyHint) {
                if (!hintEl) {
                    hintEl = doc.createElement('span');
                    hintEl.className = 'agy-tab-drop-hint';
                    hintEl.textContent = opts.emptyHint;
                    if (addBtn && typeof stripEl.insertBefore === 'function') {
                        stripEl.insertBefore(hintEl, addBtn);
                    } else {
                        stripEl.appendChild?.(hintEl);
                    }
                } else {
                    hintEl.textContent = opts.emptyHint;
                }
                orderedNodes.push(hintEl);
            } else if (hintEl) {
                hintEl.remove?.();
            }

            items.forEach((item, idx) => {
                const id = String(item.id);
                let btn = existingById.get(id);
                if (!btn) {
                    btn = ui.createTabPill(item, opts);
                    existingById.set(id, btn);
                    const refNode = (stripEl.children && stripEl.children[idx]) || addBtn || null;
                    if (typeof stripEl.insertBefore === 'function') {
                        stripEl.insertBefore(btn, refNode);
                    } else {
                        stripEl.appendChild?.(btn);
                    }
                } else {
                    ui.updateTabPill(btn, item, opts);
                    if (typeof stripEl.insertBefore === 'function' && stripEl.children && stripEl.children[idx] !== btn) {
                        stripEl.insertBefore(btn, stripEl.children[idx] || addBtn || null);
                    }
                }
                orderedNodes.push(btn);
            });

            if (opts.addButton) {
                if (!addBtn) {
                    addBtn = doc.createElement('button');
                    addBtn.type = 'button';
                    addBtn.className = 'agy-icon-btn agy-tab-add-btn';
                    addBtn.dataset.role = opts.addButton.role || 'hub-add-tab';
                    if (opts.addButton.testId) addBtn.dataset.testid = opts.addButton.testId;
                    addBtn.title = opts.addButton.title || 'New Tab';
                    addBtn.innerHTML = ui.iconSvg('add', 16);
                    addBtn._onClick = opts.addButton.onClick;
                    addBtn.addEventListener('click', (e) => addBtn._onClick?.(e, addBtn));
                } else {
                    addBtn._onClick = opts.addButton.onClick;
                }
                const lastChild = stripEl.lastElementChild || (stripEl.children && stripEl.children[stripEl.children.length - 1]) || (stripEl.childNodes && stripEl.childNodes[stripEl.childNodes.length - 1]);
                if (lastChild !== addBtn) {
                    stripEl.appendChild?.(addBtn);
                }
                orderedNodes.push(addBtn);
            } else if (addBtn) {
                addBtn.remove?.();
            }

            if (Array.isArray(stripEl.childNodes) && typeof stripEl.insertBefore !== 'function') {
                stripEl.childNodes.length = 0;
                stripEl.childNodes.push(...orderedNodes);
            }
        };

        ui.setupStripScroll = function setupStripScroll(
            stripEl,
            overflowBtnEl,
            getTabs,
            onSelectTab,
            popoverEl,
            getClosedTabs,
            onReopenTab
        ) {
            if (!stripEl) return;
            if (overflowBtnEl) {
                overflowBtnEl.classList?.add?.('agy-tab-overflow-btn');
                overflowBtnEl._getTabs = getTabs;
                overflowBtnEl._onSelectTab = onSelectTab;
                overflowBtnEl._getClosedTabs = getClosedTabs;
                overflowBtnEl._onReopenTab = onReopenTab;
            }
            if (stripEl._scrollBound) {
                stripEl._updateOverflow?.();
                return { syncMasks: stripEl._updateOverflow };
            }
            stripEl._scrollBound = true;

            const syncMasks = () => {
                const canL = stripEl.scrollLeft > 2;
                const canR = stripEl.scrollLeft + stripEl.clientWidth < stripEl.scrollWidth - 2;
                stripEl.classList?.toggle?.('mask-left', canL && !canR);
                stripEl.classList?.toggle?.('mask-right', !canL && canR);
                stripEl.classList?.toggle?.('mask-both', canL && canR);
                if (overflowBtnEl) {
                    const closedCount = overflowBtnEl._getClosedTabs?.()?.length || 0;
                    overflowBtnEl.classList?.toggle?.('hidden', !canL && !canR && closedCount === 0);
                    overflowBtnEl.classList?.toggle?.('has-hidden-tabs', closedCount > 0);
                    let badgeEl = overflowBtnEl.querySelector?.('.agy-tab-overflow-badge');
                    if (closedCount > 0) {
                        if (!badgeEl && overflowBtnEl.appendChild) {
                            badgeEl = doc.createElement('span');
                            badgeEl.className = 'agy-tab-overflow-badge';
                            overflowBtnEl.appendChild(badgeEl);
                        }
                        if (badgeEl) badgeEl.textContent = String(closedCount);
                        overflowBtnEl.title = `All Tabs (${closedCount} hidden)`;
                    } else {
                        badgeEl?.remove?.();
                        overflowBtnEl.title = 'All Tabs';
                    }
                }
            };
            stripEl._updateScroll = stripEl._updateOverflow = syncMasks;

            stripEl.addEventListener?.('scroll', syncMasks, { passive: true });
            stripEl.addEventListener?.(
                'wheel',
                (e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                        e.preventDefault?.();
                        stripEl.scrollLeft += e.deltaY;
                    }
                },
                { passive: false }
            );
            if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncMasks).observe(stripEl);
            if (typeof MutationObserver !== 'undefined') new MutationObserver(syncMasks).observe(stripEl, { childList: true });
            syncMasks();

            if (overflowBtnEl && popoverEl && !overflowBtnEl._overflowBound) {
                overflowBtnEl._overflowBound = true;
                popoverEl.classList?.add?.('agy-tab-overflow-popover');
                overflowBtnEl.addEventListener('click', (e) => {
                    e.stopPropagation?.();
                    const list = overflowBtnEl._getTabs?.() || [];
                    const closedList = overflowBtnEl._getClosedTabs?.() || [];
                    if (!list.length && !closedList.length) return;
                    if (popoverEl.matches?.(':popover-open')) {
                        popoverEl.hidePopover?.();
                        return;
                    }
                    ui.clear(popoverEl);
                    const rect = overflowBtnEl.getBoundingClientRect();
                    popoverEl.style.top = `${Math.round(rect.bottom + 6)}px`;
                    popoverEl.style.left = `${Math.max(8, Math.round(rect.right - 220))}px`;
                    const activeId = stripEl.querySelector?.('.agy-tab.active[data-sidecar-id]')?.dataset?.sidecarId ||
                        stripEl.querySelector?.('.agy-tab.active')?.dataset?.sidecarId;
                    const hasOverflow = stripEl.scrollWidth > stripEl.clientWidth + 1;

                    const appendItem = (tab, isClosed = false) => {
                        const tabId = tab.sidecarId ?? tab.id ?? '';
                        const tabName = tab.displayName ?? tab.title ?? tab.label ?? tabId;
                        const isTabActive = !isClosed && (Boolean(tab.active) || (activeId && tabId === activeId));
                        const item = doc.createElement('button');
                        const left = doc.createElement('span');
                        const icon = doc.createElement('span');
                        const title = doc.createElement('span');
                        item.type = 'button';
                        item.className = `agy-tab-overflow-item${isClosed ? ' is-hidden-tab' : isTabActive ? ' active' : ''}`;
                        left.className = 'agy-tab-overflow-item-left';
                        icon.className = 'agy-tab-icon';
                        title.className = 'agy-tab-overflow-item-title';
                        if (typeof win.Hangar?.tabIconElement === 'function') {
                            icon.appendChild(win.Hangar.tabIconElement(tab));
                        } else if (tab.icon) {
                            icon.innerHTML = ui.iconSvg(tab.icon, 14);
                        } else {
                            const fallbackIcon = tab.isTerminal
                                ? 'terminal'
                                : tab.isSideChat
                                    ? 'chat'
                                    : tab.isVirtual
                                        ? 'grid_view'
                                        : tab.scope === 'workspace'
                                            ? 'folder'
                                            : 'code_blocks';
                            icon.innerHTML = ui.iconSvg(fallbackIcon, 14);
                        }
                        title.textContent = tabName;
                        left.append(icon, title);
                        item.append(left);
                        if (isClosed) {
                            item.title = `Show ${tabName}`;
                            const pill = doc.createElement('span');
                            pill.className = 'agy-tab-overflow-restore';
                            pill.textContent = 'Show';
                            item.append(pill);
                        } else if (
                            (!tab.isSideChat && !tab.isTerminal && tab.sidecarId && tab.sidecarId !== win.Hangar?.EXTENSIONS_TAB_ID) ||
                            tab.status
                        ) {
                            const dot = doc.createElement('span');
                            const stateCls = tab.status || ui.formatStatusBadge(tab.statusBadge, tab.isRunning, tab.isErrored).state;
                            dot.className = `agy-status-dot ${stateCls}`;
                            item.append(dot);
                        }
                        if (!isClosed && (tab.isPinned || tab.pinned)) {
                            const pin = doc.createElement('span');
                            pin.className = 'agy-tab-pin';
                            pin.innerHTML = ui.iconSvg('keep', 12);
                            item.append(pin);
                        }
                        item.addEventListener('click', () => {
                            popoverEl.hidePopover?.();
                            if (isClosed) {
                                overflowBtnEl._onReopenTab?.(tabId);
                            } else {
                                overflowBtnEl._onSelectTab?.(tabId);
                                const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(tabId) : tabId;
                                stripEl.querySelector?.(`.agy-tab[data-sidecar-id="${escId}"]`)?.scrollIntoView?.({
                                    inline: 'nearest',
                                    block: 'nearest',
                                    behavior: 'smooth',
                                });
                            }
                        });
                        popoverEl.appendChild(item);
                    };

                    if (list.length && (hasOverflow || !closedList.length)) {
                        if (closedList.length) {
                            const hdr = doc.createElement('div');
                            hdr.className = 'agy-tab-overflow-section';
                            hdr.textContent = 'Open Tabs';
                            popoverEl.appendChild(hdr);
                        }
                        for (const tab of list) appendItem(tab, false);
                    }
                    if (closedList.length) {
                        const hdr = doc.createElement('div');
                        hdr.className = 'agy-tab-overflow-section';
                        hdr.textContent = `Hidden Tabs (${closedList.length})`;
                        popoverEl.appendChild(hdr);
                        for (const tab of closedList) appendItem(tab, true);
                    }
                    popoverEl.showPopover?.();
                });
            }
            syncMasks();
            return { syncMasks };
        };

        ui.createToggleGroup = function createToggleGroup(containerEl, items = [], opts = {}) {
            if (!containerEl) return;
            containerEl.classList?.add('agy-toggle-group');
            containerEl.classList?.toggle('agy-toggle-group-grid', opts.layout === 'grid');
            if (opts.layout === 'grid' && items.length > 0) {
                containerEl.style?.setProperty?.('--agy-toggle-cols', String(items.length));
            }
            containerEl.innerHTML = items
                .map((it) => {
                    const isActive = it.id === opts.activeId;
                    const dataAttrs = Object.entries(it.dataset || {})
                        .map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${ui.escHtml(v)}"`)
                        .join('');
                    const countHtml =
                        it.count !== undefined && it.count !== null
                            ? ` <span class="agy-count-pill">${ui.escHtml(it.count)}</span>`
                            : '';
                    return `<button class="agy-toggle-item${isActive ? ' active' : ''}" data-toggle-id="${ui.escHtml(it.id)}"${
                        it.title ? ` title="${ui.escHtml(it.title)}"` : ''
                    }${dataAttrs}>${ui.escHtml(it.label)}${countHtml}</button>`;
                })
                .join('');
            for (const btn of containerEl.querySelectorAll?.('.agy-toggle-item') || []) {
                btn.addEventListener('click', (e) => {
                    const id = btn.dataset?.toggleId;
                    if (id) opts.onChange?.(id, e);
                });
            }
        };
    }

    // --- 3. Tab-Drag Module ---
    if (selected.has('tab-drag')) {
        ui.setTabShift = function setTabShift(el, px) {
            el._shiftX = px;
            el.style.transform = px ? `translateX(${px}px)` : '';
        };

        ui.getUnshiftedRect = function getUnshiftedRect(el) {
            const r = el.getBoundingClientRect();
            const s = el._shiftX || 0;
            return {
                left: r.left - s,
                right: r.right - s,
                top: r.top,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
            };
        };

        ui.measureStrip = function measureStrip(sourceStrip, btn, startX = 0, startY = 0, selector = '.agy-tab') {
            const sourceTabs = Array.from(sourceStrip?.querySelectorAll?.(selector) || []);
            const centers = [];
            const rects = [];
            let minLeft = Infinity;
            let maxRight = -Infinity;
            let gap = 0;
            let prevRight = null;
            sourceTabs.forEach((el) => {
                const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
                rects.push(r);
                centers.push(r.left + r.width / 2);
                minLeft = Math.min(minLeft, r.left);
                maxRight = Math.max(maxRight, r.right);
                if (prevRight !== null && gap === 0) gap = Math.max(0, r.left - prevRight);
                prevRight = r.right;
            });
            const sRect = typeof sourceStrip?.getBoundingClientRect === 'function'
                ? sourceStrip.getBoundingClientRect()
                : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
            const draggedIndex = sourceTabs.indexOf(btn);
            const dRect = rects[draggedIndex] || (typeof btn?.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
            const draggedWidth = dRect.width;
            const draggedHeight = dRect.height;
            const grabOffsetX = startX - dRect.left;
            const grabOffsetY = startY - dRect.top;
            const originalTop = dRect.top;
            const computedMinLeft = minLeft === Infinity ? sRect.left : Math.max(minLeft, sRect.left);
            const computedMaxLeft = maxRight === -Infinity ? sRect.left : Math.max(sRect.left, Math.min(maxRight, sRect.right) - draggedWidth);
            const draggedSlot = draggedWidth + (gap || 1);

            return {
                sourceStrip,
                sourceTabs,
                items: sourceTabs,
                draggedIndex,
                fromIdx: draggedIndex,
                centers,
                rects,
                startScrollLeft: sourceStrip?.scrollLeft || 0,
                draggedWidth,
                draggedHeight,
                grabOffsetX,
                grabOffsetY,
                offX: grabOffsetX,
                offY: grabOffsetY,
                originalTop,
                minLeft: computedMinLeft,
                maxLeft: computedMaxLeft,
                draggedSlot,
                step: draggedSlot,
                stripRect: sRect,
                locked: true,
                lockChangedAt: null,
            };
        };

        ui.bindTabDragController = function bindTabDragController(el, opts = {}) {
            let activePointerId = null;
            let startX = 0;
            let startY = 0;
            let isDragging = false;
            let dragState = null;
            let ghost = null;

            const clearPreview = () => opts.onClearPreview?.();

            const onWinPointerEnd = (e) => endPointer(e, false);
            const onWinPointerCancel = (e) => endPointer(e, true);

            el.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                if (
                    e.target?.closest?.(
                        '[data-role="close"], .agy-tab-close, .agy-tab-close-wrap, .agy-tab-pin, input, .agy-rename-input' +
                        (opts.ignoreSelector ? `, ${opts.ignoreSelector}` : '')
                    )
                ) {
                    return;
                }
                if (typeof opts.canDrag === 'function' && opts.canDrag(el, e) === false) return;

                startX = e.clientX;
                startY = e.clientY;
                activePointerId = e.pointerId;
                isDragging = false;
                dragState = null;
                ghost = null;

                try {
                    el.setPointerCapture?.(e.pointerId);
                } catch {
                }

                if (typeof window !== 'undefined') {
                    window.addEventListener?.('pointerup', onWinPointerEnd, { capture: true });
                    window.addEventListener?.('pointercancel', onWinPointerCancel, { capture: true });
                }
            });

            el.addEventListener('pointermove', (e) => {
                if (activePointerId === null || (e.pointerId !== undefined && e.pointerId !== activePointerId && e.buttons !== 1)) return;
                const stripEl = opts.stripEl || el.parentElement;
                if (!stripEl) return;

                const threshold = opts.dragThreshold ?? 4;
                if (!isDragging) {
                    if (Math.hypot(e.clientX - startX, e.clientY - startY) < threshold) return;
                    isDragging = true;
                    dragState = ui.measureStrip(stripEl, el, startX, startY, opts.itemSelector || '.agy-tab');
                    el.classList.add('agy-tab-dragging', 'is-dragging-source');
                    el.style.opacity = '0.35';
                    doc.body?.classList?.add('dragging-tab');

                    if (typeof opts.createGhost === 'function') {
                        ghost = opts.createGhost(el, dragState);
                    } else {
                        ghost = el.cloneNode(true);
                        const selClass = (opts.itemSelector || '.agy-tab').replace(/^\./, '').replace(/\[.*\]/g, '');
                        ghost.className = `${selClass} active agy-tab-drag-ghost`;
                        ghost.style.width = `${dragState.draggedWidth}px`;
                        ghost.style.height = `${dragState.draggedHeight}px`;
                        ghost.style.left = `${dragState.rects[dragState.fromIdx]?.left ?? dragState.minLeft}px`;
                        ghost.style.top = `${dragState.originalTop}px`;
                    }
                    doc.body?.appendChild?.(ghost);
                    dragState.ghost = ghost;
                }

                if (!isDragging || !dragState || !ghost) return;

                const railDetachY = opts.railDetachY ?? 18;
                const sRect = typeof stripEl.getBoundingClientRect === 'function'
                    ? stripEl.getBoundingClientRect()
                    : dragState.stripRect;
                dragState.stripRect = sRect;

                const shouldDetach = typeof opts.shouldDetach === 'function' && opts.shouldDetach(e, dragState);
                const inRail =
                    !shouldDetach &&
                    e.clientY >= sRect.top - railDetachY &&
                    e.clientY <= sRect.bottom + railDetachY;

                if (inRail !== dragState.locked) {
                    dragState.locked = inRail;
                    dragState.lockChangedAt = Date.now();
                }

                if (inRail) {
                    const transitionActive = dragState.lockChangedAt && Date.now() - dragState.lockChangedAt < 120;
                    ghost.style.transition = transitionActive ? 'top 120ms ease-out, left 120ms ease-out' : '';
                    const rawLeft = e.clientX - dragState.grabOffsetX;
                    const left = Math.min(Math.max(rawLeft, dragState.minLeft), dragState.maxLeft);
                    ghost.style.left = `${left}px`;
                    ghost.style.top = `${dragState.originalTop}px`;

                    if (stripEl.scrollWidth > stripEl.clientWidth) {
                        if (e.clientX < sRect.left + 26) stripEl.scrollLeft -= 8;
                        else if (e.clientX > sRect.right - 26) stripEl.scrollLeft += 8;
                    }

                    const scrollDelta = (stripEl.scrollLeft || 0) - dragState.startScrollLeft;
                    const x = left + dragState.draggedWidth / 2;
                    const pinnedCount = dragState.sourceTabs.filter((t) =>
                        opts.isItemPinned ? opts.isItemPinned(t) : t.dataset?.pinned === 'true'
                    ).length;
                    const isPin = opts.isPinned ? opts.isPinned(el) : el.dataset?.pinned === 'true';

                    let dropIdx = dragState.sourceTabs.length;
                    for (let i = 0; i < dragState.centers.length; i++) {
                        const factor = opts.getMergeSpanFactor
                            ? opts.getMergeSpanFactor(dragState.sourceTabs[i], i, dragState)
                            : 0.5;
                        const c = dragState.centers[i] - scrollDelta;
                        const span = dragState.draggedWidth * (factor - 0.5);
                        if (x < c + span) {
                            dropIdx = i;
                            break;
                        }
                    }

                    dropIdx = isPin ? Math.min(dropIdx, Math.max(0, pinnedCount - 1)) : Math.max(dropIdx, pinnedCount);
                    dragState.dropIdx = dropIdx;
                    dragState.targetIdx = dropIdx;

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
                    ghost.style.left = `${e.clientX - dragState.grabOffsetX}px`;
                    ghost.style.top = `${e.clientY - dragState.grabOffsetY}px`;
                    dragState.sourceTabs.forEach((sib, i) => {
                        if (i !== dragState.draggedIndex) ui.setTabShift(sib, 0);
                    });
                    opts.onOutOfRailMove?.(e, dragState);
                }
            });

            const endPointer = (e, cancelled = false) => {
                if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;

                if (typeof window !== 'undefined') {
                    window.removeEventListener?.('pointerup', onWinPointerEnd, { capture: true });
                    window.removeEventListener?.('pointercancel', onWinPointerCancel, { capture: true });
                }

                const wasDragging = isDragging;
                const finishedState = dragState;

                try {
                    if (activePointerId !== null && el.hasPointerCapture?.(activePointerId)) {
                        el.releasePointerCapture(activePointerId);
                    }
                } catch {
                }

                activePointerId = null;
                isDragging = false;
                dragState = null;

                if (finishedState) {
                    finishedState.sourceTabs.forEach((t) => ui.setTabShift(t, 0));
                }

                if (ghost) {
                    ghost.remove?.();
                    ghost = null;
                }

                el.classList.remove('agy-tab-dragging', 'is-dragging-source');
                el.style.opacity = '';
                doc.body?.classList?.remove('dragging-tab');
                clearPreview();

                if (wasDragging) {
                    opts.onDrop?.(e, finishedState, cancelled);
                } else if (!cancelled) {
                    opts.onClick?.(e);
                }
            };

            el.addEventListener('pointerup', (e) => endPointer(e, false));
            el.addEventListener('pointercancel', (e) => endPointer(e, true));
            el.addEventListener('lostpointercapture', (e) => endPointer(e, true));
        };
    }

    // --- 4. Layout Module ---
    if (selected.has('layout')) {
        ui.bindSplitResize = function bindSplitResize(handleEl, opts = {}) {
            if (!handleEl) return;
            let dragging = false;
            const minR = opts.minRatio ?? 0.15;
            const maxR = opts.maxRatio ?? 0.85;
            handleEl.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                dragging = true;
                handleEl.setPointerCapture?.(e.pointerId);
                handleEl.classList.add('dragging');
                doc.body.classList.add('resizing-split');
                opts.onResizeStart?.(e);
            });
            handleEl.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                const container = typeof opts.containerEl === 'function' ? opts.containerEl() : opts.containerEl;
                if (!container) return;
                const rect = container.getBoundingClientRect();
                const raw =
                    opts.direction === 'horizontal'
                        ? (e.clientX - rect.left) / Math.max(1, rect.width)
                        : (e.clientY - rect.top) / Math.max(1, rect.height);
                const ratio = Math.min(maxR, Math.max(minR, raw));
                opts.onResize?.(ratio, e);
            });
            const stop = (e) => {
                if (!dragging) return;
                dragging = false;
                handleEl.classList.remove('dragging');
                doc.body.classList.remove('resizing-split');
                opts.onResizeEnd?.(e);
            };
            handleEl.addEventListener('pointerup', stop);
            handleEl.addEventListener('pointercancel', stop);
        };
    }

    // --- 5. Overlays Module ---
    if (selected.has('overlays')) {
        let activeMenuEl = null,
            cleanupMenu = null;
        ui.closeContextMenu = function closeContextMenu() {
            if (activeMenuEl) {
                activeMenuEl.remove?.();
                activeMenuEl = null;
            }
            if (cleanupMenu) {
                cleanupMenu();
                cleanupMenu = null;
            }
        };

        ui.openContextMenu = function openContextMenu(anchorOrEvent, items = []) {
            anchorOrEvent?.preventDefault?.();
            anchorOrEvent?.stopPropagation?.();
            ui.closeContextMenu();
            const validItems = items.filter(Boolean);
            if (validItems.length === 0) return null;
            const menu = doc.createElement('div');
            menu.className = 'agy-context-menu';
            menu.setAttribute?.('role', 'menu');
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
                const checkHtml = item.checked ? `<span class="agy-tab-icon agy-context-menu-check">${ui.iconSvg('check', 14)}</span>` : '';
                btn.innerHTML = `${iconHtml}<span class="agy-context-menu-label">${ui.escHtml(item.label || '')}</span>${checkHtml}`;
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation?.();
                    if (btn.disabled) return;
                    ui.closeContextMenu();
                    item.onClick?.();
                });
                menu.appendChild(btn);
            }
            doc.body.appendChild(menu);
            const x = Math.min(anchorOrEvent?.clientX || 0, (win.innerWidth || 800) - 196);
            const y = Math.min(anchorOrEvent?.clientY || 0, (win.innerHeight || 600) - 180);
            menu.style.left = `${Math.max(6, x)}px`;
            menu.style.top = `${Math.max(6, y)}px`;
            activeMenuEl = menu;
            const onDown = (ev) => {
                if (!menu.contains?.(ev.target)) ui.closeContextMenu();
            };
            const onKey = (ev) => {
                if (ev.key === 'Escape') ui.closeContextMenu();
            };
            setTimeout(() => {
                doc.addEventListener?.('pointerdown', onDown, true);
                doc.addEventListener?.('keydown', onKey, true);
            }, 0);
            cleanupMenu = () => {
                doc.removeEventListener?.('pointerdown', onDown, true);
                doc.removeEventListener?.('keydown', onKey, true);
            };
            return menu;
        };

        ui.showToast = function showToast(message, opts = {}) {
            const container = opts.container || doc.body;
            const existing = container?.querySelector?.('.agy-toast') || doc.querySelector?.('.agy-toast');
            existing?.remove?.();
            const toast = doc.createElement('div');
            toast.className = 'agy-toast';
            toast.textContent = String(message ?? '');
            container.appendChild(toast);
            const dur = opts.durationMs ?? 2400;
            if (dur > 0) setTimeout(() => toast.remove?.(), dur);
            return toast;
        };
    }

    // --- 6. Controls Module ---
    if (selected.has('controls')) {
        ui.renderSwitch = function renderSwitch({ on = false, size = 'md', disabled = false, title = '', attrs = '' } = {}) {
            const cls = `agy-switch${size === 'sm' ? ' sm' : ''}${on ? ' on' : ''}`;
            return `<button type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" class="${cls}"${
                disabled ? ' disabled' : ''
            }${title ? ` title="${ui.escHtml(title)}"` : ''}${attrs ? ` ${attrs}` : ''}><span class="agy-switch-thumb"></span></button>`;
        };
    }

    // --- 7. Surfaces Module ---
    if (selected.has('surfaces')) {
        ui.renderCountPill = function renderCountPill(count) {
            return `<span class="agy-count-pill">${ui.escHtml(count)}</span>`;
        };
        ui.renderEmptyState = function renderEmptyState({ icon = 'code_blocks', message = '', actionHtml = '' } = {}) {
            return `<div class="agy-empty-state">${ui.iconSvg(icon, 24)}<span>${ui.escHtml(message)}</span>${actionHtml}</div>`;
        };
    }

    return ui;
}

export function buildAgyUiJs(modules = 'all') {
    const resolved = resolveAgyUiModules(modules);
    return `;(${attachAgyUI.toString()})(typeof window !== 'undefined' ? window : globalThis, { modules: ${JSON.stringify(
        resolved
    )} });\n`;
}

export const AGY_UI_JS = buildAgyUiJs('all');
