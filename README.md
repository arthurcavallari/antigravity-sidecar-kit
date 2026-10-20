# Antigravity Sidecar Kit (`antigravity-sidecar-kit`)

> Zero-dependency SDK and CLI project scaffolder for **Google Antigravity** Auxiliary Pane sidecars.

Google Antigravity's built-in `sidecar_sdk` provides a minimal `SidecarApp` loopback HTTP server, leaving every sidecar author to re-implement Language Server Connect RPC clients, CSRF credential caching, host theme seed & contrast resolution, `/compiled_tailwind.css` `@layer` proxying, UTF-8 BOM-safe `~/.gemini/config/config.json` mutation, and `_npx`-safe NTFS junction/symlink installation.

`antigravity-sidecar-kit` packages that entire infrastructure layer into a **zero-dependency**, pure Node.js (`>= 20.0.0`) ESM toolkit used by [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar) and [**Antigravity Context Monitor**](https://github.com/arthurcavallari/antigravity-context-monitor).

---

## 1. Quick Start: Scaffold a New Sidecar

Generate a complete, Hangar-compatible Antigravity Auxiliary Pane sidecar in one command:

```bash
# Using npx create-* shorthand
npx create-antigravity-sidecar my-sidecar

# Or via the CLI binary directly
npx agy-sidecar-kit init my-sidecar
```

What gets generated:
- `package.json` — ESM configuration with `setup`, `start`, `uninstall`, and `test` scripts.
- `sidecar.json` — Antigravity `SidecarManager` manifest (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- `hub-manifest.json` — Hangar Marketplace metadata (`capabilityTier`, `workspaceTriggers`, categories).
- `server.mjs` — Thin `SidecarApp` entrypoint serving `/compiled_tailwind.css` and token-authenticated UI assets.
- `setup.mjs` — Cross-platform installer (`runSidecarSetup`) with `--uninstall` and `--skip-tests` support.
- `ui/` & `test/` — Theme-adaptive UI shell and automated smoke tests.

---

## 2. Installation (Existing Sidecar Projects)

```bash
npm install antigravity-sidecar-kit
```

- **Zero External Dependencies**: Uses only Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, `node:os`, `node:crypto`, `node:url`).
- **Trusted First-Party SDK in Hangar**: Sidecars that depend solely on `antigravity-sidecar-kit` retain `externalDependencies: 0` (`0 External Deps` badge) in Antigravity Hangar's security scanner.

---

## 3. Subpath Module Reference

### `antigravity-sidecar-kit/config`
OS-aware Antigravity filesystem paths and UTF-8 BOM-safe JSON helpers that never clobber malformed `config.json` files and always preserve `sidecars[id].projectId`.

```js
import {
  GLOBAL_CONFIG_DIR,    // ~/.gemini/config
  GLOBAL_SIDECARS_DIR,  // ~/.gemini/config/sidecars
  CONFIG_JSON_PATH,     // ~/.gemini/config/config.json
  APP_STORAGE_PATH,     // OS-specific Antigravity app_storage.json path
  HANGAR_DATA_DIR,      // ~/.gemini/hangar
  HANGAR_PACKAGES_DIR,  // ~/.gemini/hangar/packages
  SIDECAR_DATA_ROOT,    // ~/.gemini/antigravity/sidecar_data
  readJsonSafe,
  writeJsonNoBom,
  updateAgySidecarConfig,
} from 'antigravity-sidecar-kit/config';

// Enable a sidecar in ~/.gemini/config/config.json while preserving existing projectId
updateAgySidecarConfig('my-sidecar', true);
```

---

### `antigravity-sidecar-kit/rpc`
Connect RPC client for `exa.language_server_pb.LanguageServerService/<Method>`, automatic daemon credential caching (`runtime.json`), and external terminal process restart fallback.

```js
import {
  callLsRpc,
  getLsConfig,
  persistSidecarRuntime,
  killSidecarProcessByPortOrPid,
  getSidecars,
  manageSidecar,
  getAllTrajectories,
  getUserStatus,
} from 'antigravity-sidecar-kit/rpc';

// Call any Language Server RPC method
const { sidecars } = await getSidecars();
await manageSidecar('my-sidecar', 'SIDECAR_ACTION_RESTART');
const customRes = await callLsRpc('GetMcpServerStates', {});
```

- **Automatic Credential Persistence**: When imported inside a running sidecar daemon (`ANTIGRAVITY_SIDECAR_WEB_PORT` + `ANTIGRAVITY_LS_ADDRESS`), `persistSidecarRuntime` caches `{ pid, webPort, lsAddress, csrfToken }` to `~/.gemini/antigravity/sidecar_data/<id>/data/runtime.json` so CLI tools (`setup.mjs`) invoked from external terminals can talk to the Language Server even when env vars aren't exported in the user's shell.
- **Fallback Process Restarter (`killSidecarProcessByPortOrPid`)**: If the Language Server RPC is unreachable from an external terminal, inspects `runtime.json` PID first and falls back to parsing `listening on 127.0.0.1:<port>` from `logs/sidecar.log`, sending `SIGTERM` so Antigravity's `"restart_policy": "always"` respawns the updated sidecar immediately.

---

### `antigravity-sidecar-kit/theme`
Reads live editor theme seeds from `~/.gemini/config/config.json`, contrast settings (`"jetski.contrast"`) from `app_storage.json` with `mtimeMs` caching, and proxies Antigravity's `/compiled_tailwind.css` wrapped in `@layer agy-host`.

```js
import {
  readHostContrast,
  resolveHostTheme,
  fetchHostStylesheet,
} from 'antigravity-sidecar-kit/theme';

const theme = resolveHostTheme();
// Returns:
// {
//   theme: 'Antigravity Dark' | 'Antigravity Light',
//   themeType: 'dark' | 'light',
//   mode: 'dark' | 'light',
//   contrast: 'normal' | 'high',
//   isDark: boolean,
//   cssVariables: { '--background': ..., '--foreground': ..., '--primary': ..., ... },
//   vars: { '--cm-bg': ..., '--cm-card': ..., '--cm-border': ..., ... }
// }
```

---

### `antigravity-sidecar-kit/server`
Route handlers for `SidecarApp` (`sidecar_sdk`) that inject `ANTIGRAVITY_SIDECAR_UI_TOKEN` + cache-busting timestamps into local HTML asset references (`src`/`href`) and serve the host Tailwind stylesheet with `instanceof Response` compatibility.

```js
import { SidecarApp, Response } from 'sidecar_sdk';
import { createAssetHandler, createAgyCssHandler } from 'antigravity-sidecar-kit/server';

const app = new SidecarApp();
const serveAsset = (rel, type) =>
  createAssetHandler(UI_DIR, rel, type, { ResponseClass: Response });

app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/app.js', serveAsset('app.js', 'text/javascript; charset=utf-8'));

await app.run();
```

---

### `antigravity-sidecar-kit/setup`
End-to-end `setup.mjs` runner supporting `npx`, local git checkouts, and `--uninstall`.

```js
import { bundleSidecarKit, runSidecarSetup } from 'antigravity-sidecar-kit/setup';

await runSidecarSetup({
  sidecarId: 'my-sidecar',
  repoRoot: REPO_ROOT,
  requiredFiles: ['sidecar.json', 'server.mjs', 'ui/index.html'],
  testFiles: ['test/smoke.test.mjs'],
  onBeforeSetup: async () => { /* optional pre-link hook */ },
  onUninstall: async () => { /* optional cleanup hook */ },
});
```

What `runSidecarSetup` handles automatically:
1. Verifies Node.js `>= 20.0.0` and all `requiredFiles`.
2. Runs `testFiles` via `node --test` unless `--skip-tests` is passed.
3. **Ephemeral `_npx` Copy & SDK Bundling (`resolvePermanentLinkSource`)**: When executed via `npx`, copies the package out of the temporary `_npx` cache into `~/.gemini/hangar/packages/<id>@<version>` and guarantees `node_modules/antigravity-sidecar-kit` is present inside the permanent copy whether npm nested or hoisted the dependency.
4. Links `~/.gemini/config/sidecars/<id>` using an NTFS directory junction on Windows or symlink on macOS/Linux.
5. Enables `sidecars[id].enabled = true` in `~/.gemini/config/config.json` (preserving `projectId`).
6. Hot-reloads the sidecar via `ManageSidecar` RPC (`SIDECAR_ACTION_RESTART` $\rightarrow$ `SIDECAR_ACTION_ENABLE`) or `killSidecarProcessByPortOrPid` fallback.

---

### `antigravity-sidecar-kit/workspace`
Cross-platform `file://` URI normalizer, workspace glob matcher, and active conversation trajectory workspace resolver.

```js
import {
  normalizeWorkspacePath,
  extractWorkspaceName,
  matchesWorkspaceRule,
  extractTrajectoryWorkspace,
  resolveActiveWorkspace,
} from 'antigravity-sidecar-kit/workspace';

normalizeWorkspacePath('file:///c%3A/Projects/App/'); // -> 'c:/Projects/App'
matchesWorkspaceRule('c:/Projects/App/packages/api', ['c:/Projects/App']); // -> true
```

---

## 4. Repository Layout

```text
antigravity-sidecar-kit/
├── package.json
├── bin/
│   └── cli.mjs                 # CLI scaffolder (agy-sidecar-kit / create-antigravity-sidecar)
├── lib/
│   ├── index.mjs               # Barrel export
│   ├── config.mjs              # OS paths, BOM-safe JSON & config.json updater
│   ├── rpc.mjs                 # Connect RPC client, runtime cache & process restarter
│   ├── theme.mjs               # Host theme seed resolver & @layer agy-host CSS proxy
│   ├── setup.mjs               # Cross-platform setup runner & _npx permanent copier
│   ├── server.mjs              # SidecarApp asset & stylesheet route factories
│   ├── workspace.mjs           # Workspace URI normalizer, glob matcher & trajectory resolver
│   └── scaffolder.mjs          # Project template generator
└── test/
    ├── config.test.mjs
    ├── rpc.test.mjs
    ├── theme.test.mjs
    ├── setup-server.test.mjs
    └── workspace.test.mjs
```

---

## License

[MIT](./LICENSE)
