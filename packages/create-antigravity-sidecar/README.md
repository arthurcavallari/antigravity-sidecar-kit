# create-antigravity-sidecar

<p>
  <img src="https://img.shields.io/badge/Antigravity-2.0%E2%80%932.32.2-4285F4?logo=google&logoColor=white" alt="Antigravity 2.0–2.32.2" height="20">
</p>

Scaffold a Google Antigravity Auxiliary Pane sidecar:

```bash
npm create antigravity-sidecar my-sidecar
cd antigravity-my-sidecar
npm install
npm run setup
```

This package is a thin launcher for the CLI in
[`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit),
which has the full documentation. Options (`--dir <target-dir>`, `--entrypoint <aux_pane|sidebar|full_pane>`, `--hide-title-bar`, `--force`) are passed through.

Requires Node.js 20 or newer.
