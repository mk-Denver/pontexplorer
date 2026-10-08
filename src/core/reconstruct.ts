import type { NostrEvent, SwapReconstruction, EventSource, Hex } from './types.js';
import { parseRoot } from './root.js';
import { parseDescriptor, isSelectable } from './descriptor.js';
import { reconstructChain, toChainAction } from './chain.js';
import { verifyEventStrict } from './crypto.js';
import { npub } from './crypto.js';

export interface ReconstructRootResult {
  rootEvent: NostrEvent;
  reconstruction: SwapReconstruction | null;
  rootIssues: string[];
}

export async function reconstructSwap(
  rootEvent: NostrEvent,
  actions: NostrEvent[],
  descriptorEvent?: NostrEvent,
): Promise<ReconstructRootResult> {
  const rootSig = verifyEventStrict(rootEvent);
  const rp = parseRoot(rootEvent);
  const rootIssues = [...rp.issues];
  if (!rootSig.ok && !rootIssues.some((i) => i.startsWith('event '))) rootIssues.push(`event ${rootSig.reason}`);

  if (!rp.valid || !rp.content || !rp.participants || !rp.derived) {
    return { rootEvent, reconstruction: null, rootIssues };
  }

  let descriptor: SwapReconstruction['descriptor'];
  if (descriptorEvent) {
    const dp = parseDescriptor(descriptorEvent);
    const issues: string[] = [...dp.issues];
    if (rp.descriptorEventId && descriptorEvent.id !== rp.descriptorEventId)
      issues.push(`addressable descriptor id ${descriptorEvent.id.slice(0, 8)} differs from root escrow-version id ${rp.descriptorEventId.slice(0, 8)}`);
    if (descriptorEvent.created_at > rootEvent.created_at)
      issues.push('descriptor created_at is later than root created_at');
    if (!isSelectable(dp, rootEvent.created_at))
      issues.push('descriptor was not selectable (unexpired) at root creation');
    descriptor = { event: descriptorEvent, valid: dp.valid && issues.length === 0, issues };
  }

  const chain = reconstructChain(rootEvent, rp.content, rp.participants, rp.derived, actions);

  const reconstruction: SwapReconstruction = {
    root: rootEvent,
    rootContent: rp.content,
    participants: rp.participants,
    derived: rp.derived,
    descriptor,
    state: chain.state,
    preDisputeState: chain.preDisputeState,
    disputed: chain.disputed,
    terminal: chain.terminal,
    dispute: chain.dispute,
    canonical: chain.canonical.map(toChainAction),
    forks: chain.forks,
    anomalies: chain.anomalies,
    acceptedCount: chain.canonical.length,
    proposerNpub: npub(rootEvent.pubkey),
  };

  return { rootEvent, reconstruction, rootIssues };
}

export async function reconstructSwapFromRoot(
  rootEvent: NostrEvent,
  source: EventSource,
): Promise<ReconstructRootResult> {
  const [actions, descriptorEvent] = await Promise.all([
    source.fetchActions(rootEvent.id).catch(() => [] as NostrEvent[]),
    parseRoot(rootEvent).descriptorAddr
      ? source.fetchDescriptorByAddr(parseRoot(rootEvent).descriptorAddr!).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  return reconstructSwap(rootEvent, actions, descriptorEvent);
}

export async function listSwaps(source: EventSource): Promise<ReconstructRootResult[]> {
  const roots = await source.fetchRoots().catch(() => [] as NostrEvent[]);
  if (roots.length === 0) return [];

  // batch: fetch all actions + all descriptors in parallel, then reconstruct each root from cached data
  const [actionMap, descriptorMap] = await Promise.all([
    source.fetchAllActions(roots.map((r) => r.id)).catch(() => new Map<Hex, NostrEvent[]>()),
    (async () => {
      const addrs = new Set<string>();
      for (const r of roots) {
        const rp = parseRoot(r);
        if (rp.descriptorAddr) addrs.add(rp.descriptorAddr);
      }
      return source.fetchDescriptorsByAddr([...addrs]).catch(() => new Map<string, NostrEvent>());
    })(),
  ]);

  const out: ReconstructRootResult[] = [];
  for (const r of roots) {
    const rp = parseRoot(r);
    const actions = actionMap.get(r.id) ?? [];
    const desc = rp.descriptorAddr ? descriptorMap.get(rp.descriptorAddr) : undefined;
    out.push(await reconstructSwap(r, actions, desc));
  }
  return out;
}

export async function listSwapsProgress(
  source: EventSource,
  onProgress?: (msg: string) => void,
): Promise<ReconstructRootResult[]> {
  onProgress?.('fetching coordination roots from relays…');
  const roots = await source.fetchRoots().catch(() => [] as NostrEvent[]);
  if (roots.length === 0) {
    onProgress?.('no roots found');
    return [];
  }
  onProgress?.(`found ${roots.length} root(s); fetching actions + descriptors…`);

  const [actionMap, descriptorMap] = await Promise.all([
    source.fetchAllActions(roots.map((r) => r.id)).catch(() => new Map<Hex, NostrEvent[]>()),
    (async () => {
      const addrs = new Set<string>();
      for (const r of roots) {
        const rp = parseRoot(r);
        if (rp.descriptorAddr) addrs.add(rp.descriptorAddr);
      }
      if (addrs.size === 0) return new Map<string, NostrEvent>();
      onProgress?.(`fetching ${addrs.size} descriptor(s)…`);
      return source.fetchDescriptorsByAddr([...addrs]).catch(() => new Map<string, NostrEvent>());
    })(),
  ]);

  const totalActions = [...actionMap.values()].reduce((s, a) => s + a.length, 0);
  onProgress?.(`reconstructing ${roots.length} swap(s) from ${totalActions} action(s)…`);

  const out: ReconstructRootResult[] = [];
  for (const r of roots) {
    const rp = parseRoot(r);
    const actions = actionMap.get(r.id) ?? [];
    const desc = rp.descriptorAddr ? descriptorMap.get(rp.descriptorAddr) : undefined;
    out.push(await reconstructSwap(r, actions, desc));
  }
  onProgress?.('done');
  return out;
}
