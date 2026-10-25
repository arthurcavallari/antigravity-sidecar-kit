/**
 * @fileoverview Workspace URI normalization, active workspace resolution, and glob matching.
 */

export function normalizeWorkspacePath(uriOrPath = '', { lowercase = false } = {}) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  let clean = uriOrPath.trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep original string if percent-decoding fails
  }
  clean = clean.replace(/\\/g, '/');
  if (/^file:\/\//i.test(clean)) {
    clean = clean.slice('file://'.length);
    if (/^\/[A-Za-z]:/.test(clean)) {
      // file:///c:/x -> c:/x
      clean = clean.slice(1);
    } else if (clean && !clean.startsWith('/')) {
      // file://server/share -> //server/share (UNC)
      clean = `//${clean}`;
    }
    // otherwise file:///home/x -> /home/x
  }
  let end = clean.length;
  while (end > 1 && clean.charCodeAt(end - 1) === 47) end--;
  if (end < clean.length) clean = clean.slice(0, end);

  // Normalize Windows drive letter casing (e.g. C:/Projects -> c:/Projects)
  if (/^[A-Za-z]:/.test(clean)) {
    clean = clean[0].toLowerCase() + clean.slice(1);
  }
  return lowercase ? clean.toLowerCase() : clean;
}

export function extractWorkspaceName(normalizedPath = '') {
  if (!normalizedPath) return 'No Workspace';
  const parts = normalizedPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalizedPath;
}

function globToRegExp(pattern = '') {
  const normalizedPattern = normalizeWorkspacePath(pattern).toLowerCase();
  if (!normalizedPattern || normalizedPattern === '*') {
    return /^.*$/;
  }
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesWorkspaceRule(activeWorkspacePath = '', patterns = []) {
  const list = Array.isArray(patterns) ? patterns : [];
  if (list.length === 0) return false;
  if (list.some((p) => String(p).trim() === '*')) return true;

  const activeNorm = normalizeWorkspacePath(activeWorkspacePath).toLowerCase();
  if (!activeNorm) return false;

  for (const rawPattern of list) {
    const trimmed = String(rawPattern || '').trim();
    if (!trimmed) continue;
    if (trimmed === '*') return true;

    const normPat = normalizeWorkspacePath(trimmed).toLowerCase();
    // Exact path or parent directory match (e.g., rule 'c:/projects/app' matches 'c:/projects/app/web')
    if (activeNorm === normPat || activeNorm.startsWith(`${normPat}/`)) {
      return true;
    }
    if (/[*?]/.test(trimmed) && globToRegExp(trimmed).test(activeNorm)) {
      return true;
    }
  }
  return false;
}

export function extractTrajectoryWorkspace(trajectorySummary = {}) {
  const wsList =
    trajectorySummary?.workspaces ||
    trajectorySummary?.trajectoryMetadata?.workspaces ||
    [];
  for (const ws of wsList) {
    const uri = ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri;
    if (uri) return normalizeWorkspacePath(uri);
  }
  const metaUris = trajectorySummary?.trajectoryMetadata?.workspaceUris || [];
  if (metaUris.length > 0 && metaUris[0]) {
    return normalizeWorkspacePath(metaUris[0]);
  }
  return '';
}

// Antigravity's placeholder id for a new-conversation pane, before the conversation exists
export const NEW_CONVERSATION_ID = '_new';

export function isRealConversationId(id) {
  return typeof id === 'string' && id !== '' && id !== NEW_CONVERSATION_ID;
}

function workspaceResult(workspacePath, source, conversationId) {
  return workspacePath
    ? { workspacePath, workspaceName: extractWorkspaceName(workspacePath), source, conversationId }
    : { workspacePath: '', workspaceName: 'Global', source, conversationId };
}

/**
 * Antigravity renders a separate sidecar iframe per conversation and puts that conversation in
 * the frame's ?conversationId=, so the id a frame was opened with is its conversation. A visible
 * frame is the focused conversation. lastUserViewTime can't tell which one is focused: on every
 * switch the app stamps the previous and the next conversation with the same time. So view times
 * are only a guess for frames opened without an id.
 */
export function resolveActiveWorkspace({
  clientWorkspaceUris = [],
  trajectoriesResponse = {},
  requestedConversationId = '',
} = {}) {
  const summaries = trajectoriesResponse?.trajectorySummaries || {};
  const entries = Object.entries(summaries);
  const clientPaths = (Array.isArray(clientWorkspaceUris) ? clientWorkspaceUris : [])
    .map((u) => normalizeWorkspacePath(u))
    .filter(Boolean);

  // 1. The frame's own conversation, even before the trajectory list includes it
  if (isRealConversationId(requestedConversationId)) {
    const summary = summaries[requestedConversationId];
    const ownWs = summary ? extractTrajectoryWorkspace(summary) : '';
    if (ownWs) return workspaceResult(ownWs, 'conversation', requestedConversationId);
    return workspaceResult(clientPaths[0] || '', clientPaths[0] ? 'host_push' : 'none', requestedConversationId);
  }

  // 2. A new-conversation pane has no conversation yet, only the workspace the host pushed
  if (requestedConversationId === NEW_CONVERSATION_ID) {
    return workspaceResult(clientPaths[0] || '', 'new_conversation', '');
  }

  // 3. No id at all (a browser tab, or a view outside any conversation): guess from the trajectories
  const parseMs = (iso) => {
    const ms = iso ? Date.parse(iso) : 0;
    return Number.isFinite(ms) ? ms : 0;
  };

  // Sort root trajectories by Date.parse(lastUserViewTime) -> lastUserInputTime -> lastModifiedTime
  const candidates = entries
    .filter(([id, s]) => {
      const rootId = s.trajectoryMetadata?.rootConversationId;
      return Boolean(s.annotations?.lastUserViewTime) || !rootId || rootId === id;
    })
    .map(([id, s]) => {
      const wsPath = extractTrajectoryWorkspace(s);
      const viewMs = parseMs(s.annotations?.lastUserViewTime);
      const inputMs = parseMs(s.lastUserInputTime);
      const modMs = parseMs(s.lastModifiedTime || s.createdTime);
      return { id, wsPath, viewMs, inputMs, modMs };
    })
    .filter((c) => Boolean(c.wsPath))
    .sort((a, b) => {
      const pa = a.viewMs || a.modMs;
      const pb = b.viewMs || b.modMs;
      if (pa !== pb) return pb - pa;
      if (a.inputMs !== b.inputMs) return b.inputMs - a.inputMs;
      if (a.modMs !== b.modMs) return b.modMs - a.modMs;
      return a.id.localeCompare(b.id);
    });

  // When host pushes clientWorkspaceUris via window.sidecar.onWorkspaceChange, prefer
  // the most recently viewed trajectory inside that active workspace
  if (clientPaths.length > 0) {
    const clientMatch = candidates.find((c) => {
      const wsLower = c.wsPath.toLowerCase();
      return clientPaths.some((cp) => {
        const cpLower = cp.toLowerCase();
        return wsLower === cpLower || wsLower.startsWith(`${cpLower}/`) || cpLower.startsWith(`${wsLower}/`);
      });
    });
    if (clientMatch) {
      return {
        workspacePath: clientMatch.wsPath,
        workspaceName: extractWorkspaceName(clientMatch.wsPath),
        source: 'host_push',
        conversationId: clientMatch.id,
      };
    }
  }

  if (candidates.length > 0) {
    const top = candidates[0];
    return {
      workspacePath: top.wsPath,
      workspaceName: extractWorkspaceName(top.wsPath),
      source: 'trajectory',
      conversationId: top.id,
    };
  }

  if (clientPaths.length > 0) {
    return workspaceResult(clientPaths[0], 'host_push', '');
  }

  return workspaceResult('', 'none', '');
}
