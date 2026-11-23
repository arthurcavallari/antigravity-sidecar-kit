import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  PromptCancelledError,
  gitConfigUserName,
  promptText,
  resolveInitOptions,
  selectMany,
  selectOne,
} from '../lib/cli/prompts.mjs';
import { ARCHETYPES } from '../lib/scaffolder/naming.mjs';

function createMockTty({ isTTY = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = isTTY;
  output.isTTY = isTTY;

  const rawModeCalls = [];
  input.setRawMode = (flag) => {
    rawModeCalls.push(flag);
    input.isRaw = Boolean(flag);
  };

  let outputBuffer = '';
  output.on('data', (chunk) => {
    outputBuffer += chunk.toString('utf8');
  });

  return {
    input,
    output,
    rawModeCalls,
    getOutput: () => outputBuffer,
  };
}

const ARCHETYPE_OPTIONS = ARCHETYPES.map((value) => ({
  value,
  label: value,
}));

const COMPONENT_OPTIONS = [
  { value: 'skills', label: 'skills' },
  { value: 'mcp', label: 'mcp' },
  { value: 'rules', label: 'rules' },
  { value: 'hooks', label: 'hooks' },
  { value: 'agents', label: 'agents' },
];

describe('lib/cli/prompts.mjs', () => {
  describe('gitConfigUserName', () => {
    it('returns trimmed git user.name and falls back to empty string on error', () => {
      const found = gitConfigUserName({
        execFn: (cmd, args) => {
          assert.equal(cmd, 'git');
          assert.ok(Array.isArray(args));
          return '  Jane Developer \r\n';
        },
      });
      assert.equal(found, 'Jane Developer');

      const missing = gitConfigUserName({
        execFn: () => {
          throw new Error('git not configured');
        },
      });
      assert.equal(missing, '');
    });
  });

  describe('selectOne', () => {
    it('picks index 1 (sidecar-mcp) on Down arrow + Enter, hides cursor on start, and restores raw mode + cursor on finish', async () => {
      const { input, output, rawModeCalls, getOutput } = createMockTty();

      const pending = selectOne({
        message: 'Select archetype:',
        options: ARCHETYPE_OPTIONS,
        initialIndex: 0,
        input,
        output,
      });

      assert.equal(getOutput().includes('\x1b[?25l'), true, 'should hide cursor on start');
      assert.deepEqual(rawModeCalls, [true]);

      input.write('\x1b[B');
      input.write('\r');

      const chosen = await pending;
      assert.equal(chosen, 'sidecar-mcp');
      assert.deepEqual(rawModeCalls, [true, false]);
      assert.equal(getOutput().includes('\x1b[?25h'), true, 'should show cursor on finish');
      assert.equal(input.listenerCount('data'), 0);
      assert.equal(input.listenerCount('end'), 0);
      assert.equal(input.listenerCount('close'), 0);
    });

    it('supports Up arrow wrap-around, j/k navigation, and combined escape+enter chunks', async () => {
      const first = createMockTty();
      const upWrap = selectOne({
        message: 'Select archetype:',
        options: ARCHETYPE_OPTIONS,
        initialIndex: 0,
        input: first.input,
        output: first.output,
      });
      first.input.write('\x1b[A\r');
      assert.equal(await upWrap, 'plugin-sidecar');

      const second = createMockTty();
      const vimKeys = selectOne({
        message: 'Select archetype:',
        options: ARCHETYPE_OPTIONS,
        initialIndex: 0,
        input: second.input,
        output: second.output,
      });
      second.input.write('jjk\n');
      assert.equal(await vimKeys, 'sidecar-mcp');
    });
  });

  describe('selectMany', () => {
    it('toggles selections with Space, enforces minSelected: 1 when nothing is selected, and returns selected values on Enter', async () => {
      const { input, output, rawModeCalls, getOutput } = createMockTty();

      const pending = selectMany({
        message: 'Plugin components:',
        options: COMPONENT_OPTIONS,
        initialValues: [],
        minSelected: 1,
        input,
        output,
      });

      // Press Enter with nothing selected -> must not resolve yet
      input.write('\r');
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(getOutput(), /at least 1/i);
      assert.deepEqual(rawModeCalls, [true]);

      // Toggle 'skills' on, move down to 'mcp', move down to 'rules', toggle 'rules' on, move up to 'mcp', toggle on then off, submit
      input.write(' '); // select skills
      input.write('\x1b[B\x1b[B '); // select rules
      input.write('\r');

      const chosen = await pending;
      assert.deepEqual(chosen, ['skills', 'rules']);
      assert.deepEqual(rawModeCalls, [true, false]);
      assert.equal(getOutput().includes('\x1b[?25l'), true);
      assert.equal(getOutput().includes('\x1b[?25h'), true);
      assert.equal(input.listenerCount('data'), 0);
    });

    it('pre-selects initialValues and allows empty selection when minSelected is 0', async () => {
      const { input, output } = createMockTty();

      const pending = selectMany({
        message: 'Plugin components:',
        options: COMPONENT_OPTIONS,
        initialValues: ['skills', 'mcp'],
        minSelected: 0,
        input,
        output,
      });

      // Uncheck 'skills' and 'mcp', then submit empty
      input.write(' \x1b[B \r');
      const chosen = await pending;
      assert.deepEqual(chosen, []);
    });
  });

  describe('promptText', () => {
    it('returns defaultValue on empty Enter, handles Backspace, and re-prompts on validation failure', async () => {
      const first = createMockTty();
      const withDefault = promptText({
        message: 'Display title:',
        defaultValue: 'Notes',
        input: first.input,
        output: first.output,
      });
      first.input.write('\r');
      assert.equal(await withDefault, 'Notes');
      assert.deepEqual(first.rawModeCalls, [true, false]);

      const second = createMockTty();
      const validated = promptText({
        message: 'Project name:',
        validate: (val) => {
          if (!val || val.includes('..')) {
            throw new Error('Invalid project name');
          }
        },
        input: second.input,
        output: second.output,
      });
      second.input.write('../bad\r');
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(second.getOutput(), /Invalid project name/);

      second.input.write('notesx\x7f\r');
      assert.equal(await validated, 'notes');
      assert.deepEqual(second.rawModeCalls, [true, false]);
    });
  });

  describe('Cancellation safety (Ctrl+C, Esc, and abrupt stream end/close)', () => {
    for (const [label, trigger] of [
      ['Ctrl+C (\\x03)', (stream) => stream.write('\x03')],
      ['Esc (\\x1b)', (stream) => stream.write('\x1b')],
      ['abrupt input.end()', (stream) => stream.end()],
      ['abrupt input.destroy()', (stream) => stream.destroy()],
    ]) {
      it(`selectOne rejects with PromptCancelledError on ${label} and restores raw mode + cursor`, async () => {
        const { input, output, rawModeCalls, getOutput } = createMockTty();
        const pending = selectOne({
          message: 'Select archetype:',
          options: ARCHETYPE_OPTIONS,
          input,
          output,
        });

        input.write('\x1b[B');
        trigger(input);

        await assert.rejects(
          () => pending,
          (err) => {
            assert.equal(err instanceof PromptCancelledError, true);
            assert.equal(err.code, 'PROMPT_CANCELLED');
            assert.equal(err.exitCode, 130);
            return true;
          }
        );

        assert.deepEqual(rawModeCalls, [true, false]);
        assert.equal(getOutput().includes('\x1b[?25h'), true);
        assert.equal(input.listenerCount('data'), 0);
      });

      it(`selectMany rejects with PromptCancelledError on ${label} and restores raw mode + cursor`, async () => {
        const { input, output, rawModeCalls, getOutput } = createMockTty();
        const pending = selectMany({
          message: 'Plugin components:',
          options: COMPONENT_OPTIONS,
          initialValues: ['skills'],
          input,
          output,
        });

        trigger(input);

        await assert.rejects(
          () => pending,
          (err) => {
            assert.equal(err instanceof PromptCancelledError, true);
            assert.equal(err.code, 'PROMPT_CANCELLED');
            assert.equal(err.exitCode, 130);
            return true;
          }
        );

        assert.deepEqual(rawModeCalls, [true, false]);
        assert.equal(getOutput().includes('\x1b[?25h'), true);
        assert.equal(input.listenerCount('data'), 0);
      });

      it(`promptText rejects with PromptCancelledError on ${label} and restores raw mode`, async () => {
        const { input, output, rawModeCalls } = createMockTty();
        const pending = promptText({
          message: 'Project name:',
          input,
          output,
        });

        input.write('partial');
        trigger(input);

        await assert.rejects(
          () => pending,
          (err) => {
            assert.equal(err instanceof PromptCancelledError, true);
            assert.equal(err.code, 'PROMPT_CANCELLED');
            assert.equal(err.exitCode, 130);
            return true;
          }
        );

        assert.deepEqual(rawModeCalls, [true, false]);
        assert.equal(input.listenerCount('data'), 0);
      });
    }
  });

  describe('resolveInitOptions', () => {
    it('never touches input or raw mode when isTTY is false or yes is true, requires name, and fills defaults', async () => {
      const poisonInput = {
        isTTY: true,
        setRawMode() {
          throw new Error('setRawMode must not be called in non-interactive mode');
        },
        on() {
          throw new Error('input.on must not be called in non-interactive mode');
        },
        resume() {
          throw new Error('input.resume must not be called in non-interactive mode');
        },
      };
      const silentOutput = new PassThrough();
      silentOutput.isTTY = true;

      await assert.rejects(
        () => resolveInitOptions({}, { input: poisonInput, output: silentOutput, isTTY: false }),
        /name/i
      );

      const nonTty = await resolveInitOptions(
        { name: 'notes' },
        {
          input: poisonInput,
          output: silentOutput,
          isTTY: false,
          defaultAuthor: 'Test Author',
        }
      );
      assert.deepEqual(nonTty, {
        name: 'notes',
        archetype: 'sidecar-ui',
        title: 'Notes',
        entrypoint: 'aux_pane',
        components: ['skills', 'mcp'],
        author: 'Test Author',
        github: '',
        ci: true,
        hideTitleBar: false,
        force: false,
      });

      const yesFlag = await resolveInitOptions(
        {
          name: 'porter',
          archetype: 'plugin',
          yes: true,
          ci: false,
          hideTitleBar: true,
          force: true,
        },
        {
          input: poisonInput,
          output: silentOutput,
          isTTY: true,
          defaultAuthor: 'Bot Author',
        }
      );
      assert.deepEqual(yesFlag, {
        name: 'porter',
        archetype: 'plugin',
        title: 'Porter',
        entrypoint: 'aux_pane',
        components: ['skills', 'mcp'],
        author: 'Bot Author',
        github: '',
        ci: false,
        hideTitleBar: true,
        force: true,
      });
    });

    it('prompts only for omitted options on sidecar-* (skipping pre-supplied name and skipping components)', async () => {
      const { input, output, getOutput } = createMockTty();

      // Pre-supply name: 'notes'. Missing: archetype, title, entrypoint, author, github.
      // Choose archetype index 1 ('sidecar-mcp'), custom title, entrypoint index 1 ('sidebar'), default author, github 'octocat'.
      input.end('\x1b[B\rWorkspace Notes\r\x1b[B\r\roctocat\r');

      const resolved = await resolveInitOptions(
        { name: 'notes' },
        {
          input,
          output,
          isTTY: true,
          defaultAuthor: 'Jane Doe',
        }
      );

      const rendered = getOutput();
      assert.doesNotMatch(rendered, /Project name:/);
      assert.doesNotMatch(rendered, /Plugin components:/);
      assert.match(rendered, /Display title:/);

      assert.deepEqual(resolved, {
        name: 'notes',
        archetype: 'sidecar-mcp',
        title: 'Workspace Notes',
        entrypoint: 'sidebar',
        components: ['skills', 'mcp'],
        author: 'Jane Doe',
        github: 'octocat',
        ci: true,
        hideTitleBar: false,
        force: false,
      });
    });

    it('skips entrypoint when plugin archetype is chosen and prompts for components with minSelected = 1', async () => {
      const { input, output, getOutput } = createMockTty();

      // Nothing pre-supplied:
      // 1. name -> 'my-plug'
      // 2. archetype -> Down twice ('plugin')
      // 3. title -> default ('My Plug')
      // (entrypoint MUST be skipped!)
      // 4. components -> pre-checked ['skills', 'mcp']; move down 3x to 'hooks' and toggle on -> ['skills', 'mcp', 'hooks']
      // 5. author -> 'Octo Cat'
      // 6. github -> '' (default)
      input.end('my-plug\r\x1b[B\x1b[B\r\r\x1b[B\x1b[B\x1b[B \rOcto Cat\r\r');

      const resolved = await resolveInitOptions(
        {},
        {
          input,
          output,
          isTTY: true,
          defaultAuthor: 'Fallback Author',
        }
      );

      const rendered = getOutput();
      assert.match(rendered, /Project name:/);
      assert.doesNotMatch(rendered, /entrypoint/i);
      assert.match(rendered, /components/i);

      assert.deepEqual(resolved, {
        name: 'my-plug',
        archetype: 'plugin',
        title: 'My Plug',
        entrypoint: 'aux_pane',
        components: ['skills', 'mcp', 'hooks'],
        author: 'Octo Cat',
        github: '',
        ci: true,
        hideTitleBar: false,
        force: false,
      });
    });

    it('prompts both entrypoint and components (with minSelected = 0) when plugin-sidecar is chosen', async () => {
      const { input, output, getOutput } = createMockTty();

      // Pre-supply name: 'hybrid'
      // 1. archetype -> Down 3x ('plugin-sidecar')
      // 2. title -> default ('Hybrid')
      // 3. entrypoint -> Down 2x ('full_pane')
      // 4. components -> uncheck 'skills' and 'mcp' so 0 selected (allowed for plugin-sidecar!)
      // 5. author -> default ('Hybrid Author')
      // 6. github -> 'https://github.com/octocat/' (normalized to 'octocat')
      input.end('\x1b[B\x1b[B\x1b[B\r\r\x1b[B\x1b[B\r \x1b[B \r\rhttps://github.com/octocat/\r');

      const resolved = await resolveInitOptions(
        { name: 'hybrid', targetDir: '/tmp/hybrid-out' },
        {
          input,
          output,
          isTTY: true,
          defaultAuthor: 'Hybrid Author',
        }
      );

      const rendered = getOutput();
      assert.match(rendered, /entrypoint/i);
      assert.match(rendered, /components/i);

      assert.deepEqual(resolved, {
        name: 'hybrid',
        archetype: 'plugin-sidecar',
        title: 'Hybrid',
        entrypoint: 'full_pane',
        components: [],
        author: 'Hybrid Author',
        github: 'octocat',
        ci: true,
        hideTitleBar: false,
        force: false,
        targetDir: '/tmp/hybrid-out',
      });
    });

    it('handles split CSI escape sequences across chunks and resolves git author fallback chain', async () => {
      const splitMenu = createMockTty();
      const chosenPromise = selectOne({
        message: 'Select archetype:',
        options: ARCHETYPE_OPTIONS,
        input: splitMenu.input,
        output: splitMenu.output,
      });
      splitMenu.input.write('\x1b[');
      splitMenu.input.write('B\r');
      assert.equal(await chosenPromise, 'sidecar-mcp');

      const splitText = createMockTty();
      const textPromise = promptText({
        message: 'Display title:',
        input: splitText.input,
        output: splitText.output,
      });
      splitText.input.write('Notes\x1b[');
      splitText.input.write('D\r');
      assert.equal(await textPromise, 'Notes');

      const fromGit = await resolveInitOptions(
        { name: 'notes' },
        {
          isTTY: false,
          execFn: () => 'Git User\n',
        }
      );
      assert.equal(fromGit.author, 'Git User');

      const fallbackAuthor = await resolveInitOptions(
        { name: 'notes' },
        {
          isTTY: false,
          execFn: () => {
            throw new Error('no git');
          },
        }
      );
      assert.equal(fallbackAuthor.author, 'Sidecar Author');
    });

    it('never touches input in interactive mode when all relevant flags are explicitly provided', async () => {
      const poisonInput = {
        isTTY: true,
        setRawMode() {
          throw new Error('unexpected raw mode');
        },
        on() {
          throw new Error('unexpected listener');
        },
      };
      const silentOutput = new PassThrough();
      silentOutput.isTTY = true;

      const resolved = await resolveInitOptions(
        {
          name: 'porter',
          archetype: 'plugin',
          title: 'Plugin Porter',
          components: 'skills,rules',
          author: 'Octo Cat',
          github: 'octocat',
        },
        { input: poisonInput, output: silentOutput }
      );

      assert.deepEqual(resolved, {
        name: 'porter',
        archetype: 'plugin',
        title: 'Plugin Porter',
        entrypoint: 'aux_pane',
        components: ['skills', 'rules'],
        author: 'Octo Cat',
        github: 'octocat',
        ci: true,
        hideTitleBar: false,
        force: false,
      });
    });
  });
});
