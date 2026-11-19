/**
 * @fileoverview Structural model catalog parser for Antigravity Language Server
 * `GetAvailableModels` and `GetCascadeModelConfigData` responses. Eliminates
 * hardcoded model codenames by deriving flagship/fast tiers, thinking efforts,
 * and context ceilings directly from server metadata.
 */

export const CANONICAL_THINKING_EFFORTS = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  med: 'Medium',
  medium: 'Medium',
  high: 'High',
  extra_high: 'XHigh',
  xhigh: 'XHigh',
  max: 'Max',
});

const EFFORT_RANK = Object.freeze({
  Minimal: 1,
  Low: 2,
  Medium: 3,
  High: 4,
  XHigh: 5,
  Max: 6,
});

const SUFFIX_EFFORT_RE = /\s*\((Max|XHigh|High|Medium|Med|Low|Minimal)\)\s*$/i;
const SLUG_EFFORT_RE = /-(max|xhigh|high|medium|med|low|minimal)$/i;

export function extractExplicitEffort(rawLabel = '', modelId = '') {
  const labelMatch = String(rawLabel || '').match(SUFFIX_EFFORT_RE);
  if (labelMatch) {
    return CANONICAL_THINKING_EFFORTS[labelMatch[1].toLowerCase()] || '';
  }
  const idMatch = String(modelId || '').match(SLUG_EFFORT_RE);
  if (idMatch) {
    return CANONICAL_THINKING_EFFORTS[idMatch[1].toLowerCase()] || '';
  }
  return '';
}

export function extractThinkingEffort(rawLabel = '', modelId = '') {
  const explicit = extractExplicitEffort(rawLabel, modelId);
  if (explicit) return explicit;
  if (!/^custom(?:$|[-/])/i.test(String(modelId || '').trim()) && /\borchestrator\b/i.test(`${rawLabel} ${modelId}`)) {
    return 'High';
  }
  return '';
}

export function mapThinkingLevel(level, rawLabel = '', modelId = '') {
  const explicit = extractExplicitEffort(rawLabel, modelId);
  if (explicit === 'Max') return 'Max';
  if (typeof level === 'number') {
    if (level === 1) return 'Low';
    if (level === 2) return 'Medium';
    if (level === 3) return 'High';
    if (level === 4) return 'Minimal';
    if (level === 5 || level >= 100) return 'XHigh';
    return '';
  }
  if (typeof level === 'string' && level.trim()) {
    const key = level.trim().toLowerCase().replace(/^thinking_level_/, '');
    if (Object.prototype.hasOwnProperty.call(CANONICAL_THINKING_EFFORTS, key)) {
      return CANONICAL_THINKING_EFFORTS[key];
    }
  }
  return '';
}

export function cleanModelBadgeLabel(rawLabel = '', modelId = '') {
  if (rawLabel) return String(rawLabel).trim();
  if (!modelId) return 'Gemini';
  const effort = extractExplicitEffort('', modelId);
  const base =
    String(modelId)
      .replace(SLUG_EFFORT_RE, '')
      .replace(/^MODEL_PLACEHOLDER_/i, 'Model ')
      .split(/[-_]/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ')
      .trim() || 'Gemini';
  return effort ? `${base} (${effort})` : base;
}

export function stripModelSuffixAndVendor(raw = '') {
  return String(raw || '')
    .replace(SUFFIX_EFFORT_RE, '')
    .replace(/^(Gemini|Claude)\s+/i, '')
    .trim();
}

export function stripModelFamilySlug(modelId = '') {
  return String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/-tiered(?:-[a-z0-9._-]+)?$/i, '')
    .replace(SLUG_EFFORT_RE, '');
}

function parseCheckpointerLimit(rawModel) {
  const ckptStr = rawModel?.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
  if (typeof ckptStr !== 'string' || !ckptStr) return 0;
  try {
    const parsed = JSON.parse(ckptStr);
    const n = Number(parsed?.max_token_limit);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

function compactSupportedMimeTypes(m) {
  const raw = m?.supportedMimeTypes;
  const keys = raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => Boolean(raw[k])) : [];
  const out = {};
  if (m?.supportsVideo || keys.some((k) => k.startsWith('video/'))) out['video/mp4'] = true;
  if (keys.some((k) => k.startsWith('audio/'))) out['audio/wav'] = true;
  if (m?.supportsPdf || keys.includes('application/pdf')) out['application/pdf'] = true;
  if (m?.supportsImages || keys.some((k) => k.startsWith('image/'))) out['image/png'] = true;
  if (keys.length > 0 && Object.keys(out).length === 0) out['text/plain'] = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isStructuralFastName(slug = '', label = '') {
  return /\b(?:flash|lite|haiku|mini|nano)\b|-worker-/i.test(`${slug} ${label}`);
}

function extractOrderedSortIds(agentModelSorts = []) {
  const out = [];
  const seen = new Set();
  for (const sort of Array.isArray(agentModelSorts) ? agentModelSorts : []) {
    for (const grp of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of Array.isArray(grp?.modelIds) ? grp.modelIds : []) {
        const s = String(id || '').trim();
        if (s && !seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
  }
  return out;
}

export function hydrateCatalogFromSnapshot(snapshot = {}) {
  const modelsBySlug = snapshot?.modelsBySlug && typeof snapshot.modelsBySlug === 'object' ? snapshot.modelsBySlug : {};
  const tiered = snapshot?.tieredModelIds && typeof snapshot.tieredModelIds === 'object' ? snapshot.tieredModelIds : {};
  const defaultAgentModelId = String(snapshot?.defaultAgentModelId || '').trim();
  const sortIds = Array.isArray(snapshot?.orderedModelIds) ? snapshot.orderedModelIds : [];

  const fastFamilySlugs = new Set();
  for (const tierKey of ['flashLite', 'flash']) {
    for (const id of Array.isArray(tiered[tierKey]) ? tiered[tierKey] : []) {
      const fam = stripModelFamilySlug(id);
      if (fam) fastFamilySlugs.add(fam);
    }
  }

  // Distinct Anthropic base families in sort order determine flagship (first) vs fast (subsequent)
  const anthropicOrderedFamilies = [];
  for (const id of [...sortIds, ...Object.keys(modelsBySlug)]) {
    const entry = modelsBySlug[id];
    if (!entry || entry.retired) continue;
    const isAnth =
      entry.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' ||
      String(entry.apiProvider || '').includes('ANTHROPIC') ||
      /^claude-/i.test(id);
    if (!isAnth) continue;
    const fam = stripModelFamilySlug(id);
    if (fam && !anthropicOrderedFamilies.includes(fam)) {
      anthropicOrderedFamilies.push(fam);
    }
  }
  const anthropicFastSlugs = new Set(
    anthropicOrderedFamilies.length > 1
      ? anthropicOrderedFamilies.slice(1)
      : anthropicOrderedFamilies.filter((f) => /\b(?:sonnet|haiku)\b/i.test(f))
  );

  const byId = new Map();
  const byEnum = new Map();
  const byLabelLower = new Map();
  const sortSet = new Set(sortIds);

  for (const [slug, raw] of Object.entries(modelsBySlug)) {
    if (!raw || typeof raw !== 'object') continue;
    const famSlug = stripModelFamilySlug(slug);
    const isClaude =
      raw.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' ||
      String(raw.apiProvider || '').includes('ANTHROPIC') ||
      /\b(?:claude|opus|sonnet|haiku)\b/i.test(`${slug} ${raw.label || ''}`);
    const isGemini =
      !isClaude &&
      (raw.modelProvider === 'MODEL_PROVIDER_GOOGLE' ||
        String(raw.apiProvider || '').includes('GEMINI') ||
        /^gemini-/i.test(slug));
    const isFast = isClaude
      ? anthropicFastSlugs.has(famSlug) || isStructuralFastName(slug, raw.label)
      : fastFamilySlugs.has(famSlug) || isStructuralFastName(slug, raw.label);
    const isFlagship = (isGemini || isClaude) && !isFast;
    const entry = {
      ...raw,
      modelId: slug,
      familySlug: famSlug,
      shortFamily: stripModelSuffixAndVendor(raw.label || cleanModelBadgeLabel('', slug)),
      isClaude,
      isGemini,
      isFast,
      isFlagship,
    };
    byId.set(slug, entry);
    if (entry.label) {
      const lk = entry.label.toLowerCase();
      if (!byLabelLower.has(lk) || sortSet.has(slug)) byLabelLower.set(lk, entry);
    }
    if (entry.modelEnum) {
      const existing = byEnum.get(entry.modelEnum);
      const preferNew =
        !existing ||
        (existing.retired && !entry.retired) ||
        (!sortSet.has(existing.modelId) && sortSet.has(slug)) ||
        (!existing.hasExplicitDisplayName && entry.hasExplicitDisplayName);
      if (preferNew) byEnum.set(entry.modelEnum, entry);
    }
  }

  const families = {
    geminiFlagship: '4 Argon',
    geminiFast: '3.8 Flash',
    claudeFlagship: 'Opus 5.5',
    claudeFast: 'Sonnet 5.5',
    geminiTopEffort: 'High',
    claudeTopEffort: 'High',
  };

  let pickedGeminiFlagshipSlug = '';
  let pickedGeminiFast = false;
  let pickedClaudeFlagshipSlug = '';
  let pickedClaudeFast = false;

  const candidateOrder = [
    ...(defaultAgentModelId ? [defaultAgentModelId] : []),
    ...sortIds,
    ...byId.keys(),
  ];

  for (const id of candidateOrder) {
    const e = byId.get(id);
    if (!e || e.retired || !e.shortFamily) continue;
    const isOrch = /\borchestrator\b/i.test(`${e.modelId} ${e.label}`);
    if (e.isGemini) {
      if (e.isFlagship && !isOrch && !pickedGeminiFlagshipSlug) {
        families.geminiFlagship = e.shortFamily;
        pickedGeminiFlagshipSlug = e.familySlug;
      } else if (e.isFast && !pickedGeminiFast && !/\blite\b/i.test(`${e.modelId} ${e.label}`)) {
        families.geminiFast = e.shortFamily;
        pickedGeminiFast = true;
      }
      if (e.familySlug === pickedGeminiFlagshipSlug && (EFFORT_RANK[e.thinkingEffort] || 0) > (EFFORT_RANK[families.geminiTopEffort] || 0)) {
        families.geminiTopEffort = e.thinkingEffort;
      }
    } else if (e.isClaude) {
      if (e.isFlagship && !pickedClaudeFlagshipSlug) {
        families.claudeFlagship = e.shortFamily;
        pickedClaudeFlagshipSlug = e.familySlug;
      } else if (e.isFast && !pickedClaudeFast) {
        families.claudeFast = e.shortFamily;
        pickedClaudeFast = true;
      }
      if (e.familySlug === pickedClaudeFlagshipSlug && (EFFORT_RANK[e.thinkingEffort] || 0) > (EFFORT_RANK[families.claudeTopEffort] || 0)) {
        families.claudeTopEffort = e.thinkingEffort;
      }
    }
  }

  return {
    snapshot,
    byId,
    byEnum,
    byLabelLower,
    fastFamilySlugs,
    tieredModelIds: tiered,
    defaultAgentModelId,
    orderedModelIds: sortIds,
    families,
  };
}

export function parseAvailableModelsCatalog(availRes = {}, modelConfigData = {}, nowIso = new Date().toISOString()) {
  const resp = availRes?.response || availRes || {};
  const rawModels = resp?.models && typeof resp.models === 'object' ? resp.models : {};
  const orderedModelIds = extractOrderedSortIds(resp?.agentModelSorts);
  const modelsBySlug = {};
  const enumsToSlug = {};

  for (const [slug, m] of Object.entries(rawModels)) {
    if (!m || typeof m !== 'object') continue;
    const hasExplicitDisplayName = typeof m.displayName === 'string' && m.displayName.trim().length > 0;
    const label = hasExplicitDisplayName ? m.displayName.trim() : cleanModelBadgeLabel('', slug);
    const thinkingEffort =
      mapThinkingLevel(m.thinkingLevel, label, slug) || extractThinkingEffort(label, slug);
    const supportedMimeTypes = compactSupportedMimeTypes(m);
    const modelEnum = typeof m.model === 'string' ? m.model.trim() : '';
    modelsBySlug[slug] = {
      modelId: slug,
      modelEnum,
      label,
      hasExplicitDisplayName,
      modelProvider: typeof m.modelProvider === 'string' ? m.modelProvider : '',
      apiProvider: typeof m.apiProvider === 'string' ? m.apiProvider : '',
      thinkingLevel: typeof m.thinkingLevel === 'number' ? m.thinkingLevel : 0,
      thinkingEffort,
      maxTokens: Number(m.maxTokens) || 0,
      maxOutputTokens: Number(m.maxOutputTokens) || 0,
      ceiling: parseCheckpointerLimit(m),
      recommended: Boolean(m.recommended),
      ...(supportedMimeTypes && Object.keys(supportedMimeTypes).length > 0 ? { supportedMimeTypes } : {}),
      lastSeenAt: nowIso,
    };
    if (modelEnum && (!enumsToSlug[modelEnum] || orderedModelIds.includes(slug))) {
      enumsToSlug[modelEnum] = slug;
    }
  }

  for (const c of Array.isArray(modelConfigData?.clientModelConfigs) ? modelConfigData.clientModelConfigs : []) {
    if (!c || typeof c !== 'object') continue;
    const slug = typeof c.modelId === 'string' ? c.modelId.trim() : '';
    const modelEnum = typeof c.modelOrAlias?.model === 'string' ? c.modelOrAlias.model.trim() : '';
    if (!slug || !modelEnum || /^custom-/i.test(slug)) continue;
    const existing = modelsBySlug[slug];
    const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : existing?.label || cleanModelBadgeLabel('', slug);
    const clientMime = compactSupportedMimeTypes(c);
    modelsBySlug[slug] = {
      modelId: slug,
      modelEnum,
      label,
      hasExplicitDisplayName: Boolean(c.label),
      modelProvider: existing?.modelProvider || '',
      apiProvider: existing?.apiProvider || '',
      thinkingLevel: existing?.thinkingLevel || 0,
      thinkingEffort: existing?.thinkingEffort || extractThinkingEffort(label, slug),
      maxTokens: existing?.maxTokens || 0,
      maxOutputTokens: existing?.maxOutputTokens || 0,
      ceiling: existing?.ceiling || 0,
      recommended: existing?.recommended ?? true,
      ...(clientMime || existing?.supportedMimeTypes
        ? { supportedMimeTypes: existing?.supportedMimeTypes || clientMime }
        : {}),
      lastSeenAt: nowIso,
    };
    if (!enumsToSlug[modelEnum]) enumsToSlug[modelEnum] = slug;
  }

  const snapshot = {
    version: 1,
    updatedAt: nowIso,
    defaultAgentModelId: typeof resp.defaultAgentModelId === 'string' ? resp.defaultAgentModelId : '',
    tieredModelIds: resp.tieredModelIds && typeof resp.tieredModelIds === 'object' ? resp.tieredModelIds : {},
    orderedModelIds,
    modelsBySlug,
    enumsToSlug,
  };
  return hydrateCatalogFromSnapshot(snapshot);
}

export function mergeModelCatalogSnapshots(prevSnap = null, nextSnap = null) {
  if (!prevSnap || typeof prevSnap !== 'object' || !prevSnap.modelsBySlug) return nextSnap;
  if (!nextSnap || typeof nextSnap !== 'object' || !nextSnap.modelsBySlug) return prevSnap;
  const nextSlugs = Object.keys(nextSnap.modelsBySlug);
  if (nextSlugs.length === 0) return prevSnap;

  // Only mark previous entries retired when nextSnap came from a full GetAvailableModels snapshot (orderedModelIds or defaultAgentModelId present)
  const isAuthoritativeNext = Boolean(nextSnap.defaultAgentModelId || nextSnap.orderedModelIds?.length);
  const mergedModels = {};
  for (const [slug, prevEntry] of Object.entries(prevSnap.modelsBySlug)) {
    if (!Object.prototype.hasOwnProperty.call(nextSnap.modelsBySlug, slug)) {
      mergedModels[slug] = isAuthoritativeNext ? { ...prevEntry, retired: true } : { ...prevEntry };
    }
  }
  for (const [slug, nextEntry] of Object.entries(nextSnap.modelsBySlug)) {
    const prevEntry = prevSnap.modelsBySlug[slug];
    mergedModels[slug] = {
      ...(prevEntry || {}),
      ...nextEntry,
      ceiling: nextEntry.ceiling || prevEntry?.ceiling || 0,
      maxTokens: nextEntry.maxTokens || prevEntry?.maxTokens || 0,
      maxOutputTokens: nextEntry.maxOutputTokens || prevEntry?.maxOutputTokens || 0,
      modelProvider: nextEntry.modelProvider || prevEntry?.modelProvider || '',
      apiProvider: nextEntry.apiProvider || prevEntry?.apiProvider || '',
      thinkingEffort: nextEntry.thinkingEffort || prevEntry?.thinkingEffort || '',
      retired: false,
    };
  }
  const mergedEnums = { ...(prevSnap.enumsToSlug || {}), ...(nextSnap.enumsToSlug || {}) };
  return {
    version: 1,
    updatedAt: nextSnap.updatedAt || prevSnap.updatedAt || new Date().toISOString(),
    defaultAgentModelId: nextSnap.defaultAgentModelId || prevSnap.defaultAgentModelId || '',
    tieredModelIds:
      nextSnap.tieredModelIds && Object.keys(nextSnap.tieredModelIds).length > 0
        ? nextSnap.tieredModelIds
        : prevSnap.tieredModelIds || {},
    orderedModelIds:
      nextSnap.orderedModelIds?.length > 0 ? nextSnap.orderedModelIds : prevSnap.orderedModelIds || [],
    modelsBySlug: mergedModels,
    enumsToSlug: mergedEnums,
  };
}
