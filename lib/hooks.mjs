/**
 * @fileoverview Cross-harness lifecycle hook envelope normalizer, non-truncating stdout writer,
 * and atomic filesystem session store for Antigravity, Claude Code, Cursor, and Gemini CLI.
 */

import { createHash } from 'node:crypto';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './config.mjs';

const EVENT_ALIASES = Object.freeze({
    beforeSubmitPrompt: 'UserPromptSubmit',
    BeforeAgent: 'UserPromptSubmit',
    preToolUse: 'PreToolUse',
    BeforeTool: 'PreToolUse',
    PreTool: 'PreToolUse',
    postToolUse: 'PostToolUse',
    AfterTool: 'PostToolUse',
    PostTool: 'PostToolUse',
    sessionStart: 'SessionStart',
    stop: 'Stop',
    AfterAgent: 'Stop',
});

function safeJsonParse(str, fallback = {}) {
    if (typeof str !== 'string') return fallback;
    const trimmed = str.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return fallback;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

/**
 * Normalizes a raw hook stdin object across Antigravity, Claude Code, Cursor, and Gemini CLI.
 *
 * @param {object} [rawObj={}]
 * @param {Record<string, string|undefined>} [env=process.env]
 */
export function normalizeHookEnvelope(rawObj = {}, env = process.env) {
    const obj = rawObj && typeof rawObj === 'object' ? rawObj : {};
    const safeEnv = env && typeof env === 'object' ? env : {};

    let platform = 'claude';
    if (
        (obj.toolCall !== null && typeof obj.toolCall === 'object') ||
        obj.invocationNum !== undefined ||
        obj.trajectoryId !== undefined
    ) {
        platform = 'antigravity';
    } else if (
        obj.cursor_version !== undefined ||
        obj.conversation_id !== undefined ||
        obj.hook_event_name === 'beforeSubmitPrompt' ||
        Array.isArray(obj.workspace_roots)
    ) {
        platform = 'cursor';
    } else if (
        obj.hook_event_name === 'BeforeAgent' ||
        obj.hook_event_name === 'BeforeTool' ||
        obj.hook_event_name === 'AfterTool'
    ) {
        platform = 'gemini';
    }

    const sessionId =
        obj.sessionId ??
        obj.conversationId ??
        obj.session_id ??
        obj.conversation_id ??
        safeEnv.CLAUDE_SESSION_ID ??
        safeEnv.CURSOR_TRACE_ID ??
        null;

    const workspaceRoot =
        obj.workspacePaths?.[0] ??
        obj.workspace_roots?.[0] ??
        obj.cwd ??
        safeEnv.CLAUDE_PROJECT_DIR ??
        safeEnv.CURSOR_PROJECT_DIR ??
        process.cwd();

    const rawEvent = obj.hook_event_name ?? obj.event ?? obj.hookEvent ?? 'PreToolUse';
    const hookEvent = EVENT_ALIASES[rawEvent] ?? rawEvent;

    let toolName = '';
    let mcpServerName = null;
    let mcpToolName = null;
    let toolInput = {};

    if (obj.toolCall !== null && typeof obj.toolCall === 'object') {
        const tc = obj.toolCall;
        const args =
            typeof tc.args === 'string'
                ? safeJsonParse(tc.args, {})
                : tc.args && typeof tc.args === 'object'
                    ? tc.args
                    : {};

        if (tc.name === 'call_mcp_tool' || tc.name === 'mcp_tool') {
            mcpServerName = args.ServerName ?? args.server_name ?? null;
            mcpToolName = args.ToolName ?? args.tool_name ?? null;
            const rawArguments = args.Arguments ?? args.arguments;
            toolInput =
                typeof rawArguments === 'string'
                    ? safeJsonParse(rawArguments, {})
                    : rawArguments && typeof rawArguments === 'object'
                        ? rawArguments
                        : {};
            toolName =
                mcpServerName && mcpToolName
                    ? `mcp__${mcpServerName}__${mcpToolName}`
                    : tc.name;
        } else {
            toolName = tc.name ?? '';
            toolInput = args;
        }
    } else {
        toolName = obj.tool_name ?? obj.toolName ?? '';
        const rawInput = obj.tool_input ?? obj.toolInput;
        toolInput =
            typeof rawInput === 'string'
                ? safeJsonParse(rawInput, {})
                : rawInput && typeof rawInput === 'object'
                    ? rawInput
                    : {};
    }

    if (
        (!mcpServerName || !mcpToolName) &&
        typeof toolName === 'string' &&
        toolName.startsWith('mcp__')
    ) {
        const rest = toolName.slice(5);
        const sepIdx = rest.indexOf('__');
        if (sepIdx > 0 && sepIdx + 2 < rest.length) {
            mcpServerName = rest.slice(0, sepIdx);
            mcpToolName = rest.slice(sepIdx + 2);
        }
    }

    const toolResponse = obj.tool_response ?? obj.toolResponse ?? null;
    const prompt = obj.prompt ?? obj.user_prompt ?? obj.userPrompt ?? '';
    const pluginRoot =
        safeEnv.PLUGIN_ROOT ??
        safeEnv.CLAUDE_PLUGIN_ROOT ??
        safeEnv.CURSOR_PLUGIN_ROOT ??
        workspaceRoot;

    return {
        raw: obj,
        platform,
        hookEvent,
        sessionId,
        toolName,
        mcpServerName,
        mcpToolName,
        toolInput,
        toolResponse,
        prompt,
        workspaceRoot,
        pluginRoot,
    };
}

/**
 * Reads UTF-8 chunks from stream up to maxBytes, strips UTF-8 BOM, parses JSON,
 * and returns normalizeHookEnvelope(parsed, env).
 */
export async function readHookEnvelope({
    stream = process.stdin,
    maxBytes = 10 * 1024 * 1024,
    env = process.env,
    strict = false,
} = {}) {
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        totalBytes += buf.length;
        if (totalBytes > maxBytes) {
            throw new Error(`Hook stdin payload exceeded maxBytes (${maxBytes})`);
        }
        chunks.push(buf);
    }

    const rawText = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
    let parsed = {};
    if (rawText) {
        try {
            const candidate = JSON.parse(rawText);
            parsed = candidate && typeof candidate === 'object' ? candidate : {};
        } catch (err) {
            if (strict) throw err;
            parsed = {};
        }
    }
    return normalizeHookEnvelope(parsed, env);
}

/**
 * Formats a hook decision/context result into the target host's expected JSON string
 * (or '' when Antigravity PreToolUse has no opinion).
 */
export function formatHookResult(
    result = {},
    { platform = 'antigravity', hookEvent = 'PreToolUse' } = {}
) {
    const res = result && typeof result === 'object' ? result : {};
    const {
        decision,
        reason,
        additionalContext,
        updatedInput,
        systemMessage,
        envFileVars,
    } = res;

    const hasDecision = typeof decision === 'string' && decision.length > 0;
    const hasReason = typeof reason === 'string' && reason.length > 0;
    const hasContext = typeof additionalContext === 'string' && additionalContext.length > 0;
    const hasUpdatedInput =
        updatedInput !== null &&
        typeof updatedInput === 'object' &&
        Object.keys(updatedInput).length > 0;
    const hasSystemMessage = typeof systemMessage === 'string' && systemMessage.length > 0;
    const hasEnvVars =
        envFileVars !== null &&
        typeof envFileVars === 'object' &&
        Object.keys(envFileVars).length > 0;

    if (
        !hasDecision &&
        !hasReason &&
        !hasContext &&
        !hasUpdatedInput &&
        !hasSystemMessage &&
        !hasEnvVars
    ) {
        return platform === 'antigravity' && hookEvent === 'PreToolUse' ? '' : '{}';
    }

    const out = {};
    const specific = { hookEventName: hookEvent };
    let hasSpecific = false;

    if (hasDecision) {
        if (platform === 'antigravity') {
            out.decision = decision;
        } else {
            const normalizedDecision = decision === 'force_ask' ? 'ask' : decision;
            out.decision = normalizedDecision;
            specific.permissionDecision = normalizedDecision;
            hasSpecific = true;
        }
    }

    if (hasReason) {
        out.reason = reason;
        if (platform !== 'antigravity') {
            specific.permissionDecisionReason = reason;
            hasSpecific = true;
        }
    }

    if (hasContext) {
        out.additionalContext = additionalContext;
        if (platform === 'cursor') {
            out.additional_context = additionalContext;
        }
        specific.additionalContext = additionalContext;
        hasSpecific = true;
        if (
            platform === 'antigravity' &&
            (hookEvent === 'SessionStart' || hookEvent === 'UserPromptSubmit' || hookEvent === 'PreInvocation')
        ) {
            out.injectSteps = [{ systemMessage: { systemMessage: additionalContext } }];
        }
    }

    if (hasUpdatedInput) {
        out.updatedInput = updatedInput;
        if (platform === 'antigravity') {
            out.overwrite = updatedInput;
        }
        specific.updatedInput = updatedInput;
        hasSpecific = true;
    }

    if (hasSystemMessage) {
        out.systemMessage = systemMessage;
    }

    if (hasEnvVars) {
        out.envFileVars = envFileVars;
    }

    if (hasSpecific) {
        out.hookSpecificOutput = specific;
    }

    return JSON.stringify(out);
}

/**
 * Writes the formatted hook result to stream and waits for the write callback / 'drain'
 * event before resolving so large >64 KB payloads are never truncated on exit.
 */
export function writeHookResult(
    result = {},
    { stream = process.stdout, platform = 'antigravity', hookEvent = 'PreToolUse' } = {}
) {
    const payload = formatHookResult(result, { platform, hookEvent });
    if (!payload) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            if (typeof stream.off === 'function') {
                stream.off('drain', onDrain);
                stream.off('error', onError);
            } else if (typeof stream.removeListener === 'function') {
                stream.removeListener('drain', onDrain);
                stream.removeListener('error', onError);
            }
        };

        const finish = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve();
        };

        const onDrain = () => finish();
        const onError = (err) => finish(err);

        if (typeof stream.once === 'function') {
            stream.once('error', onError);
        }

        const canContinue = stream.write(payload, 'utf8', (err) => {
            finish(err);
        });

        if (canContinue === false && typeof stream.once === 'function') {
            stream.once('drain', onDrain);
        } else if (typeof stream._write !== 'function' && stream.write.length < 3) {
            queueMicrotask(() => finish());
        }
    });
}

function sanitizeSegment(value, fallback = 'default') {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    const cleaned = raw
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '');
    return cleaned.slice(0, 120) || fallback;
}

/**
 * Creates a cross-process atomic session store backed by `<baseDir || os.tmpdir()>/agy-hook-state/<namespace>/<sessionId>/seen-keys.d`.
 */
export function createHookSessionStore(namespace, sessionId, { baseDir } = {}) {
    const rootDir = baseDir || tmpdir();
    const safeNs = sanitizeSegment(namespace, 'default-ns');
    const safeSession = sanitizeSegment(sessionId, 'default-session');
    const sessionDir = join(rootDir, 'agy-hook-state', safeNs, safeSession);
    const seenDir = join(sessionDir, 'seen-keys.d');
    const statePath = join(sessionDir, 'state.json');

    mkdirSync(seenDir, { recursive: true });
    try {
        const now = Date.now();
        for (const name of readdirSync(sessionDir)) {
            if (name.includes('.tmp.')) {
                const p = join(sessionDir, name);
                try {
                    if (now - statSync(p).mtimeMs > 60_000) rmSync(p, { force: true });
                } catch {}
            }
        }
    } catch {}

    const resolveKeyFile = (key) => {
        const raw = String(key ?? '').trim();
        const safePrefix = sanitizeSegment(raw, '').slice(0, 80);
        if (!safePrefix) return '';
        const needsHash = safePrefix !== raw || raw.length > 80;
        const fileName = needsHash
            ? `${safePrefix}-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
            : safePrefix;
        return join(seenDir, fileName);
    };

    const claimKey = (key) => {
        const raw = String(key ?? '').trim();
        const keyPath = resolveKeyFile(raw);
        if (!keyPath) return false;
        mkdirSync(seenDir, { recursive: true });
        try {
            const fd = openSync(keyPath, 'wx');
            try {
                writeFileSync(fd, raw, 'utf8');
            } finally {
                closeSync(fd);
            }
            return true;
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                return false;
            }
            throw err;
        }
    };

    const hasKey = (key) => {
        const keyPath = resolveKeyFile(key);
        if (!keyPath) return false;
        return existsSync(keyPath);
    };

    const listKeys = () => {
        if (!existsSync(seenDir)) return [];
        try {
            return readdirSync(seenDir)
                .filter((name) => !name.startsWith('.'))
                .map((name) => {
                    try {
                        const content = readFileSync(join(seenDir, name), 'utf8').trim();
                        return content || name;
                    } catch {
                        return name;
                    }
                })
                .sort();
        } catch {
            return [];
        }
    };

    const clear = () => {
        rmSync(sessionDir, { recursive: true, force: true });
        mkdirSync(seenDir, { recursive: true });
    };

    const readState = (fallback = {}) => readJsonSafe(statePath, fallback);

    const writeState = (data) => {
        writeJsonAtomic(statePath, data ?? {});
    };

    return {
        dir: sessionDir,
        seenDir,
        statePath,
        claimKey,
        hasKey,
        listKeys,
        claimSkill: claimKey,
        hasSkill: hasKey,
        listSkills: listKeys,
        clear,
        readState,
        writeState,
    };
}

export const createAtomicSessionStore = createHookSessionStore;
