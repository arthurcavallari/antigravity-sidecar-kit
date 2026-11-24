import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHETYPES,
  PLUGIN_COMPONENTS,
  resolveProjectNames,
} from '../lib/scaffolder/naming.mjs';
import {
  buildBaseLayer,
  buildPackageMetadata,
} from '../lib/scaffolder/base-layer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, 'lib', 'scaffolder', 'workflows');

describe('lib/scaffolder/naming.mjs', () => {
  it('exports frozen ARCHETYPES and PLUGIN_COMPONENTS constants', () => {
    assert.equal(Object.isFrozen(ARCHETYPES), true);
    assert.deepEqual(ARCHETYPES, ['sidecar-ui', 'sidecar-mcp', 'plugin', 'plugin-sidecar']);
    assert.equal(Object.isFrozen(PLUGIN_COMPONENTS), true);
    assert.deepEqual(PLUGIN_COMPONENTS, ['skills', 'mcp', 'rules', 'hooks', 'agents']);
  });

  it('resolves bare sidecar names with antigravity- and agy- bin aliases', () => {
    const res = resolveProjectNames({ name: 'notes', archetype: 'sidecar-ui' });
    assert.equal(res.id, 'notes');
    assert.equal(res.pkgName, 'antigravity-notes');
    assert.equal(res.folderName, 'antigravity-notes');
    assert.equal(res.displayName, 'Notes');
    assert.deepEqual(res.bins, {
      'antigravity-notes': './setup.mjs',
      'agy-notes': './setup.mjs',
    });

    const defaulted = resolveProjectNames({ name: 'notes' });
    assert.deepEqual(defaulted, res);
  });

  it('resolves bare plugin names with agy- prefix and empty bins', () => {
    const res = resolveProjectNames({ name: 'porter', archetype: 'plugin' });
    assert.equal(res.id, 'porter');
    assert.equal(res.pkgName, 'agy-porter');
    assert.equal(res.folderName, 'agy-porter');
    assert.equal(res.pluginName, 'agy-porter');
    assert.equal(res.displayName, 'Porter');
    assert.deepEqual(res.bins, {});
  });

  it('preserves explicit agy-/antigravity- prefixes without double-prefixing', () => {
    const porter = resolveProjectNames({
      name: 'agy-plugin-porter',
      archetype: 'plugin-sidecar',
    });
    assert.equal(porter.id, 'plugin-porter');
    assert.equal(porter.pkgName, 'agy-plugin-porter');
    assert.equal(porter.folderName, 'agy-plugin-porter');
    assert.equal(porter.pluginName, 'agy-plugin-porter');
    assert.equal(porter.displayName, 'Plugin Porter');
    assert.deepEqual(porter.bins, {});

    const monitor = resolveProjectNames({
      name: 'antigravity-context-monitor',
      archetype: 'sidecar-mcp',
    });
    assert.equal(monitor.id, 'context-monitor');
    assert.equal(monitor.pkgName, 'antigravity-context-monitor');
    assert.equal(monitor.folderName, 'antigravity-context-monitor');
    assert.deepEqual(monitor.bins, {
      'antigravity-context-monitor': './setup.mjs',
      'agy-context-monitor': './setup.mjs',
    });

    const longPrefix = resolveProjectNames({
      name: 'antigravity-sidecar-metrics',
      archetype: 'sidecar-ui',
    });
    assert.equal(longPrefix.id, 'metrics');
    assert.equal(longPrefix.pkgName, 'antigravity-sidecar-metrics');
    assert.equal(longPrefix.folderName, 'antigravity-sidecar-metrics');
    assert.deepEqual(longPrefix.bins, {
      'antigravity-metrics': './setup.mjs',
      'agy-metrics': './setup.mjs',
      'antigravity-sidecar-metrics': './setup.mjs',
    });
  });

  it('resolves scoped npm names cleanly without leaking / into folderName or pluginName', () => {
    const sidecar = resolveProjectNames({
      name: '@acme/my-tool',
      archetype: 'sidecar-mcp',
    });
    assert.equal(sidecar.id, 'my-tool');
    assert.equal(sidecar.pkgName, '@acme/my-tool');
    assert.equal(sidecar.folderName, 'my-tool');
    assert.equal(sidecar.displayName, 'My Tool');
    assert.deepEqual(sidecar.bins, {
      'antigravity-my-tool': './setup.mjs',
      'agy-my-tool': './setup.mjs',
      'my-tool': './setup.mjs',
    });

    const plugin = resolveProjectNames({
      name: '@acme/agy-lint',
      archetype: 'plugin',
    });
    assert.equal(plugin.id, 'lint');
    assert.equal(plugin.pkgName, '@acme/agy-lint');
    assert.equal(plugin.folderName, 'agy-lint');
    assert.equal(plugin.pluginName, 'agy-lint');
    assert.equal(plugin.pluginName.includes('/'), false);

    const dotted = resolveProjectNames({
      name: '@acme/my.plugin',
      archetype: 'plugin',
    });
    assert.equal(dotted.pkgName, '@acme/my.plugin');
    assert.equal(dotted.folderName, 'my.plugin');
    assert.equal(dotted.pluginName, 'my-plugin');
    assert.match(dotted.pluginName, /^[a-z0-9][a-z0-9_-]*$/);
  });

  it('honors valid pkgName override and rejects invalid pkgName override', () => {
    const custom = resolveProjectNames({
      name: 'notes',
      archetype: 'sidecar-ui',
      pkgName: '@custom/notes-sidecar',
    });
    assert.equal(custom.id, 'notes');
    assert.equal(custom.pkgName, '@custom/notes-sidecar');
    assert.equal(custom.folderName, 'notes-sidecar');
    assert.deepEqual(custom.bins, {
      'antigravity-notes': './setup.mjs',
      'agy-notes': './setup.mjs',
      'notes-sidecar': './setup.mjs',
    });

    for (const badPkg of ['../escape', 'foo/bar', '@acme/a/b', 'UPPERCASE', 'bad\\pkg']) {
      assert.throws(
        () => resolveProjectNames({ name: 'notes', archetype: 'sidecar-ui', pkgName: badPkg }),
        /package name|invalid/i,
        `expected pkgName "${badPkg}" to throw`
      );
    }
  });

  it('rejects reserved Hangar sidecar IDs, path traversal, separator abuse, and unknown archetypes', () => {
    for (const reserved of [
      'hangar',
      'sidecar-hub',
      'antigravity-hangar',
      'agy-hangar',
      'antigravity-sidecar-hub',
      '@acme/hangar',
      '@acme/sidecar-hub',
    ]) {
      for (const archetype of ['sidecar-ui', 'sidecar-mcp']) {
        assert.throws(
          () => resolveProjectNames({ name: reserved, archetype }),
          /reserved/i,
          `expected "${reserved}" on "${archetype}" to be rejected`
        );
      }
    }

    for (const hostile of [
      '',
      '   ',
      '../escape',
      '..\\escape',
      'C:escape',
      'foo/bar',
      '/escape',
      '\\escape',
      '@acme/../escape',
      '@acme/foo/bar',
      '@/foo',
      '@acme/',
      '.',
      '..',
      '.hidden',
      '---',
    ]) {
      assert.throws(
        () => resolveProjectNames({ name: hostile, archetype: 'sidecar-ui' }),
        /invalid|required|separator|traversal/i,
        `expected "${hostile}" to be rejected`
      );
    }

    for (const badArchetype of ['unknown', '', null, 'sidecar']) {
      assert.throws(
        () => resolveProjectNames({ name: 'notes', archetype: badArchetype }),
        /archetype/i,
        `expected archetype "${String(badArchetype)}" to be rejected`
      );
    }
  });
});

describe('lib/scaffolder/base-layer.mjs & workflows', () => {
  it('stores all 6 static workflow YAML files with LF line endings and zero maintainer leaks', () => {
    const expectedFiles = [
      'codeql.yml',
      'dependabot.yml',
      'release-plugin.yml',
      'release-sidecar.yml',
      'test-plugin.yml',
      'test-sidecar.yml',
    ];
    const actualFiles = readdirSync(WORKFLOWS_DIR).sort();
    assert.deepEqual(actualFiles, expectedFiles);

    for (const file of expectedFiles) {
      const content = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      assert.equal(content.includes('\r'), false, `${file} must use LF line endings`);
      assert.equal(
        /arthurcavallari/i.test(content),
        false,
        `${file} must not leak maintainer username`
      );
      assert.equal(
        content.includes('agy-plugin-porter'),
        false,
        `${file} must not hardcode agy-plugin-porter`
      );
    }
  });

  it('emits base hygiene files and sidecar CI workflows with zero maintainer leaks', () => {
    const names = resolveProjectNames({ name: 'notes', archetype: 'sidecar-ui' });
    const files = buildBaseLayer({
      archetype: 'sidecar-ui',
      ...names,
      description: 'Workspace scratchpad sidecar.',
      authorName: 'Jane Doe',
      githubOwner: '',
      ci: true,
      year: 2026,
    });

    assert.equal(files instanceof Map, true);
    for (const key of [
      '.gitignore',
      '.gitattributes',
      'LICENSE',
      'README.md',
      '.github/dependabot.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/test.yml',
      '.github/workflows/release.yml',
    ]) {
      assert.equal(files.has(key), true, `missing ${key}`);
    }
    assert.equal(files.has('.github/FUNDING.yml'), false);

    const gitignore = files.get('.gitignore');
    assert.match(gitignore, /^node_modules\/$/m);
    assert.match(gitignore, /^dist\/$/m);
    assert.match(gitignore, /^docs\/superpowers\/$/m);

    const gitattributes = files.get('.gitattributes');
    assert.match(gitattributes, /eol=lf/);
    assert.match(gitattributes, /^\*\.yml text eol=lf$/m);

    const license = files.get('LICENSE');
    assert.match(license, /^MIT License/m);
    assert.match(license, /Copyright \(c\) 2026 Jane Doe/);

    const releaseYml = files.get('.github/workflows/release.yml');
    assert.match(releaseYml, /hub-manifest\.json/);
    assert.match(releaseYml, /npm publish --provenance --access public/);

    for (const [relPath, content] of files.entries()) {
      assert.equal(content.includes('\r'), false, `${relPath} must use LF line endings`);
      assert.equal(
        /arthurcavallari|FUNDING\.yml/i.test(content),
        false,
        `${relPath} must not contain maintainer defaults`
      );
    }
  });

  it('omits all .github/* entries when ci is false', () => {
    const names = resolveProjectNames({ name: 'notes', archetype: 'sidecar-mcp' });
    const files = buildBaseLayer({
      archetype: 'sidecar-mcp',
      ...names,
      authorName: 'Jane Doe',
      ci: false,
    });

    assert.deepEqual(
      [...files.keys()].sort(),
      ['.gitattributes', '.gitignore', 'LICENSE', 'README.md']
    );
  });

  it('renders plugin release.yml with private guard and substituted pluginName tarball uploads', () => {
    const names = resolveProjectNames({ name: 'porter', archetype: 'plugin' });
    const files = buildBaseLayer({
      archetype: 'plugin',
      ...names,
      description: 'Sample Antigravity plugin.',
      authorName: 'Octo Cat',
      githubOwner: 'octocat',
      ci: true,
    });

    const releaseYml = files.get('.github/workflows/release.yml');
    assert.equal(releaseYml.includes('{{PLUGIN_NAME}}'), false);
    assert.match(releaseYml, /require\('\.\/package\.json'\)\.private/);
    assert.match(releaseYml, /npm publish --provenance --access public/);
    assert.equal(
      releaseYml.includes('dist/plugin/agy-porter-plugin-${version}.tgz'),
      true
    );
    assert.equal(
      releaseYml.includes('dist/plugin/agy-porter-plugin-${version}.tgz.sha256'),
      true
    );

    const testYml = files.get('.github/workflows/test.yml');
    assert.match(testYml, /ubuntu-latest/);
    assert.match(testYml, /windows-latest/);
    assert.match(testYml, /npm run build:plugin/);
    assert.match(testYml, /npm run test:pack/);

    assert.throws(
      () =>
        buildBaseLayer({
          archetype: 'plugin',
          id: 'porter',
          pkgName: 'agy-porter',
          folderName: 'agy-porter',
          pluginName: 'bad; rm -rf /',
        }),
      /pluginName/i
    );
  });

  it('builds package.json repository metadata conditionally on githubOwner', () => {
    const withoutGithub = buildPackageMetadata({
      pkgName: 'antigravity-notes',
      folderName: 'antigravity-notes',
      description: 'Notes sidecar.',
      authorName: 'Jane Doe',
      githubOwner: '',
    });
    assert.deepEqual(withoutGithub.author, { name: 'Jane Doe' });
    assert.equal('homepage' in withoutGithub, false);
    assert.equal('bugs' in withoutGithub, false);
    assert.equal('repository' in withoutGithub, false);
    assert.equal('funding' in withoutGithub, false);

    const withGithub = buildPackageMetadata({
      pkgName: '@octocat/my-tool',
      folderName: 'my-tool',
      description: 'Scoped sidecar.',
      authorName: 'Octo Cat',
      githubOwner: 'octocat',
    });
    assert.deepEqual(withGithub.author, {
      name: 'Octo Cat',
      url: 'https://github.com/octocat',
    });
    assert.equal(withGithub.homepage, 'https://github.com/octocat/my-tool#readme');
    assert.deepEqual(withGithub.bugs, {
      url: 'https://github.com/octocat/my-tool/issues',
    });
    assert.deepEqual(withGithub.repository, {
      type: 'git',
      url: 'git+https://github.com/octocat/my-tool.git',
    });
    assert.equal('funding' in withGithub, false);

    assert.throws(
      () =>
        buildPackageMetadata({
          pkgName: 'antigravity-notes',
          folderName: 'antigravity-notes',
          authorName: 'Jane Doe',
          githubOwner: '../bad/owner',
        }),
      /github/i
    );
  });
});
