import type {
  NostrEvent, Hex, SwapState, Participants, DerivedRoles, RootContent,
  Anomaly, ForkBranch, ChainAction, DisputeInfo,
} from './types.js';
import { parseAction } from './action.js';
import {
  DISPUTE_CLASSES, RESOLUTION_EFFECTS, validatePaymentReference, referencesSamePayment,
  validateEvidence, isAppParticipant, fiatSenderPubkey, fiatReceiverPubkey, bitcoinProviderPubkey,
  normalizePaymentRef,
} from './swapProfile.js';

const TERMINAL_STATES: Set<SwapState> = new Set(['settled', 'refunded', 'declined', 'cancelled', 'expired']);

interface Ctx {
  state: SwapState;
  disputed: boolean;
  terminal: boolean;
  preDisputeState?: SwapState;
  dispute: DisputeInfo | null;
  seenSemantics: Set<string>;
  fiatSentRef?: string;
  fiatConfirmedSigner?: Hex;
  securedSeen: boolean;
}

interface Cand {
  event: NostrEvent;
  action: string;
  data?: any;
  signer: Hex;
  created_at: number;
  id: Hex;
  prevId: Hex;
  wellFormed: boolean;
  issues: string[];
}

interface Transition {
  valid: boolean;
  reason?: string;
  next?: Partial<Ctx>;
}

function validateTransition(
  action: string,
  signer: Hex,
  created_at: number,
  data: any,
  ctx: Ctx,
  p: Participants,
  d: DerivedRoles,
  root: RootContent,
  actionId: Hex,
): Transition {
  if (ctx.terminal) return { valid: false, reason: 'action after terminal outcome' };
  if (ctx.disputed && action !== 'core/resolve_dispute')
    return { valid: false, reason: 'dispute freezes ordinary progression; only core/resolve_dispute permitted' };
  if (ctx.seenSemantics.has(action))
    return { valid: false, reason: `replayed semantic action ${action}` };

  const dl = root.terms.deadlines;
  const escrow = p.escrow;
  const resolver = p.resolver;
  const accepter = p.accepter;
  const proposer = p.proposer;

  switch (action) {
    case 'core/accept': {
      if (ctx.state !== 'proposed') return { valid: false, reason: 'accept requires proposed state' };
      if (signer !== accepter) return { valid: false, reason: 'core/accept must be signed by the non-proposing participant' };
      if (!(created_at < root.expires_at)) return { valid: false, reason: 'core/accept must be before root expires_at' };
      return { valid: true, next: { state: 'accepted' } };
    }
    case 'core/decline': {
      if (ctx.state !== 'proposed') return { valid: false, reason: 'decline requires proposed state' };
      if (signer !== accepter) return { valid: false, reason: 'core/decline must be signed by the non-proposing participant' };
      return { valid: true, next: { state: 'declined', terminal: true } };
    }
    case 'core/cancel': {
      if (ctx.state === 'proposed') {
        if (signer !== proposer) return { valid: false, reason: 'core/cancel before acceptance must be signed by the proposer' };
        return { valid: true, next: { state: 'cancelled', terminal: true } };
      }
      if (ctx.state === 'accepted') {
        if (!isAppParticipant(p, signer)) return { valid: false, reason: 'core/cancel after acceptance must be signed by an application participant' };
        return { valid: true, next: { state: 'cancelled', terminal: true } };
      }
      return { valid: false, reason: 'core/cancel not permitted after core/secure' };
    }
    case 'core/expire': {
      if (ctx.state !== 'proposed') return { valid: false, reason: 'core/expire requires the coordination to remain unaccepted' };
      if (!isAppParticipant(p, signer)) return { valid: false, reason: 'core/expire must be signed by an application participant' };
      if (!(created_at >= root.expires_at)) return { valid: false, reason: 'core/expire must be recorded at or after expires_at' };
      return { valid: true, next: { state: 'expired', terminal: true } };
    }
    case 'core/secure': {
      if (signer !== escrow) return { valid: false, reason: 'core/secure must be signed by core/escrow' };
      if (ctx.state !== 'accepted') return { valid: false, reason: 'core/secure requires accepted state' };
      return { valid: true, next: { state: 'secured', securedSeen: true } };
    }
    case 'swap/fiat_sent': {
      if (signer !== fiatSenderPubkey(p, d)) return { valid: false, reason: 'swap/fiat_sent must be signed by the fiat sender' };
      if (ctx.state !== 'secured') return { valid: false, reason: 'swap/fiat_sent requires secured state' };
      if (!(created_at <= dl.fiat_pay_by)) return { valid: false, reason: 'swap/fiat_sent must be recorded by fiat_pay_by' };
      const ref = validatePaymentReference(data?.payment_reference);
      if (!ref.ok) return { valid: false, reason: ref.reason! };
      return { valid: true, next: { state: 'fiat_sent', fiatSentRef: normalizePaymentRef(ref.value) } };
    }
    case 'swap/fiat_confirmed': {
      if (signer !== fiatReceiverPubkey(p, d)) return { valid: false, reason: 'swap/fiat_confirmed must be signed by the fiat receiver' };
      if (ctx.state !== 'fiat_sent') return { valid: false, reason: 'swap/fiat_confirmed requires fiat_sent state' };
      if (!(created_at <= dl.fiat_confirm_by)) return { valid: false, reason: 'swap/fiat_confirmed must be recorded by fiat_confirm_by' };
      const ref = validatePaymentReference(data?.payment_reference);
      if (!ref.ok) return { valid: false, reason: ref.reason! };
      if (!referencesSamePayment(ref.value, ctx.fiatSentRef))
        return { valid: false, reason: 'swap/fiat_confirmed reference must identify the same committed payment as swap/fiat_sent' };
      return { valid: true, next: { state: 'fiat_confirmed', fiatConfirmedSigner: signer } };
    }
    case 'core/authorize_settlement': {
      if (signer !== fiatReceiverPubkey(p, d)) return { valid: false, reason: 'core/authorize_settlement must be signed by the fiat receiver' };
      if (!ctx.securedSeen) return { valid: false, reason: 'core/authorize_settlement not permitted before core/secure' };
      if (ctx.state !== 'fiat_confirmed') return { valid: false, reason: 'core/authorize_settlement requires fiat_confirmed state' };
      if (ctx.fiatConfirmedSigner && signer !== ctx.fiatConfirmedSigner)
        return { valid: false, reason: 'core/authorize_settlement must be signed by the same participant that confirmed fiat' };
      return { valid: true, next: { state: 'settlement_authorized' } };
    }
    case 'core/settle': {
      if (signer !== escrow) return { valid: false, reason: 'core/settle must be signed by core/escrow' };
      if (ctx.state !== 'settlement_authorized') return { valid: false, reason: 'core/settle requires settlement_authorized state' };
      return { valid: true, next: { state: 'settled', terminal: true } };
    }
    case 'core/authorize_refund': {
      if (signer !== bitcoinProviderPubkey(p, d)) return { valid: false, reason: 'core/authorize_refund must be signed by the bitcoin provider' };
      if (ctx.state !== 'secured') return { valid: false, reason: 'core/authorize_refund requires secured state' };
      if (ctx.fiatSentRef) return { valid: false, reason: 'core/authorize_refund requires no valid swap/fiat_sent' };
      if (!(created_at >= dl.fiat_pay_by)) return { valid: false, reason: 'core/authorize_refund requires fiat_pay_by to have elapsed' };
      return { valid: true, next: { state: 'refund_authorized' } };
    }
    case 'core/refund': {
      if (signer !== escrow) return { valid: false, reason: 'core/refund must be signed by core/escrow' };
      if (ctx.state !== 'refund_authorized') return { valid: false, reason: 'core/refund requires refund_authorized state' };
      return { valid: true, next: { state: 'refunded', terminal: true } };
    }
    case 'core/open_dispute': {
      if (!isAppParticipant(p, signer)) return { valid: false, reason: 'core/open_dispute must be signed by an application participant' };
      if (ctx.state === 'proposed' || TERMINAL_STATES.has(ctx.state))
        return { valid: false, reason: 'core/open_dispute requires an accepted, non-terminal coordination' };
      if (data?.class != null && !DISPUTE_CLASSES.has(data.class))
        return { valid: false, reason: `unknown dispute class ${data.class}` };
      return {
        valid: true,
        next: {
          disputed: true,
          preDisputeState: ctx.state,
          dispute: {
            openedAt: created_at,
            openedBy: signer,
            class: data?.class,
            openedActionId: actionId,
          },
        },
      };
    }
    case 'core/resolve_dispute': {
      if (!resolver) return { valid: false, reason: 'no core/resolver bound to this coordination' };
      if (signer !== resolver) return { valid: false, reason: 'core/resolve_dispute must be signed by core/resolver' };
      if (!ctx.disputed) return { valid: false, reason: 'core/resolve_dispute requires an active dispute' };
      if (typeof data?.policy !== 'string' || data.policy.length === 0)
        return { valid: false, reason: 'core/resolve_dispute.data.policy required' };
      const effect = data?.effect;
      if (!RESOLUTION_EFFECTS.has(effect)) return { valid: false, reason: `unsupported resolution effect ${effect}` };
      let next: Partial<Ctx>;
      switch (effect) {
        case 'resume': next = { disputed: false, state: ctx.preDisputeState }; break;
        case 'authorize_settlement': next = { disputed: false, state: 'settlement_authorized' }; break;
        case 'authorize_refund': next = { disputed: false, state: 'refund_authorized' }; break;
        case 'cancel': next = { disputed: false, state: 'cancelled', terminal: true }; break;
        default: return { valid: false, reason: 'unreachable' };
      }
      next.dispute = {
        ...(ctx.dispute as DisputeInfo),
        resolvedAt: created_at,
        resolvedBy: signer,
        resolvedActionId: actionId,
        effect,
        policy: data.policy,
      };
      return { valid: true, next };
    }
    default:
      return { valid: false, reason: `unknown action ${action}` };
  }
}

function applyNext(ctx: Ctx, next: Partial<Ctx>, action: string) {
  if (next.state !== undefined) ctx.state = next.state;
  if (next.disputed !== undefined) ctx.disputed = next.disputed;
  if (next.terminal !== undefined) ctx.terminal = next.terminal;
  if (next.preDisputeState !== undefined) ctx.preDisputeState = next.preDisputeState;
  if (next.securedSeen !== undefined) ctx.securedSeen = next.securedSeen;
  if (next.fiatSentRef !== undefined) ctx.fiatSentRef = next.fiatSentRef;
  if (next.fiatConfirmedSigner !== undefined) ctx.fiatConfirmedSigner = next.fiatConfirmedSigner;
  if (next.dispute !== undefined) ctx.dispute = next.dispute;
  ctx.seenSemantics.add(action);
}

export interface ChainResult {
  canonical: Cand[];
  forks: ForkBranch[];
  anomalies: Anomaly[];
  state: SwapState;
  disputed: boolean;
  terminal: boolean;
  dispute: DisputeInfo | null;
  preDisputeState?: SwapState;
}

export function reconstructChain(
  rootEvent: NostrEvent,
  root: RootContent,
  participants: Participants,
  derived: DerivedRoles,
  rawActions: NostrEvent[],
): ChainResult {
  const anomalies: Anomaly[] = [];
  const forks: ForkBranch[] = [];
  const canonical: Cand[] = [];

  // dedup by event id
  const seenIds = new Set<Hex>();
  const cands: Cand[] = [];
  for (const e of rawActions) {
    if (seenIds.has(e.id)) {
      anomalies.push({ kind: 'duplicate_event_id', message: `duplicate event id ${e.id}`, eventId: e.id });
      continue;
    }
    seenIds.add(e.id);
    const pr = parseAction(e, rootEvent.id);
    if (!pr.valid || !pr.content || !pr.rootId || !pr.prevId) {
      for (const issue of pr.issues) {
        const kind: Anomaly['kind'] =
          issue.startsWith('event ') ? 'invalid_signature' :
          issue.startsWith('wrong kind') ? 'wrong_kind' :
          issue.startsWith('missing') ? (issue.includes('root') ? 'missing_root_ref' : 'missing_prev_ref') :
          'malformed_content';
        anomalies.push({ kind, message: issue, eventId: e.id });
      }
      continue;
    }
    cands.push({
      event: e, action: pr.content.action, data: pr.content.data,
      signer: e.pubkey, created_at: e.created_at, id: e.id, prevId: pr.prevId,
      wellFormed: true, issues: [],
    });
  }

  const ctx: Ctx = {
    state: 'proposed', disputed: false, terminal: false, dispute: null,
    seenSemantics: new Set(), securedSeen: false,
  };

  let tip: Hex = rootEvent.id;
  const applied = new Set<Hex>();

  // group well-formed by prev
  const byPrev = new Map<Hex, Cand[]>();
  for (const c of cands) {
    if (!byPrev.has(c.prevId)) byPrev.set(c.prevId, []);
    byPrev.get(c.prevId)!.push(c);
  }

  for (;;) {
    const stepCands = (byPrev.get(tip) || []).filter((c) => !applied.has(c.id));
    if (stepCands.length === 0) break;

    const evaluated = stepCands.map((c) => {
      const r = validateTransition(c.action, c.signer, c.created_at, c.data, ctx, participants, derived, root, c.id);
      return { cand: c, r };
    });
    const validOnes = evaluated.filter((x) => x.r.valid);

    if (validOnes.length >= 2) {
      forks.push({ atPrev: tip, actions: validOnes.map((x) => x.cand.event) });
      for (const x of evaluated) {
        if (!x.r.valid) anomalies.push({ kind: 'precondition_violation', message: x.r.reason!, eventId: x.cand.id, action: x.cand.action });
      }
      break; // freeze economic action on fork
    }

    if (validOnes.length === 1) {
      const { cand, r } = validOnes[0];
      applyNext(ctx, r.next!, cand.action);
      canonical.push(cand);
      applied.add(cand.id);
      tip = cand.id;
      // validate optional evidence array structurally (non-blocking, recorded as anomaly)
      if (Array.isArray(cand.data?.evidence)) {
        for (const ev of cand.data.evidence) {
          const evr = validateEvidence(ev);
          if (!evr.ok) anomalies.push({ kind: 'invalid_action_data', message: `${cand.action} evidence: ${evr.reason}`, eventId: cand.id, action: cand.action });
        }
      }
      continue;
    }

    // 0 valid: chain ends; record reasons for the invalid candidates at this tip
    for (const x of evaluated) {
      anomalies.push({ kind: 'precondition_violation', message: x.r.reason!, eventId: x.cand.id, action: x.cand.action });
    }
    break;
  }

  // remaining well-formed actions not applied and not at the final tip are orphans / out-of-order
  for (const c of cands) {
    if (applied.has(c.id)) continue;
    // was it already reported as a fork branch or precondition violation at a tip?
    if (forks.some((f) => f.actions.some((a) => a.id === c.id))) continue;
    if (anomalies.some((a) => a.eventId === c.id)) continue;
    if (c.prevId === tip) {
      // candidate at final tip that we didn't apply because loop ended without evaluating?
      // (shouldn't normally happen) — treat as out_of_order
      anomalies.push({ kind: 'out_of_order', message: `action ${c.action} references current tip but was not applied`, eventId: c.id, action: c.action });
      continue;
    }
    if (c.prevId === rootEvent.id || canonical.some((cc) => cc.id === c.prevId)) {
      anomalies.push({ kind: 'out_of_order', message: `action ${c.action} references ancestor ${c.prevId.slice(0, 8)} that already advanced`, eventId: c.id, action: c.action });
    } else {
      anomalies.push({ kind: 'dangling_prev', message: `action ${c.action} references unknown predecessor ${c.prevId.slice(0, 8)}`, eventId: c.id, action: c.action });
    }
  }

  return {
    canonical,
    forks,
    anomalies,
    state: ctx.state,
    disputed: ctx.disputed,
    terminal: ctx.terminal,
    dispute: ctx.dispute,
    preDisputeState: ctx.preDisputeState,
  };
}

export function toChainAction(c: Cand): ChainAction {
  return { event: c.event, action: c.action, data: c.data, signer: c.signer, created_at: c.created_at, id: c.id };
}
