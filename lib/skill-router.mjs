/**
 * @fileoverview Weighted lexical, path-glob, import, and Bash skill router with
 * byte-budget enforcement and session deduplication.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const DEFAULT_PRIORITY = 5;
const DEFAULT_MIN_SCORE = 6;
const MAX_BRACE_EXPANSIONS = 64;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_BASH_COMMAND_CHARS = 4096;
const MAX_FILE_CONTENT_CHARS = 32768;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Normalizes text for case-insensitive prompt signal matching.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escapes special characters for literal RegExp matching.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scores a user prompt against weighted `promptSignals`:
 * - `noneOf`: `-Infinity` hard suppression (word-boundary `\b...\b` for single word, substring for phrase)
 * - `phrases`: `+6` per matched phrase
 * - `allOf`: `+4` per matched conjunction group
 * - `anyOf`: `+1` per matched term, capped at `+2` total
 * - `minScore`: defaults to `6`
 *
 * @param {string} promptText
 * @param {{
 *   phrases?: string[],
 *   allOf?: string[][],
 *   anyOf?: string[],
 *   noneOf?: string[],
 *   minScore?: number
 * }} [promptSignals]
 * @returns {{ score: number, matched: boolean }}
 */
export function scorePromptSignals(promptText, promptSignals = {}) {
  const normPrompt = normalizeText(promptText);
  if (!normPrompt || !promptSignals || typeof promptSignals !== 'object') {
    return { score: 0, matched: false };
  }

  const noneOf = Array.isArray(promptSignals.noneOf) ? promptSignals.noneOf : [];
  for (const rawForbidden of noneOf) {
    const term = normalizeText(rawForbidden);
    if (!term) continue;
    if (term.includes(' ')) {
      if (normPrompt.includes(term)) {
        return { score: -Infinity, matched: false };
      }
    } else {
      const boundaryRe = /^\w+$/.test(term)
        ? new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i')
        : new RegExp(`(?:^|\\b|\\s)${escapeRegExp(term)}(?:\\b|\\s|$)`, 'i');
      if (boundaryRe.test(normPrompt)) {
        return { score: -Infinity, matched: false };
      }
    }
  }

  const phrases = (Array.isArray(promptSignals.phrases) ? promptSignals.phrases : [])
    .map(normalizeText)
    .filter(Boolean);
  const allOf = (Array.isArray(promptSignals.allOf) ? promptSignals.allOf : [])
    .filter(Array.isArray)
    .map((group) => group.map(normalizeText).filter(Boolean))
    .filter((group) => group.length > 0);
  const anyOf = (Array.isArray(promptSignals.anyOf) ? promptSignals.anyOf : [])
    .map(normalizeText)
    .filter(Boolean);

  if (phrases.length === 0 && allOf.length === 0 && anyOf.length === 0) {
    return { score: 0, matched: false };
  }

  let score = 0;

  for (const phrase of phrases) {
    if (normPrompt.includes(phrase)) {
      score += 6;
    }
  }

  for (const group of allOf) {
    if (group.every((term) => normPrompt.includes(term))) {
      score += 4;
    }
  }

  let anyOfHits = 0;
  for (const term of anyOf) {
    if (normPrompt.includes(term)) {
      anyOfHits += 1;
    }
  }
  score += Math.min(anyOfHits, 2);

  const minScore =
    typeof promptSignals.minScore === 'number' && !Number.isNaN(promptSignals.minScore)
      ? promptSignals.minScore
      : DEFAULT_MIN_SCORE;

  return {
    score,
    matched: score >= minScore,
  };
}

/**
 * Expands `{a,b}` brace alternations recursively.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
function expandBraces(pattern) {
  const openIdx = pattern.indexOf('{');
  if (openIdx === -1) return [pattern];

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return [pattern];

  const prefix = pattern.slice(0, openIdx);
  const body = pattern.slice(openIdx + 1, closeIdx);
  const suffix = pattern.slice(closeIdx + 1);

  const alternatives = [];
  let current = '';
  let innerDepth = 0;
  for (const ch of body) {
    if (ch === '{') innerDepth++;
    else if (ch === '}') innerDepth--;
    if (ch === ',' && innerDepth === 0) {
      alternatives.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  alternatives.push(current);

  const results = [];
  for (const alt of alternatives) {
    for (const expanded of expandBraces(`${prefix}${alt}${suffix}`)) {
      results.push(expanded);
      if (results.length >= MAX_BRACE_EXPANSIONS) return results;
    }
  }
  return results;
}

/**
 * Converts a path glob supporting `** /`, `/**`, `*`, `?`, and `{a,b}` into an anchored `RegExp`
 * matching normalized forward-slash paths.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegex(glob) {
  const normalizedGlob = String(glob ?? '')
    .replace(/\\/g, '/')
    .replace(/(\*\*\/)+/g, '**/')
    .replace(/(\/\*\*)+/g, '/**')
    .replace(/\*{3,}/g, '**');
  const expanded = expandBraces(normalizedGlob);
  const branches = expanded.map((sub) => {
    let re = '';
    for (let i = 0; i < sub.length; i++) {
      const ch = sub[i];
      if (ch === '/' && sub[i + 1] === '*' && sub[i + 2] === '*' && sub[i + 3] !== '/') {
        re += '(?:/.*)?';
        i += 2;
      } else if (ch === '*') {
        if (sub[i + 1] === '*') {
          if (sub[i + 2] === '/') {
            re += '(?:.+/)?';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else if ('.+^$()|[]\\'.includes(ch)) {
        re += `\\${ch}`;
      } else {
        re += ch;
      }
    }
    return re;
  });
  return new RegExp(`^(?:${branches.join('|')})$`);
}

export const globToRegExp = globToRegex;

export function isSafeRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 256) return false;
  const stripped = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  if (/\([^)]*[+*][^)]*\)[+*?{]/.test(stripped)) return false;
  if (/\([^)|]*\|[^)]*\)[+*?{]/.test(stripped)) return false;
  return true;
}

/**
 * Splits compound shell commands on `&&`, `||`, `;`, and `|`, stripping leading `VAR=val`
 * environment variable assignments.
 *
 * @param {string} commandLine
 * @returns {string[]}
 */
export function splitBashCommands(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return [];

  const rawParts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && commandLine[i - 1] !== '\\') {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble) {
      if (
        (ch === '&' && commandLine[i + 1] === '&') ||
        (ch === '|' && commandLine[i + 1] === '|')
      ) {
        rawParts.push(current);
        current = '';
        i += 1;
      } else if (ch === ';' || ch === '|') {
        rawParts.push(current);
        current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  rawParts.push(current);

  const envPrefixRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]*)\s*/;
  const commands = [];

  for (const part of rawParts) {
    let cmd = part.trim();
    while (envPrefixRe.test(cmd)) {
      cmd = cmd.replace(envPrefixRe, '').trim();
    }
    if (cmd) {
      commands.push(cmd);
    }
  }

  return commands;
}

/**
 * Extracts YAML frontmatter and Markdown body from a `SKILL.md` file.
 *
 * @param {string} raw
 * @returns {{ yaml: string, body: string }}
 */
function extractFrontmatter(raw) {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { yaml: '', body: normalized.trim() };
  }
  return { yaml: match[1], body: match[2].trim() };
}

function unquoteYaml(s) {
  const t = s.trim();
  if (t.length >= 2) {
    if (t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replace(/''/g, "'");
    }
    if (t.startsWith('"') && t.endsWith('"')) {
      return t
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
    }
  }
  return t;
}

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseInlineArray(raw) {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && inner[i - 1] !== '\\') {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble) {
      items.push(parseYamlScalar(current));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    items.push(parseYamlScalar(current));
  }
  return items;
}

function parseYamlScalar(raw) {
  const t = raw.trim();
  if (t === '') return '';
  const arr = parseInlineArray(t);
  if (arr !== null) return arr;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return unquoteYaml(t);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  return t;
}

function findMappingColon(s) {
  let inSingle = false;
  let inDouble = false;
  let bracketDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && s[i - 1] !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
      else if (ch === ':' && bracketDepth === 0 && (i === s.length - 1 || s[i + 1] === ' ')) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Zero-dependency indentation-based YAML frontmatter parser.
 *
 * @param {string} yamlStr
 * @returns {Record<string, any>}
 */
export function parseSimpleYaml(yamlStr) {
  if (!yamlStr || !yamlStr.trim()) return {};
  const rawLines = yamlStr.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cleaned = stripYamlComment(rawLines[i].replace(/\t/g, '  '));
    if (cleaned.trim() === '') continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, content: cleaned.trim() });
  }
  if (lines.length === 0) return {};

  let pos = 0;

  function parseBlock(minIndent) {
    if (pos >= lines.length || lines[pos].indent < minIndent) return {};
    if (lines[pos].content.startsWith('- ') || lines[pos].content === '-') {
      return parseSequence(lines[pos].indent);
    }
    return parseMapping(lines[pos].indent);
  }

  function parseMapping(mapIndent) {
    const result = {};
    while (pos < lines.length && lines[pos].indent === mapIndent) {
      const line = lines[pos];
      if (line.content.startsWith('- ') || line.content === '-') break;
      const colonIdx = findMappingColon(line.content);
      if (colonIdx === -1) {
        pos++;
        continue;
      }
      const key = unquoteYaml(line.content.slice(0, colonIdx).trim());
      const valPart = line.content.slice(colonIdx + 1).trim();
      pos++;

      const isBlockScalar = /^[|>][-+]?$/.test(valPart);
      let val;
      if (valPart === '' || isBlockScalar) {
        if (isBlockScalar && pos < lines.length && lines[pos].indent > mapIndent) {
          const blockIndent = lines[pos].indent;
          const blockLines = [];
          while (pos < lines.length && lines[pos].indent >= blockIndent) {
            blockLines.push(lines[pos].content);
            pos++;
          }
          val = valPart.startsWith('|') ? blockLines.join('\n') : blockLines.join(' ');
        } else if (pos < lines.length && lines[pos].indent > mapIndent) {
          val = parseBlock(lines[pos].indent);
        } else {
          val = null;
        }
      } else {
        val = parseYamlScalar(valPart);
      }
      if (!UNSAFE_KEYS.has(key)) {
        result[key] = val;
      }
    }
    return result;
  }

  function parseSequence(seqIndent) {
    const result = [];
    while (pos < lines.length && lines[pos].indent === seqIndent) {
      const line = lines[pos];
      if (!line.content.startsWith('- ') && line.content !== '-') break;
      const afterDash = line.content === '-' ? '' : line.content.slice(2).trim();
      pos++;

      if (afterDash === '') {
        if (pos < lines.length && lines[pos].indent > seqIndent) {
          result.push(parseBlock(lines[pos].indent));
        } else {
          result.push(null);
        }
      } else {
        const inlineArr = parseInlineArray(afterDash);
        if (inlineArr !== null) {
          result.push(inlineArr);
        } else {
          const colonIdx = findMappingColon(afterDash);
          if (colonIdx !== -1 && !afterDash.startsWith("'") && !afterDash.startsWith('"')) {
            const subMap = {};
            const k = unquoteYaml(afterDash.slice(0, colonIdx).trim());
            const v = afterDash.slice(colonIdx + 1).trim();
            const kvVal =
              v === '' && pos < lines.length && lines[pos].indent > seqIndent
                ? parseBlock(lines[pos].indent)
                : parseYamlScalar(v);
            if (!UNSAFE_KEYS.has(k)) subMap[k] = kvVal;
            const itemIndent = seqIndent + 2;
            while (
              pos < lines.length &&
              lines[pos].indent >= itemIndent &&
              !lines[pos].content.startsWith('- ')
            ) {
              const subLine = lines[pos];
              const subColon = findMappingColon(subLine.content);
              if (subColon === -1) break;
              const sk = unquoteYaml(subLine.content.slice(0, subColon).trim());
              const sv = subLine.content.slice(subColon + 1).trim();
              pos++;
              const skVal =
                sv === '' && pos < lines.length && lines[pos].indent > subLine.indent
                  ? parseBlock(lines[pos].indent)
                  : parseYamlScalar(sv);
              if (!UNSAFE_KEYS.has(sk)) subMap[sk] = skVal;
            }
            result.push(subMap);
          } else {
            result.push(parseYamlScalar(afterDash));
          }
        }
      }
    }
    return result;
  }

  return parseMapping(lines[0].indent);
}

function normalizeStringList(raw) {
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeChainTo(raw) {
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const targets = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      targets.push(item.trim());
    } else if (item && typeof item === 'object') {
      const target = item.targetSkill ?? item.target ?? item.skill;
      if (typeof target === 'string' && target.trim()) {
        targets.push(target.trim());
      }
    }
  }
  return targets;
}

function normalizePromptSignals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { phrases: [], allOf: [], anyOf: [], noneOf: [], minScore: DEFAULT_MIN_SCORE };
  }
  const phrases = normalizeStringList(raw.phrases);
  const anyOf = normalizeStringList(raw.anyOf);
  const noneOf = normalizeStringList(raw.noneOf);
  const allOf = [];
  if (Array.isArray(raw.allOf)) {
    for (const group of raw.allOf) {
      if (Array.isArray(group)) {
        const cleaned = normalizeStringList(group);
        if (cleaned.length > 0) allOf.push(cleaned);
      }
    }
  }
  const minScore =
    typeof raw.minScore === 'number' && !Number.isNaN(raw.minScore) && raw.minScore >= 0
      ? raw.minScore
      : DEFAULT_MIN_SCORE;

  return { phrases, allOf, anyOf, noneOf, minScore };
}

/**
 * Scans `<skillsDir>/* /SKILL.md`, parses YAML frontmatter, measures `byteLength`,
 * and returns priority-sorted skill entries.
 *
 * @param {string} skillsDir
 * @returns {Array<{
 *   name: string,
 *   description: string,
 *   summary: string,
 *   priority: number,
 *   chainTo: string[],
 *   pathPatterns: string[],
 *   bashPatterns: string[],
 *   importPatterns: string[],
 *   promptSignals: { phrases: string[], allOf: string[][], anyOf: string[], noneOf: string[], minScore: number },
 *   body: string,
 *   byteLength: number,
 *   filePath: string
 * }>}
 */
export function compileSkillManifestIndex(skillsDir) {
  if (!skillsDir || typeof skillsDir !== 'string') return [];

  let canonicalRoot = '';
  try {
    canonicalRoot = realpathSync(resolve(skillsDir));
  } catch {
    return [];
  }

  let dirEntries = [];
  try {
    dirEntries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  const index = [];

  for (const dirName of dirEntries) {
    const skillDir = join(skillsDir, dirName);
    try {
      const dirStat = lstatSync(skillDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, 'SKILL.md');
    let rawContent = '';
    try {
      const fileStat = lstatSync(skillFile);
      if (
        fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.size > MAX_SKILL_FILE_BYTES
      ) {
        continue;
      }
      const realSkillFile = realpathSync(skillFile);
      if (realSkillFile !== canonicalRoot && !realSkillFile.startsWith(canonicalRoot + sep)) {
        continue;
      }
      rawContent = readFileSync(realSkillFile, 'utf8');
    } catch {
      continue;
    }

    const { yaml, body } = extractFrontmatter(rawContent);
    const parsed = parseSimpleYaml(yaml);
    const metadata =
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? parsed.metadata
        : {};

    const rawPriority = parsed.priority ?? metadata.priority;
    const priority =
      typeof rawPriority === 'number' && Number.isFinite(rawPriority)
        ? rawPriority
        : DEFAULT_PRIORITY;

    index.push({
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : dirName,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      summary:
        typeof (parsed.summary ?? metadata.summary) === 'string'
          ? (parsed.summary ?? metadata.summary)
          : '',
      priority,
      chainTo: normalizeChainTo(parsed.chainTo ?? metadata.chainTo),
      pathPatterns: normalizeStringList(parsed.pathPatterns ?? metadata.pathPatterns),
      bashPatterns: normalizeStringList(parsed.bashPatterns ?? metadata.bashPatterns),
      importPatterns: normalizeStringList(parsed.importPatterns ?? metadata.importPatterns),
      promptSignals: normalizePromptSignals(parsed.promptSignals ?? metadata.promptSignals),
      body,
      byteLength: Buffer.byteLength(body, 'utf8'),
      filePath: skillFile,
    });
  }

  index.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  return index;
}

/**
 * Tests a file path against a glob pattern across full path, basename (for slash-free globs),
 * and suffix segments.
 *
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPathPattern(filePath, pattern) {
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const regex = globToRegex(pattern);
  if (regex.test(norm)) return true;

  if (!pattern.includes('/')) {
    const base = norm.split('/').pop() ?? '';
    if (regex.test(base)) return true;
  }

  const parts = norm.split('/');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (regex.test(suffix)) return true;
  }
  return false;
}

/**
 * Compiles an import package pattern into a RegExp matching ES `from`/`import` and CJS `require()`.
 *
 * @param {string} pkgPattern
 * @returns {RegExp}
 */
function importPatternToRegex(pkgPattern) {
  const escaped = pkgPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, "[^'\"\\s]*");
  const subPathSuffix = pkgPattern.endsWith('*') ? '' : "(?:\\/[^'\"\\s]*)?";
  return new RegExp(
    `(?:from\\s+['"]${escaped}${subPathSuffix}['"]|import\\s+['"]${escaped}${subPathSuffix}['"]|require\\(\\s*['"]${escaped}${subPathSuffix}['"]\\s*\\)|import\\(\\s*['"]${escaped}${subPathSuffix}['"]\\s*\\))`
  );
}

/**
 * Routes skills for a single turn across prompt signals, path globs, file imports, and Bash
 * commands, resolving `chainTo` companions, deduplicating via `sessionStore`, and enforcing
 * `maxSkills` and `maxBytes` caps.
 *
 * @param {{
 *   index: Array<any>,
 *   prompt?: string,
 *   filePath?: string,
 *   fileContent?: string,
 *   bashCommand?: string,
 *   toolInput?: Record<string, any>,
 *   sessionStore?: { hasKey?: (key: string) => boolean, claimKey?: (key: string) => boolean } | null,
 *   maxSkills?: number,
 *   maxBytes?: number,
 *   anchorSkills?: string[],
 *   hookEvent?: string
 * }} options
 * @returns {{
 *   injectedSkills: string[],
 *   matchedSkills: string[],
 *   droppedByCap: string[],
 *   droppedByBudget: string[],
 *   totalBytes: number,
 *   additionalContext: string
 * }}
 */
export function routeSkillsForTurn({
  index = [],
  prompt = '',
  filePath = '',
  fileContent = '',
  bashCommand = '',
  toolInput = undefined,
  sessionStore = null,
  maxSkills = 3,
  maxBytes = 18000,
  includeWrapperBytes = false,
  anchorSkills = [],
  hookEvent = 'PreToolUse',
} = {}) {
  const entries = Array.isArray(index) ? index : Object.values(index ?? {});
  const effectiveFilePath =
    filePath || toolInput?.file_path || toolInput?.filePath || toolInput?.path || '';
  const rawFileContent =
    fileContent || toolInput?.content || toolInput?.new_string || '';
  const effectiveFileContent =
    typeof rawFileContent === 'string' && rawFileContent.length > MAX_FILE_CONTENT_CHARS
      ? rawFileContent.slice(0, MAX_FILE_CONTENT_CHARS)
      : rawFileContent;
  const rawBashCommand = bashCommand || toolInput?.command || '';
  const effectiveBashCommand =
    typeof rawBashCommand === 'string' && rawBashCommand.length > MAX_BASH_COMMAND_CHARS
      ? rawBashCommand.slice(0, MAX_BASH_COMMAND_CHARS)
      : rawBashCommand;
  const subCommands = effectiveBashCommand ? splitBashCommands(effectiveBashCommand) : [];

  const byName = new Map();
  for (const rawSkill of entries) {
    if (!rawSkill || typeof rawSkill.name !== 'string') continue;
    byName.set(rawSkill.name, rawSkill);
  }

  /** @type {Map<string, { skill: any, priority: number, score: number, body: string, byteLength: number }>} */
  const matchedMap = new Map();
  const suppressedSet = new Set();

  for (const rawSkill of entries) {
    if (!rawSkill || typeof rawSkill.name !== 'string') continue;
    const metadata = rawSkill.metadata ?? {};
    const promptSignals = rawSkill.promptSignals ?? metadata.promptSignals;
    const pathPatterns = normalizeStringList(rawSkill.pathPatterns ?? metadata.pathPatterns);
    const importPatterns = normalizeStringList(rawSkill.importPatterns ?? metadata.importPatterns);
    const bashPatterns = normalizeStringList(rawSkill.bashPatterns ?? metadata.bashPatterns);

    let score = 0;
    let matched = false;

    if (prompt && promptSignals) {
      const promptRes = scorePromptSignals(prompt, promptSignals);
      if (promptRes.score === -Infinity) {
        suppressedSet.add(rawSkill.name);
        continue;
      }
      if (promptRes.matched) {
        matched = true;
        score += promptRes.score;
      }
    }

    if (effectiveFilePath && pathPatterns.length > 0) {
      if (pathPatterns.some((pattern) => matchesPathPattern(effectiveFilePath, pattern))) {
        matched = true;
        score += 5;
      }
    }

    if (effectiveFileContent && importPatterns.length > 0) {
      if (importPatterns.some((pkg) => importPatternToRegex(pkg).test(effectiveFileContent))) {
        matched = true;
        score += 5;
      }
    }

    if (subCommands.length > 0 && bashPatterns.length > 0) {
      const matchedBash = bashPatterns.some((rawRe) => {
        if (!isSafeRegexPattern(rawRe)) return false;
        try {
          const re = new RegExp(rawRe);
          return subCommands.some((cmd) => re.test(cmd));
        } catch {
          return false;
        }
      });
      if (matchedBash) {
        matched = true;
        score += 5;
      }
    }

    if (matched) {
      const body = String(rawSkill.body ?? rawSkill.content ?? '');
      const rawPriority = rawSkill.priority ?? metadata.priority;
      const priority =
        typeof rawPriority === 'number' && Number.isFinite(rawPriority)
          ? rawPriority
          : DEFAULT_PRIORITY;
      const byteLength =
        typeof rawSkill.byteLength === 'number' && Number.isFinite(rawSkill.byteLength)
          ? rawSkill.byteLength
          : Buffer.byteLength(body, 'utf8');

      matchedMap.set(rawSkill.name, {
        skill: rawSkill,
        name: rawSkill.name,
        priority,
        score,
        body,
        byteLength,
      });
    }
  }

  // Resolve chainTo companion skills when target exists in index
  const queue = [...matchedMap.values()];
  while (queue.length > 0) {
    const current = queue.shift();
    const metadata = current.skill.metadata ?? {};
    const chainTargets = normalizeChainTo(current.skill.chainTo ?? metadata.chainTo);
    for (const targetName of chainTargets) {
      if (matchedMap.has(targetName) || suppressedSet.has(targetName)) continue;
      const targetSkill = byName.get(targetName);
      if (!targetSkill) continue;
      const targetMeta = targetSkill.metadata ?? {};
      const body = String(targetSkill.body ?? targetSkill.content ?? '');
      const rawPriority = targetSkill.priority ?? targetMeta.priority;
      const priority =
        typeof rawPriority === 'number' && Number.isFinite(rawPriority)
          ? rawPriority
          : DEFAULT_PRIORITY;
      const byteLength =
        typeof targetSkill.byteLength === 'number' && Number.isFinite(targetSkill.byteLength)
          ? targetSkill.byteLength
          : Buffer.byteLength(body, 'utf8');

      const companionEntry = {
        skill: targetSkill,
        name: targetSkill.name,
        priority,
        score: 0,
        body,
        byteLength,
      };
      matchedMap.set(targetName, companionEntry);
      queue.push(companionEntry);
    }
  }

  const anchorSet = new Set(Array.isArray(anchorSkills) ? anchorSkills : []);
  const sortedCandidates = [...matchedMap.values()].sort((a, b) => {
    const aAnchor = anchorSet.has(a.name) ? 1 : 0;
    const bAnchor = anchorSet.has(b.name) ? 1 : 0;
    if (bAnchor !== aAnchor) return bAnchor - aAnchor;
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const matchedSkills = sortedCandidates.map((c) => c.name);
  const unseenCandidates = sortedCandidates.filter(
    (c) => !(typeof sessionStore?.hasKey === 'function' && sessionStore.hasKey(c.name))
  );

  const injectedSkills = [];
  const injectedEntries = [];
  const droppedByCap = [];
  const droppedByBudget = [];
  let totalBytes = 0;

  for (const candidate of unseenCandidates) {
    if (injectedSkills.length >= maxSkills) {
      droppedByCap.push(candidate.name);
      continue;
    }
    const wrapperOverhead = includeWrapperBytes
      ? Buffer.byteLength(`<skill_content name="${candidate.name}">\n\n</skill_content>\n`, 'utf8') +
        (injectedSkills.length === 0 ? 160 : 0)
      : 0;
    if (totalBytes + candidate.byteLength + wrapperOverhead > maxBytes) {
      droppedByBudget.push(candidate.name);
      continue;
    }
    if (typeof sessionStore?.claimKey === 'function') {
      const claimed = sessionStore.claimKey(candidate.name);
      if (claimed === false) {
        continue;
      }
    }
    injectedSkills.push(candidate.name);
    injectedEntries.push(candidate);
    totalBytes += candidate.byteLength;
  }

  let additionalContext = '';
  if (injectedEntries.length > 0) {
    const safeJson = JSON.stringify({
      version: 1,
      hookEvent,
      injectedSkills,
      matchedSkills,
      droppedByCap,
      droppedByBudget,
      totalBytes,
    }).replace(/-->/g, '--\\u003e');
    const metaComment = `<!-- skillInjection: ${safeJson} -->`;
    const contentBlocks = injectedEntries.map((entry) => {
      const safeName = String(entry.name ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const safeBody = String(entry.body ?? '')
        .replace(/<\/skill_content>/gi, '<\\/skill_content>')
        .replace(/<\/skill>/gi, '<\\/skill>');
      return `<skill_content name="${safeName}">\n${safeBody}\n</skill_content>`;
    });
    additionalContext = `${metaComment}\n${contentBlocks.join('\n')}`;
  }

  return {
    injectedSkills,
    matchedSkills,
    droppedByCap,
    droppedByBudget,
    totalBytes,
    additionalContext,
  };
}

export const routeSkills = routeSkillsForTurn;
