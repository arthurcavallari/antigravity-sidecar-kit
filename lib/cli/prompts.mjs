/**
 * @fileoverview Zero-dependency interactive TTY prompts and init option resolver for Antigravity archetypes.
 */

import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { normalizeEntrypoint } from '../scaffolder.mjs';
import { normalizeGithubOwner } from '../scaffolder/base-layer.mjs';
import {
  ARCHETYPES,
  PLUGIN_COMPONENTS,
  resolveProjectNames,
} from '../scaffolder/naming.mjs';
import { normalizePluginComponents } from '../scaffolder/plugin-layers.mjs';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const ARCHETYPE_PROMPT_OPTIONS = Object.freeze([
  { value: 'sidecar-ui', label: 'sidecar-ui', hint: 'Auxiliary Pane webview sidecar' },
  { value: 'sidecar-mcp', label: 'sidecar-mcp', hint: 'Auxiliary Pane sidecar + stdio MCP server' },
  { value: 'plugin', label: 'plugin', hint: 'Native Antigravity plugin bundle' },
  { value: 'plugin-sidecar', label: 'plugin-sidecar', hint: 'Native plugin + companion sidecar' },
]);

const ENTRYPOINT_PROMPT_OPTIONS = Object.freeze([
  { value: 'aux_pane', label: 'aux_pane', hint: 'Auxiliary Pane panel (default)' },
  { value: 'sidebar', label: 'sidebar', hint: 'Sidebar panel' },
  { value: 'full_pane', label: 'full_pane', hint: 'Full editor pane view' },
]);

const COMPONENT_PROMPT_OPTIONS = Object.freeze(
  PLUGIN_COMPONENTS.map((value) => ({ value, label: value }))
);

const STREAM_STATE = new WeakMap();

function getStreamState(input) {
  if (!input || typeof input !== 'object') {
    return { remainder: '' };
  }
  let state = STREAM_STATE.get(input);
  if (!state) {
    state = { remainder: '' };
    STREAM_STATE.set(input, state);
  }
  return state;
}

function writeOut(output, text) {
  if (output && typeof output.write === 'function') {
    output.write(text);
  }
}

function isStreamEnded(input) {
  return Boolean(input?.readableEnded || input?.destroyed || input?.closed);
}

/**
 * Thrown when an interactive prompt is cancelled via Ctrl+C, Esc, or premature stream EOF.
 */
export class PromptCancelledError extends Error {
  constructor(message = 'Prompt cancelled by user.') {
    super(message);
    this.name = 'PromptCancelledError';
    this.code = 'PROMPT_CANCELLED';
    this.exitCode = 130;
  }
}

/**
 * Reads `git config --get user.name` safely, returning `''` on any error.
 *
 * @param {{ execFn?: typeof execFileSync }} [options]
 * @returns {string}
 */
export function gitConfigUserName({ execFn = execFileSync } = {}) {
  try {
    const out = execFn('git', ['config', '--get', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });
    return String(out ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function scanCsiSequence(str, startIndex) {
  let pos = startIndex;
  while (pos < str.length) {
    const code = str.charCodeAt(pos);
    if (code >= 0x30 && code <= 0x3f) {
      pos++;
    } else {
      break;
    }
  }
  while (pos < str.length) {
    const code = str.charCodeAt(pos);
    if (code >= 0x20 && code <= 0x2f) {
      pos++;
    } else {
      break;
    }
  }
  if (pos < str.length) {
    const finalCode = str.charCodeAt(pos);
    if (finalCode >= 0x40 && finalCode <= 0x7e) {
      return { complete: true, finalByte: str[pos], next: pos + 1 };
    }
    return { complete: true, finalByte: '', next: pos + 1 };
  }
  return { complete: false, finalByte: '', next: pos };
}

function consumeSelectorToken(str, index) {
  const ch = str[index];
  if (ch === '\x03') {
    return { type: 'cancel', next: index + 1 };
  }
  if (ch === '\r') {
    return { type: 'submit', next: str[index + 1] === '\n' ? index + 2 : index + 1 };
  }
  if (ch === '\n') {
    return { type: 'submit', next: index + 1 };
  }
  if (ch === ' ') {
    return { type: 'space', next: index + 1 };
  }
  if (ch === 'k') {
    return { type: 'up', next: index + 1 };
  }
  if (ch === 'j') {
    return { type: 'down', next: index + 1 };
  }
  if (ch === '\x1b') {
    if (str[index + 1] === '[') {
      const { complete, finalByte, next } = scanCsiSequence(str, index + 2);
      if (!complete) return { type: 'incomplete', next: index };
      if (finalByte === 'A') return { type: 'up', next };
      if (finalByte === 'B') return { type: 'down', next };
      return { type: 'ignore', next };
    }
    if (str[index + 1] === 'O') {
      if (index + 2 >= str.length) {
        return { type: 'incomplete', next: index };
      }
      const code = str.charCodeAt(index + 2);
      if (code >= 0x40 && code <= 0x7e) {
        if (str[index + 2] === 'A') return { type: 'up', next: index + 3 };
        if (str[index + 2] === 'B') return { type: 'down', next: index + 3 };
        return { type: 'ignore', next: index + 3 };
      }
    }
    return { type: 'cancel', next: index + 1 };
  }
  const cp = str.codePointAt(index);
  const step = cp !== undefined && cp > 0xffff ? 2 : 1;
  return { type: 'ignore', next: index + step };
}

function consumeTextToken(str, index) {
  const ch = str[index];
  if (ch === '\x03') {
    return { type: 'cancel', next: index + 1 };
  }
  if (ch === '\r') {
    return { type: 'submit', next: str[index + 1] === '\n' ? index + 2 : index + 1 };
  }
  if (ch === '\n') {
    return { type: 'submit', next: index + 1 };
  }
  if (ch === '\x7f' || ch === '\x08') {
    return { type: 'backspace', next: index + 1 };
  }
  if (ch === '\x15') {
    return { type: 'clear', next: index + 1 };
  }
  if (ch === '\x1b') {
    if (str[index + 1] === '[') {
      const { complete, next } = scanCsiSequence(str, index + 2);
      if (!complete) return { type: 'incomplete', next: index };
      return { type: 'ignore', next };
    }
    if (str[index + 1] === 'O') {
      if (index + 2 >= str.length) {
        return { type: 'incomplete', next: index };
      }
      const code = str.charCodeAt(index + 2);
      if (code >= 0x40 && code <= 0x7e) {
        return { type: 'ignore', next: index + 3 };
      }
    }
    return { type: 'cancel', next: index + 1 };
  }
  const cp = str.codePointAt(index);
  const step = cp !== undefined && cp > 0xffff ? 2 : 1;
  if (cp === undefined || cp < 0x20) {
    return { type: 'ignore', next: index + step };
  }
  return { type: 'char', value: str.slice(index, index + step), next: index + step };
}

function runValidation(validate, candidate) {
  if (typeof validate !== 'function') return null;
  try {
    const result = validate(candidate);
    if (result === true || result === undefined || result === null || result === '') {
      return null;
    }
    if (result === false) {
      return 'Invalid value.';
    }
    if (typeof result === 'string') {
      return result;
    }
    return null;
  } catch (err) {
    return err?.message || String(err);
  }
}

function formatTextPrompt(message, defaultValue) {
  return defaultValue ? `? ${message} (${defaultValue}) ` : `? ${message} `;
}

/**
 * Prompts for a single line of text with optional default value and validation.
 *
 * @param {{
 *   message: string,
 *   defaultValue?: string,
 *   validate?: (value: string) => unknown,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} options
 * @returns {Promise<string>}
 */
export async function promptText({
  message,
  defaultValue = '',
  validate,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const state = getStreamState(input);
  const decoder = new StringDecoder('utf8');
  const canRaw = typeof input?.setRawMode === 'function';
  let cleanup = () => {};

  try {
    if (canRaw) {
      input.setRawMode(true);
    }
    writeOut(output, formatTextPrompt(message, defaultValue));

    return await new Promise((resolve, reject) => {
      let settled = false;
      let lineBuffer = '';
      let escapeCarry = '';

      const detach = () => {
        input?.off?.('data', onData);
        input?.off?.('end', onAbort);
        input?.off?.('close', onAbort);
        input?.off?.('error', onError);
        input?.pause?.();
      };
      cleanup = detach;

      const finishResolve = (val) => {
        if (settled) return;
        settled = true;
        detach();
        resolve(val);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        state.remainder = '';
        detach();
        reject(err);
      };

      const processText = (rawStr) => {
        const chunkStr = escapeCarry ? `${escapeCarry}${rawStr}` : rawStr;
        escapeCarry = '';
        let index = 0;
        while (index < chunkStr.length && !settled) {
          const token = consumeTextToken(chunkStr, index);
          if (token.type === 'incomplete') {
            escapeCarry = chunkStr.slice(index);
            return;
          }
          index = token.next;

          if (token.type === 'cancel') {
            writeOut(output, '\n');
            finishReject(new PromptCancelledError());
            return;
          }
          if (token.type === 'backspace') {
            const chars = Array.from(lineBuffer);
            if (chars.length > 0) {
              chars.pop();
              lineBuffer = chars.join('');
              writeOut(output, '\b \b');
            }
            continue;
          }
          if (token.type === 'clear') {
            lineBuffer = '';
            continue;
          }
          if (token.type === 'char') {
            lineBuffer += token.value;
            writeOut(output, token.value);
            continue;
          }
          if (token.type === 'submit') {
            const trimmed = lineBuffer.trim();
            const candidate = trimmed !== '' ? trimmed : String(defaultValue ?? '');
            const errorMsg = runValidation(validate, candidate);
            if (errorMsg) {
              lineBuffer = '';
              writeOut(output, `\n  ✖ ${errorMsg}\n${formatTextPrompt(message, defaultValue)}`);
              continue;
            }
            state.remainder = chunkStr.slice(index);
            writeOut(output, '\n');
            finishResolve(candidate);
            return;
          }
        }
      };

      function onData(chunk) {
        const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (str) {
          processText(str);
        }
      }

      function onAbort() {
        const trailing = decoder.end();
        if (trailing && !settled) {
          processText(trailing);
        }
        if (!settled) {
          finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        }
      }

      function onError(err) {
        finishReject(err);
      }

      if (state.remainder) {
        const pending = state.remainder;
        state.remainder = '';
        processText(pending);
        if (settled) return;
      }

      if (isStreamEnded(input)) {
        finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        return;
      }

      input?.on?.('data', onData);
      input?.on?.('end', onAbort);
      input?.on?.('close', onAbort);
      input?.on?.('error', onError);
      input?.resume?.();
    });
  } finally {
    cleanup();
    if (canRaw) {
      try {
        input.setRawMode(false);
      } catch {}
    }
  }
}

function clearFramePrefix(renderedLines) {
  return renderedLines > 1 ? `\x1b[${renderedLines - 1}A\r\x1b[J` : '\r\x1b[J';
}

/**
 * Interactive single-choice arrow-key selector.
 *
 * @param {{
 *   message: string,
 *   options: Array<{ value: string, label?: string, hint?: string }>,
 *   initialIndex?: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} options
 * @returns {Promise<string>}
 */
export async function selectOne({
  message,
  options,
  initialIndex = 0,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('selectOne requires a non-empty options array.');
  }

  let cursor =
    Number.isInteger(initialIndex) && initialIndex >= 0 && initialIndex < options.length
      ? initialIndex
      : 0;
  const state = getStreamState(input);
  const decoder = new StringDecoder('utf8');
  const canRaw = typeof input?.setRawMode === 'function';
  let cleanup = () => {};

  try {
    if (canRaw) {
      input.setRawMode(true);
    }
    writeOut(output, HIDE_CURSOR);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let renderedLines = 0;
      let escapeCarry = '';

      const render = () => {
        const lines = [`? ${message} (Use arrow keys)`];
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const marker = i === cursor ? '❯' : ' ';
          const label = opt.label ?? opt.value;
          const hint = opt.hint ? ` — ${opt.hint}` : '';
          lines.push(`  ${marker} ${label}${hint}`);
        }
        const prefix = renderedLines > 0 ? clearFramePrefix(renderedLines) : '';
        renderedLines = lines.length;
        writeOut(output, `${prefix}${lines.join('\n')}`);
      };

      const detach = () => {
        input?.off?.('data', onData);
        input?.off?.('end', onAbort);
        input?.off?.('close', onAbort);
        input?.off?.('error', onError);
        input?.pause?.();
      };
      cleanup = detach;

      const finishResolve = (val, label) => {
        if (settled) return;
        settled = true;
        detach();
        const prefix = renderedLines > 0 ? clearFramePrefix(renderedLines) : '';
        writeOut(output, `${prefix}✔ ${message} ${label}\n`);
        resolve(val);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        state.remainder = '';
        detach();
        if (renderedLines > 0) {
          writeOut(output, `${clearFramePrefix(renderedLines)}✖ ${message} (cancelled)\n`);
        }
        reject(err);
      };

      const processChunk = (rawStr) => {
        const chunkStr = escapeCarry ? `${escapeCarry}${rawStr}` : rawStr;
        escapeCarry = '';
        let index = 0;
        while (index < chunkStr.length && !settled) {
          const token = consumeSelectorToken(chunkStr, index);
          if (token.type === 'incomplete') {
            escapeCarry = chunkStr.slice(index);
            return;
          }
          index = token.next;

          if (token.type === 'cancel') {
            finishReject(new PromptCancelledError());
            return;
          }
          if (token.type === 'up') {
            cursor = (cursor - 1 + options.length) % options.length;
            render();
            continue;
          }
          if (token.type === 'down') {
            cursor = (cursor + 1) % options.length;
            render();
            continue;
          }
          if (token.type === 'submit') {
            state.remainder = chunkStr.slice(index);
            const chosen = options[cursor];
            finishResolve(chosen.value, chosen.label ?? chosen.value);
            return;
          }
        }
      };

      function onData(chunk) {
        const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (str) {
          processChunk(str);
        }
      }

      function onAbort() {
        const trailing = decoder.end();
        if (trailing && !settled) {
          processChunk(trailing);
        }
        if (!settled) {
          finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        }
      }

      function onError(err) {
        finishReject(err);
      }

      render();

      if (state.remainder) {
        const pending = state.remainder;
        state.remainder = '';
        processChunk(pending);
        if (settled) return;
      }

      if (isStreamEnded(input)) {
        finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        return;
      }

      input?.on?.('data', onData);
      input?.on?.('end', onAbort);
      input?.on?.('close', onAbort);
      input?.on?.('error', onError);
      input?.resume?.();
    });
  } finally {
    cleanup();
    writeOut(output, SHOW_CURSOR);
    if (canRaw) {
      try {
        input.setRawMode(false);
      } catch {}
    }
  }
}

/**
 * Interactive multi-select arrow-key + Space checkbox selector.
 *
 * @param {{
 *   message: string,
 *   options: Array<{ value: string, label?: string, hint?: string }>,
 *   initialValues?: string[],
 *   minSelected?: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} options
 * @returns {Promise<string[]>}
 */
export async function selectMany({
  message,
  options,
  initialValues = [],
  minSelected = 0,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('selectMany requires a non-empty options array.');
  }
  if (minSelected > options.length) {
    throw new Error('selectMany minSelected cannot exceed options.length.');
  }

  let cursor = 0;
  const validValues = new Set(options.map((opt) => opt.value));
  const selected = new Set(
    Array.isArray(initialValues) ? initialValues.filter((val) => validValues.has(val)) : []
  );
  const state = getStreamState(input);
  const decoder = new StringDecoder('utf8');
  const canRaw = typeof input?.setRawMode === 'function';
  let cleanup = () => {};

  try {
    if (canRaw) {
      input.setRawMode(true);
    }
    writeOut(output, HIDE_CURSOR);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let renderedLines = 0;
      let warning = '';
      let escapeCarry = '';

      const render = () => {
        const lines = [`? ${message} (Space to toggle, Enter to confirm)`];
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const pointer = i === cursor ? '❯' : ' ';
          const box = selected.has(opt.value) ? '◉' : '◯';
          const label = opt.label ?? opt.value;
          const hint = opt.hint ? ` — ${opt.hint}` : '';
          lines.push(`  ${pointer} ${box} ${label}${hint}`);
        }
        if (warning) {
          lines.push(`  ✖ ${warning}`);
        }
        const prefix = renderedLines > 0 ? clearFramePrefix(renderedLines) : '';
        renderedLines = lines.length;
        writeOut(output, `${prefix}${lines.join('\n')}`);
      };

      const detach = () => {
        input?.off?.('data', onData);
        input?.off?.('end', onAbort);
        input?.off?.('close', onAbort);
        input?.off?.('error', onError);
        input?.pause?.();
      };
      cleanup = detach;

      const finishResolve = (values) => {
        if (settled) return;
        settled = true;
        detach();
        const summary = values.length > 0 ? values.join(', ') : 'none';
        const prefix = renderedLines > 0 ? clearFramePrefix(renderedLines) : '';
        writeOut(output, `${prefix}✔ ${message} ${summary}\n`);
        resolve(values);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        state.remainder = '';
        detach();
        if (renderedLines > 0) {
          writeOut(output, `${clearFramePrefix(renderedLines)}✖ ${message} (cancelled)\n`);
        }
        reject(err);
      };

      const processChunk = (rawStr) => {
        const chunkStr = escapeCarry ? `${escapeCarry}${rawStr}` : rawStr;
        escapeCarry = '';
        let index = 0;
        while (index < chunkStr.length && !settled) {
          const token = consumeSelectorToken(chunkStr, index);
          if (token.type === 'incomplete') {
            escapeCarry = chunkStr.slice(index);
            return;
          }
          index = token.next;

          if (token.type === 'cancel') {
            finishReject(new PromptCancelledError());
            return;
          }
          if (token.type === 'up') {
            cursor = (cursor - 1 + options.length) % options.length;
            render();
            continue;
          }
          if (token.type === 'down') {
            cursor = (cursor + 1) % options.length;
            render();
            continue;
          }
          if (token.type === 'space') {
            const target = options[cursor].value;
            if (selected.has(target)) {
              selected.delete(target);
            } else {
              selected.add(target);
            }
            if (selected.size >= minSelected) {
              warning = '';
            }
            render();
            continue;
          }
          if (token.type === 'submit') {
            if (selected.size < minSelected) {
              warning = `Please select at least ${minSelected} option${minSelected === 1 ? '' : 's'}.`;
              render();
              continue;
            }
            state.remainder = chunkStr.slice(index);
            const ordered = options
              .filter((opt) => selected.has(opt.value))
              .map((opt) => opt.value);
            finishResolve(ordered);
            return;
          }
        }
      };

      function onData(chunk) {
        const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (str) {
          processChunk(str);
        }
      }

      function onAbort() {
        const trailing = decoder.end();
        if (trailing && !settled) {
          processChunk(trailing);
        }
        if (!settled) {
          finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        }
      }

      function onError(err) {
        finishReject(err);
      }

      render();

      if (state.remainder) {
        const pending = state.remainder;
        state.remainder = '';
        processChunk(pending);
        if (settled) return;
      }

      if (isStreamEnded(input)) {
        finishReject(new PromptCancelledError('Prompt cancelled: input stream ended.'));
        return;
      }

      input?.on?.('data', onData);
      input?.on?.('end', onAbort);
      input?.on?.('close', onAbort);
      input?.on?.('error', onError);
      input?.resume?.();
    });
  } finally {
    cleanup();
    writeOut(output, SHOW_CURSOR);
    if (canRaw) {
      try {
        input.setRawMode(false);
      } catch {}
    }
  }
}

function hasExplicitString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Resolves CLI `init` options across non-interactive (`!isTTY` / `--yes`) and partial-interactive flows.
 *
 * @param {Record<string, unknown>} [parsedFlags]
 * @param {{
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   isTTY?: boolean,
 *   defaultAuthor?: string,
 *   execFn?: typeof execFileSync,
 * }} [opts]
 * @returns {Promise<{
 *   name: string,
 *   archetype: string,
 *   title: string,
 *   entrypoint: string,
 *   components: string[],
 *   author: string,
 *   github: string,
 *   ci: boolean,
 *   hideTitleBar: boolean,
 *   force: boolean,
 *   targetDir?: string,
 *   pkgName?: string,
 *   description?: string,
 * }>}
 */
export async function resolveInitOptions(parsedFlags = {}, opts = {}) {
  const flags = parsedFlags ?? {};
  const {
    input = process.stdin,
    output = process.stdout,
    isTTY,
    defaultAuthor,
    execFn,
  } = opts ?? {};

  const isInteractive =
    isTTY !== undefined
      ? Boolean(isTTY && !flags.yes)
      : Boolean(input?.isTTY && output?.isTTY && !flags.yes);

  let preArchetype = '';
  if (hasExplicitString(flags.archetype)) {
    preArchetype = flags.archetype.trim();
    if (!ARCHETYPES.includes(preArchetype)) {
      throw new Error(
        `Unknown archetype "${preArchetype}". Expected one of: ${ARCHETYPES.join(', ')}`
      );
    }
  }

  let name;
  if (hasExplicitString(flags.name)) {
    name = flags.name.trim();
  } else if (!isInteractive) {
    throw new Error('A valid project name is required in non-interactive mode.');
  } else {
    name = await promptText({
      message: 'Project name:',
      validate: (candidate) => {
        resolveProjectNames({
          name: candidate,
          archetype: preArchetype || 'plugin',
          pkgName: flags.pkgName,
        });
      },
      input,
      output,
    });
  }

  let archetype;
  if (preArchetype) {
    archetype = preArchetype;
  } else if (isInteractive) {
    archetype = await selectOne({
      message: 'Select archetype:',
      options: ARCHETYPE_PROMPT_OPTIONS,
      initialIndex: 0,
      input,
      output,
    });
  } else {
    archetype = 'sidecar-ui';
  }

  const names = resolveProjectNames({
    name,
    archetype,
    pkgName: flags.pkgName,
  });

  let title;
  if (hasExplicitString(flags.title)) {
    title = flags.title.trim();
  } else if (isInteractive) {
    title = await promptText({
      message: 'Display title:',
      defaultValue: names.displayName,
      input,
      output,
    });
  } else {
    title = names.displayName;
  }

  const hasSidecar =
    archetype === 'sidecar-ui' || archetype === 'sidecar-mcp' || archetype === 'plugin-sidecar';

  let entrypoint;
  if (hasExplicitString(flags.entrypoint)) {
    entrypoint = flags.entrypoint.trim();
    normalizeEntrypoint(entrypoint);
  } else if (isInteractive && hasSidecar) {
    entrypoint = await selectOne({
      message: 'UI entrypoint:',
      options: ENTRYPOINT_PROMPT_OPTIONS,
      initialIndex: 0,
      input,
      output,
    });
  } else {
    entrypoint = 'aux_pane';
  }

  const isPlugin = archetype === 'plugin' || archetype === 'plugin-sidecar';

  let components;
  if (flags.components !== undefined && flags.components !== null) {
    components = normalizePluginComponents(flags.components, {
      archetype: isPlugin ? archetype : 'plugin-sidecar',
    });
  } else if (isInteractive && isPlugin) {
    components = await selectMany({
      message: 'Plugin components:',
      options: COMPONENT_PROMPT_OPTIONS,
      initialValues: ['skills', 'mcp'],
      minSelected: archetype === 'plugin' ? 1 : 0,
      input,
      output,
    });
  } else {
    components = ['skills', 'mcp'];
  }

  const resolveFallbackAuthor = () =>
    defaultAuthor ?? (gitConfigUserName({ execFn }) || 'Sidecar Author');

  let author;
  if (hasExplicitString(flags.author)) {
    author = flags.author.trim();
  } else if (isInteractive) {
    author = await promptText({
      message: 'Author name:',
      defaultValue: resolveFallbackAuthor(),
      input,
      output,
    });
  } else {
    author = resolveFallbackAuthor();
  }

  let github;
  if (flags.github !== undefined && flags.github !== null) {
    github = normalizeGithubOwner(flags.github);
  } else if (isInteractive) {
    const rawGithub = await promptText({
      message: 'GitHub owner/org (optional):',
      defaultValue: '',
      validate: (candidate) => {
        normalizeGithubOwner(candidate);
      },
      input,
      output,
    });
    github = normalizeGithubOwner(rawGithub);
  } else {
    github = '';
  }

  return {
    name,
    archetype,
    title,
    entrypoint,
    components,
    author,
    github,
    ci: flags.ci !== false,
    hideTitleBar: Boolean(flags.hideTitleBar),
    force: Boolean(flags.force),
    ...(flags.targetDir !== undefined ? { targetDir: flags.targetDir } : {}),
    ...(flags.pkgName !== undefined ? { pkgName: flags.pkgName } : {}),
    ...(flags.description !== undefined ? { description: flags.description } : {}),
  };
}
