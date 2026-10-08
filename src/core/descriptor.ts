import type { NostrEvent } from './types.js';
import { safeParseJSON, tagsByName, tagValue } from './tags.js';
import { verifyEventStrict } from './crypto.js';

export interface DescriptorContent {
  version: number;
  escrow_type: string;
  networks: string[];
  expires_at: number;
  service?: { schema: { type: 'openapi' | 'asyncapi'; url: string } };
}

export interface DescriptorParseResult {
  valid: boolean;
  content?: DescriptorContent;
  issues: string[];
  addr?: string;
  d?: string;
}

export function descriptorAddr(e: NostrEvent): string | undefined {
  const d = tagValue(e, 'd');
  if (!d) return undefined;
  return `${e.kind}:${e.pubkey}:${d}`;
}

export function parseDescriptor(e: NostrEvent): DescriptorParseResult {
  const issues: string[] = [];
  if (e.kind !== 30361) {
    issues.push(`wrong kind ${e.kind}; expected 30361`);
    return { valid: false, issues };
  }
  const v = verifyEventStrict(e);
  if (!v.ok) issues.push(`event ${v.reason}`);

  const d = tagValue(e, 'd');
  if (!d) issues.push('missing required d tag');

  const c = safeParseJSON(e.content);
  if (!c || typeof c !== 'object') {
    issues.push('content is not a JSON object');
    return { valid: false, issues, d };
  }
  if (typeof c.version !== 'number' || !Number.isInteger(c.version))
    issues.push('version missing or not integer');
  if (typeof c.escrow_type !== 'string' || c.escrow_type.length === 0 || c.escrow_type !== c.escrow_type.toLowerCase())
    issues.push('escrow_type missing, empty, or not lowercase');
  if (
    !Array.isArray(c.networks) ||
    c.networks.length === 0 ||
    !c.networks.every((n: unknown) => typeof n === 'string' && n === (n as string).toLowerCase())
  )
    issues.push('networks missing, empty, or not lowercase strings');
  if (typeof c.expires_at !== 'number' || !Number.isFinite(c.expires_at))
    issues.push('expires_at missing or not a number');

  if (Array.isArray(c.networks)) {
    const claimed = new Set(
      tagsByName(e, 't')
        .map((t) => t[1])
        .filter((s): s is string => typeof s === 'string' && s.startsWith('pontmore-network:'))
        .map((s) => s.slice('pontmore-network:'.length)),
    );
    for (const n of claimed) {
      if (!c.networks.includes(n)) issues.push(`pontmore-network:${n} in t tags but absent from content.networks`);
    }
  }

  if (c.service) {
    const schema = c.service.schema;
    if (!schema || typeof schema !== 'object') {
      issues.push('service present but service.schema missing');
    } else {
      if (schema.type !== 'openapi' && schema.type !== 'asyncapi')
        issues.push('service.schema.type must be openapi or asyncapi');
      if (typeof schema.url !== 'string' || !/^https:\/\//i.test(schema.url))
        issues.push('service.schema.url must be an absolute https URL');
    }
  }

  const addr = d ? `${e.kind}:${e.pubkey}:${d}` : undefined;
  return { valid: issues.length === 0, content: c as DescriptorContent, issues, addr, d };
}

export function isSelectable(d: DescriptorParseResult, atTime: number): boolean {
  if (!d.valid || !d.content) return false;
  return atTime < d.content.expires_at;
}
