/**
 * @fileoverview Self-healing sidecar supervisor and fallback HTTP server on ANTIGRAVITY_SIDECAR_WEB_PORT.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLoopbackOrigin, verifySidecarToken } from './state-sync.mjs';

export const WEB_PORT_ENV_VAR = 'ANTIGRAVITY_SIDECAR_WEB_PORT';
export const LAUNCHER_META_NAME = 'antigravity-sidecar-launcher';
export const USAGE_ERROR_EXIT_CODE = 64;
export const MAX_OUTPUT_CHARS = 4000;

export function resolveNodeBinary({
  execPath = process.execPath,
  env = process.env,
  versions = process.versions,
  existsFn = existsSync,
} = {}) {
  const makeResult = (cmd, extraEnv = {}) => {
    const out = {
      command: cmd,
      env: extraEnv,
      toString() {
        return cmd;
      },
    };
    return out;
  };
  const explicit = env?.ANTIGRAVITY_NODE_BIN || env?.ANTIGRAVITY_NODE_BINARY;
  if (typeof explicit === 'string' && explicit.trim()) {
    return makeResult(explicit.trim());
  }
  const base = String(execPath || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (base === 'node' || base === 'node.exe') {
    return makeResult(execPath);
  }
  if (versions?.electron && execPath) {
    return makeResult(execPath, { ELECTRON_RUN_AS_NODE: '1' });
  }
  const pathDirs = String(env?.PATH || env?.Path || '').split(delimiter).filter(Boolean);
  const binName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathDirs) {
    const p = join(dir, binName);
    if (existsFn(p)) return makeResult(p);
  }
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
          join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
        ]
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of candidates) {
    if (c && existsFn(c)) return makeResult(c);
  }
  return makeResult(execPath || 'node');
}

export function resolveNodeLoaderArgs(execArgv = process.execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if (arg === '--import' || arg === '--loader' || arg === '--require' || arg === '-r') {
      if (i + 1 < execArgv.length) out.push(arg, execArgv[++i]);
    } else if (/^--(?:import|loader|require)=/.test(arg)) {
      out.push(arg);
    }
  }
  if (!out.some((a) => a.includes('sidecar_sdk'))) {
    const sdkLoader = join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js');
    if (existsSync(sdkLoader)) out.push('--import', pathToFileURL(sdkLoader).href);
  }
  return out;
}

export function escapeHtml(text = '') {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export function buildDiagnosticPageHtml(problemOrConfig, detailsOrOutput = {}, options = {}) {
  const isConfigObj = problemOrConfig && typeof problemOrConfig === 'object';
  const problem = isConfigObj ? problemOrConfig.problem || 'custom' : String(problemOrConfig || 'failed');
  const details = isConfigObj
    ? { ...problemOrConfig, ...(typeof detailsOrOutput === 'object' ? detailsOrOutput : { output: detailsOrOutput }) }
    : typeof detailsOrOutput === 'object' && detailsOrOutput !== null
      ? detailsOrOutput
      : { output: String(detailsOrOutput ?? '') };
  const title = details.title || options.title || 'Sidecar';
  const pageId = options.pageId || randomUUID();
  const safeTitle = escapeHtml(title);
  const cmdDisplay = escapeHtml(details.command || 'node server.mjs');
  const fixCommand = escapeHtml(details.remediationCommand || 'npm install && npm run setup');
  const out = String(details.output || '').trim();
  let body = '';

  if (isConfigObj && (details.intro || Array.isArray(details.steps))) {
    const stepsHtml = Array.isArray(details.steps) && details.steps.length
      ? `<ol>${details.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
      : '';
    body =
      `<h1>${safeTitle}</h1>` +
      (details.intro ? `<p>${escapeHtml(details.intro)}</p>` : '') +
      stepsHtml +
      (out ? `<pre class="output">${escapeHtml(out)}</pre>` : '');
  } else if (problem === 'not-installed' || problem === 'missing-deps') {
    body =
      `<h1>${safeTitle} dependencies are missing</h1>` +
      `<p>${escapeHtml(details.message || `${title} could not find its required runtime files (${details.missing || 'node_modules'}).`)}</p>` +
      `<p>Run this command in your terminal, then click <strong>Retry</strong>:</p><pre>${fixCommand}</pre>`;
  } else if (problem === 'outdated') {
    body =
      `<h1>${safeTitle} needs to be updated</h1>` +
      `<p>This version of <code>${cmdDisplay}</code> cannot run ${safeTitle}.</p>` +
      `<p>Update it by running:</p><pre>${fixCommand}</pre><p>Then click <strong>Retry</strong>.</p>`;
  } else {
    body =
      `<h1>${safeTitle} stopped</h1>` +
      `<p><code>${cmdDisplay}</code> exited with code ${escapeHtml(String(details.exitCode ?? -1))}.</p>` +
      (out ? `<pre class="output">${escapeHtml(out)}</pre>` : '') +
      `<p>Click <strong>Retry</strong> to start it again.</p>`;
  }

  const retryLabel = escapeHtml(details.retryLabel || 'Retry');
  const pageMarker = `<meta name="${LAUNCHER_META_NAME}" content="${escapeHtml(pageId)}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${pageMarker}
<title>${safeTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
  }
  body {
    margin: 0;
    padding: 24px;
    max-width: 720px;
    line-height: 1.5;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 12px;
  }
  pre {
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.15);
    white-space: pre-wrap;
    word-break: break-all;
  }
  pre.output {
    max-height: 240px;
    overflow: auto;
    font-size: 12px;
  }
  button {
    font: inherit;
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid rgba(127, 127, 127, 0.5);
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
</head>
<body>
${body}
<button id="retry" type="button">${retryLabel}</button>
<script>
  const button = document.getElementById("retry");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Starting\\u2026";
    try { await fetch("/__launcher/retry" + (location.search || ""), { method: "POST" }); } catch (e) {}
    const poll = async () => {
      try {
        const response = await fetch(location.href, { cache: "no-store" });
        if (response.ok && !(await response.text()).includes(${JSON.stringify(pageMarker)})) {
          location.reload();
          return;
        }
      } catch (e) {}
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  });
</script>
</body>
</html>
`;
}

export function showPageUntilRetry(problemOrPort, detailsOrHtml = {}, options = {}) {
  const directMode = typeof problemOrPort === 'number';
  const port = directMode ? problemOrPort : Number(options.port ?? process.env[WEB_PORT_ENV_VAR] ?? 0);
  const host = options.host || '127.0.0.1';
  const html = directMode
    ? String(detailsOrHtml || '')
    : buildDiagnosticPageHtml(problemOrPort, detailsOrHtml, { title: options.title || 'Sidecar' });

  return new Promise((resolve, reject) => {
    let server = createServer((req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = urlObj.pathname;
      if (req.method === 'POST' && pathname === '/__launcher/retry') {
        const origin = req.headers?.origin;
        if (!isLoopbackOrigin(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Forbidden origin' }));
          return;
        }
        const expectedToken = options.uiToken ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? '';
        if (expectedToken) {
          const provided = String(req.headers?.['x-sidecar-token'] || urlObj.searchParams.get('token') || '');
          if (!verifySidecarToken(provided, expectedToken)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Forbidden: invalid sidecar token' }));
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, retried: true }));
        const active = server;
        server = null;
        if (active) {
          active.close(() => resolve({ retried: true }));
          active.closeAllConnections?.();
        } else {
          resolve({ retried: true });
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method Not Allowed');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });

    server.on('error', (err) => {
      options.onError?.(err);
      reject(err);
    });

    server.listen(port, host, () => {
      const boundPort = server?.address()?.port ?? port;
      options.onListening?.({ port: boundPort, server });
    });
  });
}

export function runSidecarProcess(
  command,
  args = [],
  { cwd = process.cwd(), env = process.env, maxOutputChars = MAX_OUTPUT_CHARS, spawnFn = spawn, forwardOutput = true, onChildSpawned } = {}
) {
  return new Promise((resolve) => {
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk.toString()).slice(-maxOutputChars);
    };
    const spawnEnv =
      process.versions?.electron && command === process.execPath
        ? { ...env, ELECTRON_RUN_AS_NODE: '1' }
        : env;
    const proc = spawnFn(command, args, { cwd, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    onChildSpawned?.(proc);
    proc.stdout?.on('data', (c) => {
      if (forwardOutput) process.stdout.write(c);
      keep(c);
    });
    proc.stderr?.on('data', (c) => {
      if (forwardOutput) process.stderr.write(c);
      keep(c);
    });
    proc.on('error', (err) => {
      onChildSpawned?.(null);
      resolve(err.code === 'ENOENT' ? { notFound: true, output } : { exitCode: -1, output: `${output}\n${err.message}`.trim() });
    });
    proc.on('close', (code, signal) => {
      onChildSpawned?.(null);
      resolve({ exitCode: code ?? -1, signal, output });
    });
  });
}

export function killChild(child, sig = 'SIGTERM', { platform = process.platform, execFn = execFileSync } = {}) {
  if (!child) return false;
  if (platform === 'win32' && Number(child.pid) > 0) {
    try {
      execFn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      // fall back to child.kill
    }
  }
  try {
    child.kill?.(sig);
    return true;
  } catch {
    return false;
  }
}

export async function runSidecarLauncher({
  name = 'sidecar',
  sidecarName,
  title,
  entryScript = '',
  targetPath = '',
  args = [],
  commandCandidates,
  repoRoot,
  cwd,
  env = process.env,
  requiredPaths = [],
  remediationCommand = 'npm install && npm run setup',
  checkPrerequisites,
  precheck,
  isOutdatedError,
  port,
  host = '127.0.0.1',
  maxOutputChars = MAX_OUTPUT_CHARS,
  spawnFn = spawn,
  forwardOutput = true,
  onDiagnosticListening,
  registerSignalHandlers = false,
  exitFn = (code) => code,
} = {}) {
  const effectiveTitle = title || sidecarName || name;
  const effectiveScript = entryScript || targetPath;
  const effectiveCwd = cwd || repoRoot || process.cwd();
  const effectivePort = Number(port ?? env?.[WEB_PORT_ENV_VAR] ?? process.env[WEB_PORT_ENV_VAR] ?? 0);
  let child = null;
  let stopping = false;

  if (registerSignalHandlers) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        stopping = true;
        if (child) killChild(child, sig);
        else exitFn(0);
      });
    }
  }

  for (;;) {
    const missingPath = requiredPaths.find((p) => !existsSync(p));
    if (missingPath) {
      await showPageUntilRetry('missing-deps', { missing: missingPath, remediationCommand }, { title: effectiveTitle, port: effectivePort, host, onListening: onDiagnosticListening });
      continue;
    }

    const preFn = precheck || checkPrerequisites;
    if (typeof preFn === 'function') {
      const pre = await preFn();
      if (pre && (pre.ok === false || pre.title || pre.intro)) {
        const cfg = pre.ok === false ? (pre.problem || 'missing-deps') : pre;
        const det = pre.ok === false ? { remediationCommand, ...pre.details } : {};
        await showPageUntilRetry(cfg, det, { title: effectiveTitle, port: effectivePort, host, onListening: onDiagnosticListening });
        continue;
      }
    }

    const candidates = typeof commandCandidates === 'function'
      ? commandCandidates()
      : Array.isArray(commandCandidates) && commandCandidates.length > 0
        ? commandCandidates
        : (() => {
            const resolved = resolveNodeBinary({ env });
            return [{ command: resolved.command, env: resolved.env, args: [...resolveNodeLoaderArgs(), ...(effectiveScript ? [effectiveScript, ...args] : args)] }];
          })();

    let ran = null;
    for (const item of candidates) {
      const cmd = typeof item === 'string' ? item : item.command;
      const cmdArgs = typeof item === 'string' ? args : item.args || args;
      const itemEnv = typeof item === 'object' && item?.env ? item.env : {};
      const result = await runSidecarProcess(cmd, cmdArgs, {
        cwd: effectiveCwd, env: { ...env, ...itemEnv, ANTIGRAVITY_LAUNCHER_PID: String(process.pid) }, maxOutputChars, spawnFn, forwardOutput,
        onChildSpawned: (proc) => { child = proc; },
      });
      if (result.notFound) continue;
      ran = { command: `${cmd} ${cmdArgs.join(' ')}`.trim(), ...result };
      break;
    }

    if (ran === null) {
      await showPageUntilRetry('not-installed', { remediationCommand }, { title: effectiveTitle, port: effectivePort, host, onListening: onDiagnosticListening });
    } else if (stopping || ran.signal) {
      return exitFn(0);
    } else if (ran.exitCode === 0 || ran.exitCode === USAGE_ERROR_EXIT_CODE) {
      return exitFn(ran.exitCode);
    } else if (typeof isOutdatedError === 'function' && isOutdatedError(ran)) {
      await showPageUntilRetry('outdated', { remediationCommand, ...ran }, { title: effectiveTitle, port: effectivePort, host, onListening: onDiagnosticListening });
    } else {
      await showPageUntilRetry('failed', { remediationCommand, ...ran }, { title: effectiveTitle, port: effectivePort, host, onListening: onDiagnosticListening });
    }
  }
}
