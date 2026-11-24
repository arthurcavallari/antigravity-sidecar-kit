# create-antigravity-sidecar

<p>
  <img src="https://img.shields.io/badge/Antigravity-2.0%E2%80%932.34.0-4285F4?logo=google&logoColor=white" alt="Antigravity 2.0–2.34.0" height="20">
</p>

Scaffold a Google Antigravity Auxiliary Pane sidecar or native plugin:

```bash
npm create antigravity-sidecar my-sidecar
cd antigravity-my-sidecar
npm install
npm run setup
```

Or use [`create-agy`](https://www.npmjs.com/package/create-agy) (`npm create agy`) for an interactive wizard across all 4 archetypes (`sidecar-ui`, `sidecar-mcp`, `plugin`, `plugin-sidecar`):

```bash
npm create agy
npm create agy my-plugin -- --archetype plugin --components skills,mcp,hooks --github octocat -y
```

This package is a thin launcher for the CLI in
[`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit),
which provides the full documentation and lifecycle subcommands (`init`, `lint`, `build-plugin`, `pack-smoke`, `registry-entry`). Options (`--archetype <sidecar-ui|sidecar-mcp|plugin|plugin-sidecar>`, `--components <skills,mcp,rules,hooks,agents>`, `--dir <target-dir>`, `--entrypoint <aux_pane|sidebar|full_pane>`, `--hide-title-bar`, `--github <owner>`, `--yes`, `--force`) are passed through.

Requires Node.js 20 or newer.
