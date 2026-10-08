import { getEventHash, verifyEvent, verifiedSymbol, nip19 } from 'nostr-tools';
import type { Hex, NostrEvent } from './types.js';

const VERIFIED = verifiedSymbol as symbol;

export function npub(pubkey: Hex): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

export function shortHex(h: Hex, n = 8): string {
  if (!h || h.length <= n * 2 + 1) return h;
  return `${h.slice(0, n)}…${h.slice(-n)}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'invalid_id' | 'invalid_signature' | 'malformed';
}

export function verifyEventStrict(e: NostrEvent): VerifyResult {
  const structOk =
    typeof e?.id === 'string' && e.id.length === 64 &&
    /^[0-9a-f]+$/i.test(e.id) &&
    typeof e?.pubkey === 'string' && e.pubkey.length === 64 &&
    /^[0-9a-f]+$/i.test(e.pubkey) &&
    typeof e?.sig === 'string' && e.sig.length === 128 &&
    /^[0-9a-f]+$/i.test(e.sig) &&
    typeof e?.content === 'string' &&
    typeof e?.created_at === 'number' && isFinite(e.created_at) &&
    Array.isArray(e?.tags) &&
    e?.kind != null;
  if (!structOk) return { ok: false, reason: 'malformed' };

  let computed: string;
  try {
    computed = getEventHash(e);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (computed !== e.id) return { ok: false, reason: 'invalid_id' };

  delete (e as any)[VERIFIED];
  if (!verifyEvent(e)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}
