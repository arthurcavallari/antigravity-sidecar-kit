import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readJsonSafe,
  readJsonFile,
  writeJsonNoBom,
  updateAgySidecarConfig,
} from '../lib/config.mjs';

describe('antigravity-sidecar-kit/config BOM-safe JSON helpers and config.json updater', () => {
  it('strips UTF-8 BOM on read, writes without BOM, and supports strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-config-test-'));
    try {
      const p = join(dir, 'bom.json');
      writeFileSync(p, '\uFEFF{"hello":"world"}\n', 'utf8');
      assert.deepEqual(readJsonSafe(p, {}), { hello: 'world' });

      const outPath = join(dir, 'nested', 'out.json');
      writeJsonNoBom(outPath, { a: 1 });
      const rawBytes = readFileSync(outPath);
      assert.notEqual(rawBytes[0], 0xef);
      assert.deepEqual(readJsonFile(outPath), { a: 1 });

      const badPath = join(dir, 'bad.json');
      writeFileSync(badPath, '{ truncated', 'utf8');
      assert.deepEqual(readJsonSafe(badPath, { fallback: true }), { fallback: true });
      assert.throws(() => readJsonFile(badPath, { strict: true }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateAgySidecarConfig preserves projectId and never clobbers malformed config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-agy-cfg-test-'));
    try {
      const cfgPath = join(dir, 'config.json');
      writeJsonNoBom(cfgPath, {
        userSettings: { themeMode: 'THEME_MODE_DARK' },
        sidecars: {
          hangar: {
            enabled: false,
            projectId: 'preserve-uuid-999',
          },
        },
      });

      const ok = updateAgySidecarConfig('hangar', true, cfgPath);
      assert.equal(ok, true);
      const updated = readJsonSafe(cfgPath, {});
      assert.equal(updated.sidecars.hangar.enabled, true);
      assert.equal(updated.sidecars.hangar.projectId, 'preserve-uuid-999');

      // Malformed config.json must never be overwritten
      const corruptContent = '{ "sidecars": { "hangar": ';
      writeFileSync(cfgPath, corruptContent, 'utf8');
      const okCorrupt = updateAgySidecarConfig('hangar', false, cfgPath);
      assert.equal(okCorrupt, false);
      assert.equal(readFileSync(cfgPath, 'utf8'), corruptContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
