import { SimplePool } from 'nostr-tools';
import type { EventSource, Hex, NostrEvent } from './types.js';
import { KIND_ACTION, KIND_DESCRIPTOR, KIND_ROOT, PROFILE_ID } from './types.js';
import { safeParseJSON, tagsByName } from './tags.js';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

function groupByRoot(events: NostrEvent[]): Map<Hex, NostrEvent[]> {
  const out = new Map<Hex, NostrEvent[]>();
  for (const e of events) {
    for (const t of tagsByName(e, 'e')) {
      if ((t[3] ?? '') === 'root' && t[1]) {
        if (!out.has(t[1])) out.set(t[1], []);
        out.get(t[1])!.push(e);
      }
    }
  }
  return out;
}

export class OfflineSource implements EventSource {
  constructor(private events: NostrEvent[]) {}

  static fromFile(text: string): OfflineSource {
    const data = JSON.parse(text);
    const arr: NostrEvent[] = Array.isArray(data) ? data : data.events;
    if (!Array.isArray(arr)) throw new Error('fixture file must be an array of events or { events: [] }');
    return new OfflineSource(arr);
  }

  private byKind(kind: number): NostrEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  async fetchRoots(): Promise<NostrEvent[]> {
    return this.byKind(KIND_ROOT).filter((e) => {
      const c = safeParseJSON(e.content);
      return c && typeof c === 'object' && c.profile === PROFILE_ID;
    });
  }

  async fetchActions(rootId: Hex): Promise<NostrEvent[]> {
    return this.byKind(KIND_ACTION).filter((e) =>
      tagsByName(e, 'e').some((t) => (t[3] ?? '') === 'root' && t[1] === rootId),
    );
  }

  async fetchAllActions(rootIds: Hex[]): Promise<Map<Hex, NostrEvent[]>> {
    const all = this.byKind(KIND_ACTION);
    const group = groupByRoot(all);
    const out = new Map<Hex, NostrEvent[]>();
    for (const id of rootIds) out.set(id, group.get(id) ?? []);
    return out;
  }

  async fetchDescriptorsByAddr(addrs: string[]): Promise<Map<string, NostrEvent>> {
    const out = new Map<string, NostrEvent>();
    for (const addr of addrs) {
      const e = await this.fetchDescriptorByAddr(addr);
      if (e) out.set(addr, e);
    }
    return out;
  }

  async fetchDescriptorByAddr(addr: string): Promise<NostrEvent | undefined> {
    const [kindStr, pubkey, d] = addr.split(':');
    const kind = Number(kindStr);
    return this.byKind(KIND_DESCRIPTOR).find(
      (e) => e.pubkey === pubkey && tagsByName(e, 'd').some((t) => t[1] === d) && e.kind === kind,
    );
  }

  async fetchDescriptorById(id: Hex): Promise<NostrEvent | undefined> {
    return this.byKind(KIND_DESCRIPTOR).find((e) => e.id === id);
  }

  async close() {}
}

export class RelaySource implements EventSource {
  private pool: SimplePool;
  constructor(private relays: string[] = DEFAULT_RELAYS) {
    this.pool = new SimplePool();
  }

  private async querySync(filter: any, maxWait = 8000): Promise<NostrEvent[]> {
    const result = await Promise.race([
      this.pool.querySync(this.relays, filter, { maxWait } as any),
      new Promise<NostrEvent[]>((_, rej) =>
        setTimeout(() => rej(new Error('relay query timeout')), maxWait + 3000),
      ),
    ]) as NostrEvent[];
    return result || [];
  }

  async fetchRoots(): Promise<NostrEvent[]> {
    const all = await this.querySync({ kinds: [KIND_ROOT], limit: 500 });
    const seen = new Set<string>();
    return all
      .filter((e) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        const c = safeParseJSON(e.content);
        return c && typeof c === 'object' && c.profile === PROFILE_ID && c.version === 2;
      })
      .sort((a, b) => b.created_at - a.created_at);
  }

  async fetchActions(rootId: Hex): Promise<NostrEvent[]> {
    return (await this.fetchAllActions([rootId])).get(rootId) ?? [];
  }

  async fetchAllActions(rootIds: Hex[]): Promise<Map<Hex, NostrEvent[]>> {
    if (rootIds.length === 0) return new Map();
    // Nostr #e filter supports arrays; query in chunks to stay within relay limits
    const CHUNK = 50;
    const out = new Map<Hex, NostrEvent[]>();
    for (const id of rootIds) out.set(id, []);
    const seenIds = new Set<string>();
    for (let i = 0; i < rootIds.length; i += CHUNK) {
      const chunk = rootIds.slice(i, i + CHUNK);
      const all = await this.querySync({ kinds: [KIND_ACTION], '#e': chunk, limit: 2000 });
      const grouped = groupByRoot(all);
      for (const [rid, acts] of grouped) {
        if (!out.has(rid)) continue; // only roots we asked about
        for (const e of acts) {
          if (!seenIds.has(e.id)) {
            seenIds.add(e.id);
            out.get(rid)!.push(e);
          }
        }
      }
    }
    return out;
  }

  async fetchDescriptorsByAddr(addrs: string[]): Promise<Map<string, NostrEvent>> {
    const out = new Map<string, NostrEvent>();
    if (addrs.length === 0) return out;
    // group by (kind, pubkey) to use #d filter efficiently
    const byAuthor = new Map<string, { kind: number; pubkey: string; dTags: string[]; addrs: string[] }>();
    for (const addr of addrs) {
      const [kindStr, pubkey, d] = addr.split(':');
      const kind = Number(kindStr);
      const key = `${kind}:${pubkey}`;
      if (!byAuthor.has(key)) byAuthor.set(key, { kind, pubkey, dTags: [], addrs: [] });
      const g = byAuthor.get(key)!;
      g.dTags.push(d);
      g.addrs.push(addr);
    }
    for (const g of byAuthor.values()) {
      try {
        const got = await this.pool.get(this.relays, {
          kinds: [g.kind],
          authors: [g.pubkey],
          '#d': g.dTags,
        } as any);
        if (got) {
          const d = tagsByName(got, 'd').map((t) => t[1])[0];
          const addr = addrs.find((a) => a.endsWith(':' + d));
          if (addr) out.set(addr, got as NostrEvent);
        }
      } catch {}
    }
    return out;
  }

  async fetchDescriptorByAddr(addr: string): Promise<NostrEvent | undefined> {
    const [kindStr, pubkey, d] = addr.split(':');
    const kind = Number(kindStr);
    const got = await this.pool.get(this.relays, {
      kinds: [kind],
      authors: [pubkey],
      '#d': [d],
    } as any);
    return got as NostrEvent | undefined;
  }

  async fetchDescriptorById(id: Hex): Promise<NostrEvent | undefined> {
    const got = await this.pool.get(this.relays, { ids: [id] } as any);
    return got as NostrEvent | undefined;
  }

  async close() {
    try {
      (this.pool as any).close(this.relays);
    } catch {}
  }
}
