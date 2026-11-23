# create-agy

<p>
  <img src="https://img.shields.io/badge/Antigravity-2.0%E2%80%932.34.0-4285F4?logo=google&logoColor=white" alt="Antigravity 2.0–2.34.0" height="20">
</p>

Scaffold a Google Antigravity Auxiliary Pane sidecar or native plugin across all 4 archetypes:

```bash
# Interactive wizard (select archetype, UI entrypoint, or plugin components)
npm create agy

# Standalone Auxiliary Pane webview sidecar (default)
npm create agy my-sidecar

# Sidecar + stdio MCP server
npm create agy my-sidecar -- --archetype sidecar-mcp

# Native Antigravity plugin bundle (skills, mcp, rules, hooks, agents)
npm create agy my-plugin -- --archetype plugin --components skills,mcp,hooks --github octocat -y

# Native Antigravity plugin + companion sidecar
npm create agy my-suite -- --archetype plugin-sidecar --github octocat -y
```

This package is a thin launcher for the CLI in
[`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit),
which provides the full runtime SDK, manifest validator (`lint`), plugin bundler (`build-plugin`), offline package verifier (`pack-smoke`), and Hangar submission helper (`registry-entry`).

Requires Node.js 20 or newer.
