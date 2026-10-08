import type { NostrEvent, Tag } from './types.js';

export function tagsByName(e: NostrEvent, name: string): Tag[] {
  return (e.tags || []).filter((t) => t && t.length > 0 && t[0] === name);
}

export function firstTag(e: NostrEvent, name: string): Tag | undefined {
  return (e.tags || []).find((t) => t && t.length > 0 && t[0] === name);
}

export function tagValue(e: NostrEvent, name: string): string | undefined {
  return firstTag(e, name)?.[1];
}

export function tagsByMarker(e: NostrEvent, name: string, marker: string): Tag[] {
  return tagsByName(e, name).filter((t) => (t[3] ?? '') === marker);
}

export function tagByMarker(e: NostrEvent, name: string, marker: string): Tag | undefined {
  return tagsByName(e, name).find((t) => (t[3] ?? '') === marker);
}

export function rolePubkey(e: NostrEvent, role: string): string | undefined {
  const t = tagsByName(e, 'p').find((x) => (x[3] ?? '') === role);
  return t?.[1];
}

export function rolePubkeys(e: NostrEvent, role: string): string[] {
  return tagsByName(e, 'p').filter((x) => (x[3] ?? '') === role).map((x) => x[1]);
}

export function parseAddr(addr: string): { kind: number; pubkey: string; d: string } | undefined {
  const parts = addr.split(':');
  if (parts.length !== 3) return undefined;
  const kind = Number(parts[0]);
  if (!Number.isInteger(kind)) return undefined;
  return { kind, pubkey: parts[1], d: parts[2] };
}

export function safeParseJSON(content: string): any | undefined {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function isHex(s: unknown, len?: number): s is string {
  return typeof s === 'string' && /^[0-9a-f]+$/i.test(s) && (len == null || s.length === len);
}
