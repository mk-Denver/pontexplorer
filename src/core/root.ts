import type { NostrEvent, Participants, DerivedRoles, SwapTerms, RootContent, Direction, Commitment } from './types.js';
import { KIND_ROOT, PIP02_VERSION, PROFILE_ID } from './types.js';
import { safeParseJSON, tagByMarker, rolePubkey } from './tags.js';
import { verifyEventStrict } from './crypto.js';

export interface RootParseResult {
  valid: boolean;
  content?: RootContent;
  participants?: Participants;
  derived?: DerivedRoles;
  descriptorEventId?: string;
  descriptorAddr?: string;
  issues: string[];
}

const DIRECTIONS: Direction[] = ['fiat_to_btc', 'btc_to_fiat'];
const COMMIT_ALGOS = new Set(['sha256-bytes@1']);

export function deriveRoles(terms: SwapTerms): DerivedRoles {
  if (terms.direction === 'fiat_to_btc') {
    return {
      fiatSender: 'swap/customer',
      fiatReceiver: 'swap/agent',
      bitcoinProvider: 'swap/agent',
      bitcoinRecipient: 'swap/customer',
    };
  }
  return {
    fiatSender: 'swap/agent',
    fiatReceiver: 'swap/customer',
    bitcoinProvider: 'swap/customer',
    bitcoinRecipient: 'swap/agent',
  };
}

function validateTerms(terms: any, issues: string[]): SwapTerms | undefined {
  if (!terms || typeof terms !== 'object') {
    issues.push('terms missing or not an object');
    return undefined;
  }
  if (!DIRECTIONS.includes(terms.direction)) {
    issues.push(`terms.direction invalid: ${JSON.stringify(terms.direction)}`);
  }
  const fiat = terms.fiat;
  if (!fiat || typeof fiat !== 'object') {
    issues.push('terms.fiat missing');
  } else {
    if (typeof fiat.currency !== 'string' || !/^[A-Z]{3}$/.test(fiat.currency))
      issues.push('terms.fiat.currency must be an uppercase ISO 4217 code');
    if (typeof fiat.amount !== 'string' || !/^\d+(\.\d+)?$/.test(fiat.amount) || Number(fiat.amount) <= 0)
      issues.push('terms.fiat.amount must be a positive base-10 decimal string');
  }
  const btc = terms.bitcoin;
  if (!btc || typeof btc !== 'object') {
    issues.push('terms.bitcoin missing');
  } else {
    if (typeof btc.amount !== 'string' || !/^\d+$/.test(btc.amount) || Number(btc.amount) <= 0)
      issues.push('terms.bitcoin.amount must be a positive base-10 integer string');
    if (btc.unit !== 'sat') issues.push('terms.bitcoin.unit must be "sat"');
    if (typeof btc.network !== 'string' || btc.network.length === 0)
      issues.push('terms.bitcoin.network missing');
  }
  if (typeof terms.payment_channel !== 'string' || terms.payment_channel.length === 0)
    issues.push('terms.payment_channel missing');
  const dl = terms.deadlines;
  if (!dl || typeof dl !== 'object') {
    issues.push('terms.deadlines missing');
  } else {
    if (typeof dl.fiat_pay_by !== 'number' || !Number.isFinite(dl.fiat_pay_by))
      issues.push('terms.deadlines.fiat_pay_by missing');
    if (typeof dl.fiat_confirm_by !== 'number' || !Number.isFinite(dl.fiat_confirm_by))
      issues.push('terms.deadlines.fiat_confirm_by missing');
  }
  return terms as SwapTerms;
}

function validateCommitments(c: any, issues: string[]): Record<string, Commitment> | undefined {
  if (c == null) return undefined;
  if (typeof c !== 'object') {
    issues.push('commitments must be an object');
    return undefined;
  }
  const out: Record<string, Commitment> = {};
  for (const [key, val] of Object.entries(c)) {
    if (!val || typeof val !== 'object') {
      issues.push(`commitments.${key} must be an object`);
      continue;
    }
    const co = val as any;
    if (typeof co.algorithm !== 'string' || !COMMIT_ALGOS.has(co.algorithm))
      issues.push(`commitments.${key}.algorithm unsupported (must be sha256-bytes@1)`);
    if (typeof co.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(co.digest))
      issues.push(`commitments.${key}.digest must be "sha256:" + 64 lowercase hex`);
    out[key] = { algorithm: co.algorithm, digest: co.digest };
  }
  return out;
}

export function parseRoot(e: NostrEvent): RootParseResult {
  const issues: string[] = [];
  if (e.kind !== KIND_ROOT) {
    issues.push(`wrong kind ${e.kind}; expected ${KIND_ROOT}`);
    return { valid: false, issues };
  }
  const v = verifyEventStrict(e);
  if (!v.ok) issues.push(`event ${v.reason}`);

  const c = safeParseJSON(e.content);
  if (!c || typeof c !== 'object') {
    issues.push('content is not a JSON object');
    return { valid: false, issues };
  }
  if (c.version !== PIP02_VERSION) issues.push(`content.version must be ${PIP02_VERSION}`);
  if (c.profile !== PROFILE_ID) {
    issues.push(`content.profile must be "${PROFILE_ID}" (got ${JSON.stringify(c.profile)})`);
    return { valid: false, issues };
  }
  if (typeof c.expires_at !== 'number' || !Number.isFinite(c.expires_at))
    issues.push('content.expires_at missing or not a number');

  const terms = validateTerms(c.terms, issues);

  // deadlines vs expires_at ordering (spec: expires_at < fiat_pay_by < fiat_confirm_by)
  if (terms && typeof c.expires_at === 'number') {
    if (!(c.expires_at < terms.deadlines.fiat_pay_by))
      issues.push('expires_at must be earlier than terms.deadlines.fiat_pay_by');
    if (!(terms.deadlines.fiat_pay_by < terms.deadlines.fiat_confirm_by))
      issues.push('terms.deadlines.fiat_pay_by must be earlier than fiat_confirm_by');
  }

  const commitments = validateCommitments(c.commitments, issues);

  // participants from role-bearing p tags
  const agent = rolePubkey(e, 'swap/agent');
  const customer = rolePubkey(e, 'swap/customer');
  const escrow = rolePubkey(e, 'core/escrow');
  const resolver = rolePubkey(e, 'core/resolver');
  const roleCount = (r: string) => (e.tags || []).filter((t) => t[0] === 'p' && (t[3] ?? '') === r).length;
  for (const r of ['swap/agent', 'swap/customer', 'core/escrow']) {
    if (roleCount(r) > 1) issues.push(`multiple p tags with role ${r}; expected exactly one`);
  }
  if (!agent) issues.push('missing p tag with role swap/agent');
  if (!customer) issues.push('missing p tag with role swap/customer');
  if (agent && customer && agent === customer)
    issues.push('swap/agent and swap/customer must be different pubkeys');
  if (!escrow) issues.push('missing p tag with role core/escrow');
  // swap-v1 permits core/open_dispute by either participant, so a resolver MUST be bound
  if (!resolver) issues.push('missing p tag with role core/resolver (required by pontmore/swap@1)');

  // descriptor references
  const eTag = tagByMarker(e, 'e', 'escrow-version');
  const aTag = tagByMarker(e, 'a', 'escrow');
  if (!eTag) issues.push('missing e tag with marker "escrow-version"');
  if (!aTag) issues.push('missing a tag with marker "escrow"');
  if (eTag && aTag) {
    // the addressable a tag coordinate kind is 30361
    const aCoord = aTag[1] || '';
    if (!aCoord.startsWith('30361:')) issues.push(`escrow a tag must be a 30361 coordinate (got ${aCoord})`);
  }

  const participants: Participants | undefined =
    agent && customer && escrow
      ? {
          agent,
          customer,
          escrow,
          resolver,
          proposer: e.pubkey,
          accepter: e.pubkey === agent ? customer : agent,
        }
      : undefined;

  const derived = terms ? deriveRoles(terms) : undefined;

  const content: RootContent | undefined =
    terms && typeof c.expires_at === 'number'
      ? { version: c.version, profile: c.profile, terms, expires_at: c.expires_at, commitments }
      : undefined;

  return {
    valid: issues.length === 0,
    content,
    participants,
    derived,
    descriptorEventId: eTag?.[1],
    descriptorAddr: aTag?.[1],
    issues,
  };
}
