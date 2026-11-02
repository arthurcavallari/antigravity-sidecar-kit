import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LAUNCHER_META_NAME,
  USAGE_ERROR_EXIT_CODE,
  WEB_PORT_ENV_VAR,
  buildDiagnosticPageHtml,
  resolveNodeLoaderArgs,
  runSidecarLauncher,
  showPageUntilRetry,
} from '../lib/launcher.mjs';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('antigravity-sidecar-kit/launcher self-healing wrapper', () => {
  it('resolveNodeLoaderArgs forwards --import/--loader flags and strips --test', () => {
    const args = resolveNodeLoaderArgs(['--test', '--import', 'file:///custom/loader.js']);
    assert.equal(args.includes('--test'), false);
    assert.equal(args.includes('file:///custom/loader.js'), true);
  });

  it('buildDiagnosticPageHtml escapes HTML and embeds launcher metadata', () => {
    const html = buildDiagnosticPageHtml(
      {
        title: 'Failed <script>alert(1)</script>',
        intro: 'Check & verify',
        steps: ['Run <b>npm install</b>'],
        retryLabel: 'Retry Now',
      },
      'Error: <bad>'
    );
    assert.match(html, new RegExp(`name="${LAUNCHER_META_NAME}"`));
    assert.match(html, /Failed &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Run &lt;b&gt;npm install&lt;\/b&gt;/);
    assert.match(html, /Error: &lt;bad&gt;/);
  });

  it('showPageUntilRetry serves diagnostic HTML and resolves on POST /__launcher/retry', async () => {
    const port = await getFreePort();
    const waitPromise = showPageUntilRetry(port, '<html><body>diagnostic</body></html>');

    // Wait briefly for server to listen
    let html = '';
    for (let i = 0; i < 20; i++) {
      try {
        const getRes = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(getRes.status, 200);
        html = await getRes.text();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert.match(html, /diagnostic/);

    const methodNotAllowed = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    assert.equal(methodNotAllowed.status, 405);

    const retryRes = await fetch(`http://127.0.0.1:${port}/__launcher/retry`, { method: 'POST' });
    assert.equal(retryRes.status, 200);
    const retryJson = await retryRes.json();
    assert.equal(retryJson.ok, true);

    await waitPromise;
  });

  it('runSidecarLauncher recovers from precheck/crash via /__launcher/retry and exits on code 0 or 64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-launcher-test-'));
    try {
      const port = await getFreePort();
      const targetScript = join(dir, 'target.mjs');
      const flagFile = join(dir, 'healthy.flag');

      writeFileSync(
        targetScript,
        `import { existsSync } from 'node:fs';
if (!existsSync(${JSON.stringify(flagFile)})) {
  console.error('Simulated startup crash');
  process.exit(1);
}
process.exit(0);
`,
        'utf8'
      );

      let precheckRuns = 0;
      const launcherPromise = runSidecarLauncher({
        targetPath: targetScript,
        sidecarName: 'Test Sidecar',
        repoRoot: dir,
        env: { ...process.env, [WEB_PORT_ENV_VAR]: String(port) },
        precheck: () => {
          precheckRuns++;
          if (precheckRuns === 1) {
            return {
              title: 'Precheck blocked',
              intro: 'Waiting for first retry',
              steps: ['Click Retry'],
            };
          }
          return null;
        },
      });

      // 1st wait: precheck diagnostic page
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          const text = await res.text();
          if (text.includes('Precheck blocked')) break;
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      await fetch(`http://127.0.0.1:${port}/__launcher/retry`, { method: 'POST' });

      // 2nd wait: child process crashes because healthy.flag is missing
      let crashText = '';
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          const text = await res.text();
          if (text.includes('Simulated startup crash')) {
            crashText = text;
            break;
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.match(crashText, /Simulated startup crash/);

      // Heal the environment and trigger retry
      writeFileSync(flagFile, 'ok', 'utf8');
      await fetch(`http://127.0.0.1:${port}/__launcher/retry`, { method: 'POST' });

      const exitCode = await launcherPromise;
      assert.equal(exitCode, 0);

      // Verify USAGE_ERROR_EXIT_CODE (64) exits immediately without hanging on diagnostic page
      const usageScript = join(dir, 'usage-err.mjs');
      writeFileSync(usageScript, `process.exit(${USAGE_ERROR_EXIT_CODE});\n`, 'utf8');
      const code64 = await runSidecarLauncher({
        targetPath: usageScript,
        sidecarName: 'Usage Sidecar',
        repoRoot: dir,
        env: { ...process.env, [WEB_PORT_ENV_VAR]: String(port) },
      });
      assert.equal(code64, USAGE_ERROR_EXIT_CODE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
