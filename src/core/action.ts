import type { NostrEvent, ActionContent, Hex } from './types.js';
import { KIND_ACTION, PIP02_VERSION } from './types.js';
import { safeParseJSON, tagByMarker, tagsByName } from './tags.js';
import { verifyEventStrict } from './crypto.js';
import { KERNEL_ACTIONS, PROFILE_ACTIONS } from './swapProfile.js';

export interface ActionParseResult {
  valid: boolean;
  content?: ActionContent;
  rootId?: Hex;
  prevId?: Hex;
  issues: string[];
}

export function parseAction(e: NostrEvent, expectedRootId?: Hex): ActionParseResult {
  const issues: string[] = [];
  if (e.kind !== KIND_ACTION) {
    issues.push(`wrong kind ${e.kind}; expected ${KIND_ACTION}`);
    return { valid: false, issues };
  }
  const v = verifyEventStrict(e);
  if (!v.ok) issues.push(`event ${v.reason}`);

  const rootTag = tagByMarker(e, 'e', 'root');
  const prevTag = tagByMarker(e, 'e', 'prev');
  if (!rootTag) issues.push('missing e tag with marker "root"');
  else if (expectedRootId && rootTag[1] !== expectedRootId)
    issues.push(`root reference ${rootTag[1]} does not match coordination root ${expectedRootId}`);
  if (!prevTag) issues.push('missing e tag with marker "prev"');

  // exactly one root and one prev marker
  const rootCount = tagsByName(e, 'e').filter((t) => (t[3] ?? '') === 'root').length;
  const prevCount = tagsByName(e, 'e').filter((t) => (t[3] ?? '') === 'prev').length;
  if (rootCount > 1) issues.push('multiple e tags with marker "root"; expected exactly one');
  if (prevCount > 1) issues.push('multiple e tags with marker "prev"; expected exactly one');

  const c = safeParseJSON(e.content);
  if (!c || typeof c !== 'object') {
    issues.push('content is not a JSON object');
    return { valid: false, issues, rootId: rootTag?.[1], prevId: prevTag?.[1] };
  }
  if (c.version !== PIP02_VERSION) issues.push(`content.version must be ${PIP02_VERSION}`);
  if (typeof c.action !== 'string' || c.action.length === 0) {
    issues.push('content.action missing');
  } else if (!KERNEL_ACTIONS.has(c.action) && !PROFILE_ACTIONS.has(c.action)) {
    issues.push(`unknown action ${c.action}`);
  }

  return {
    valid: issues.length === 0,
    content: { version: c.version, action: c.action, data: c.data },
    rootId: rootTag?.[1],
    prevId: prevTag?.[1],
    issues,
  };
}
