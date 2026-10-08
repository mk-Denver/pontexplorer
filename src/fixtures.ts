import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NostrEvent } from './core/types.js';

type Sk = Uint8Array;
interface KeyPair { sk: Sk; pk: string }
function kp(): KeyPair {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

const T0 = 1780000000;
const EXPIRES = 1780001000;
const PAY_BY = 1780001800;
const CONFIRM_BY = 1780003600;

const TERMS = {
  direction: 'fiat_to_btc',
  fiat: { currency: 'KES', amount: '1000' },
  bitcoin: { amount: '60000', unit: 'sat', network: 'lightning' },
  payment_channel: 'mpesa-ke-kes@1',
  deadlines: { fiat_pay_by: PAY_BY, fiat_confirm_by: CONFIRM_BY },
};

function mkDescriptor(escrow: KeyPair, dVal: string, expiresAt = CONFIRM_BY + 1000): NostrEvent {
  const tmpl = {
    kind: 30361,
    created_at: T0 - 100,
    tags: [
      ['d', dVal],
      ['t', 'pontmore-network:lightning'],
    ],
    content: JSON.stringify({
      version: 1,
      escrow_type: 'lightning_hold_invoice',
      networks: ['lightning'],
      expires_at: expiresAt,
      service: { schema: { type: 'openapi', url: 'https://example.com/escrow-v1.json' } },
    }),
  };
  return finalizeEvent(tmpl, escrow.sk) as NostrEvent;
}

function mkRoot(
  proposer: KeyPair,
  agent: KeyPair,
  customer: KeyPair,
  escrow: KeyPair,
  resolver: KeyPair,
  desc: NostrEvent,
  terms: any = TERMS,
  expiresAt = EXPIRES,
): NostrEvent {
  const dVal = desc.tags.find((t) => t[0] === 'd')![1];
  const addr = `30361:${escrow.pk}:${dVal}`;
  const tmpl = {
    kind: 7300,
    created_at: T0,
    tags: [
      ['p', agent.pk, '', 'swap/agent'],
      ['p', customer.pk, '', 'swap/customer'],
      ['p', escrow.pk, '', 'core/escrow'],
      ['p', resolver.pk, '', 'core/resolver'],
      ['e', desc.id, '', 'escrow-version'],
      ['a', addr, '', 'escrow'],
    ],
    content: JSON.stringify({ version: 2, profile: 'pontmore/swap@1', terms, expires_at: expiresAt }),
  };
  return finalizeEvent(tmpl, proposer.sk) as NostrEvent;
}

function mkAction(
  signer: KeyPair,
  rootId: string,
  prevId: string,
  action: string,
  data: any = undefined,
  createdAt = T0 + 60,
): NostrEvent {
  const content: any = { version: 2, action };
  if (data !== undefined) content.data = data;
  const tmpl = {
    kind: 7301,
    created_at: createdAt,
    tags: [
      ['e', rootId, '', 'root'],
      ['e', prevId, '', 'prev'],
    ],
    content: JSON.stringify(content),
  };
  return finalizeEvent(tmpl, signer.sk) as NostrEvent;
}

class Chain {
  root: NostrEvent;
  prev: NostrEvent;
  events: NostrEvent[] = [];
  constructor(root: NostrEvent) {
    this.root = root;
    this.prev = root;
  }
  add(signer: KeyPair, action: string, data?: any, at = T0 + 60 + this.events.length * 60): NostrEvent {
    const e = mkAction(signer, this.root.id, this.prev.id, action, data, at);
    this.events.push(e);
    this.prev = e;
    return e;
  }
  sibling(signer: KeyPair, prev: NostrEvent, action: string, data?: any, at = T0 + 999): NostrEvent {
    const e = mkAction(signer, this.root.id, prev.id, action, data, at);
    this.events.push(e);
    return e;
  }
}

interface ScenarioSet {
  keys: {
    agent: KeyPair; customer: KeyPair; escrow: KeyPair; resolver: KeyPair;
  };
  events: NostrEvent[];
}

function freshKeys() {
  const agent = kp(), customer = kp(), escrow = kp(), resolver = kp();
  return { agent, customer, escrow, resolver };
}

function scenario(name: string, build: (k: ReturnType<typeof freshKeys>) => NostrEvent[]): { name: string; events: NostrEvent[] } {
  const k = freshKeys();
  return { name, events: build(k) };
}

const PAY_REF_A = 'commitment:sha256:' + 'a'.repeat(64);
const PAY_REF_B = 'commitment:sha256:' + 'b'.repeat(64);

const scenarios = [
  scenario('normal-settlement', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    c.add(k.agent, 'swap/fiat_confirmed', { payment_reference: PAY_REF_A }, T0 + 240);
    c.add(k.agent, 'core/authorize_settlement', undefined, T0 + 300);
    c.add(k.escrow, 'core/settle', undefined, T0 + 360);
    return [desc, root, ...c.events];
  }),

  scenario('no-payment-refund', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.agent, 'core/authorize_refund', undefined, PAY_BY + 100);
    c.add(k.escrow, 'core/refund', undefined, PAY_BY + 200);
    return [desc, root, ...c.events];
  }),

  scenario('dispute-resolved-to-settle', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    const afterSent = c.prev;
    c.add(k.customer, 'core/open_dispute', { class: 'fiat_not_received' }, T0 + 200);
    c.add(k.resolver, 'core/resolve_dispute', { policy: 'default', effect: 'authorize_settlement' }, T0 + 260);
    void afterSent;
    c.add(k.escrow, 'core/settle', undefined, T0 + 360);
    return [desc, root, ...c.events];
  }),

  scenario('dispute-resolved-to-refund', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    c.add(k.agent, 'core/open_dispute', { class: 'incorrect_fiat_amount' }, T0 + 200);
    c.add(k.resolver, 'core/resolve_dispute', { policy: 'default', effect: 'authorize_refund' }, T0 + 260);
    c.add(k.escrow, 'core/refund', undefined, T0 + 360);
    return [desc, root, ...c.events];
  }),

  scenario('fork-at-fiat-sent', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    const secure = c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    c.sibling(k.customer, secure, 'swap/fiat_sent', { payment_reference: PAY_REF_B }, T0 + 181);
    return [desc, root, ...c.events];
  }),

  scenario('unauthorized-secure', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.customer, 'core/secure', undefined, T0 + 120); // wrong signer (customer, not escrow)
    return [desc, root, ...c.events];
  }),

  scenario('duplicate-event', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    const secure = c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    c.add(k.agent, 'swap/fiat_confirmed', { payment_reference: PAY_REF_A }, T0 + 240);
    c.add(k.agent, 'core/authorize_settlement', undefined, T0 + 300);
    c.add(k.escrow, 'core/settle', undefined, T0 + 360);
    return [desc, root, ...c.events, secure]; // publish `secure` twice (same event id)
  }),

  scenario('dangling-prev', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    const ghost = mkAction(k.customer, root.id, 'f'.repeat(64), 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 181);
    return [desc, root, ...c.events, ghost];
  }),

  scenario('replay-accept', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    const accept = c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    const replay = mkAction(k.customer, root.id, accept.id, 'core/accept', undefined, T0 + 90);
    return [desc, root, ...c.events, replay];
  }),

  scenario('mismatched-payment-reference', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.customer, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180);
    c.add(k.agent, 'swap/fiat_confirmed', { payment_reference: PAY_REF_B }, T0 + 240); // different ref
    return [desc, root, ...c.events];
  }),

  scenario('expired-unaccepted', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/expire', undefined, EXPIRES + 100);
    return [desc, root, ...c.events];
  }),

  scenario('declined', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/decline', undefined, T0 + 60);
    return [desc, root, ...c.events];
  }),

  scenario('bad-signature', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    const root = mkRoot(k.agent, k.agent, k.customer, k.escrow, k.resolver, desc);
    const c = new Chain(root);
    c.add(k.customer, 'core/accept', undefined, T0 + 60);
    const secure = c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    const tampered: NostrEvent = { ...secure, sig: '0'.repeat(128) };
    return [desc, root, c.events[0], tampered];
  }),

  scenario('btc-to-fiat-direction', (k) => {
    const desc = mkDescriptor(k.escrow, 'desc-' + k.escrow.pk.slice(0, 6));
    // btc_to_fiat: agent sends fiat, customer provides bitcoin; proposer = customer this time
    const terms = { ...TERMS, direction: 'btc_to_fiat' as const };
    const root = mkRoot(k.customer, k.agent, k.customer, k.escrow, k.resolver, desc, terms);
    const c = new Chain(root);
    c.add(k.agent, 'core/accept', undefined, T0 + 60); // non-proposing = agent
    c.add(k.escrow, 'core/secure', undefined, T0 + 120);
    c.add(k.agent, 'swap/fiat_sent', { payment_reference: PAY_REF_A }, T0 + 180); // fiat sender = agent
    c.add(k.customer, 'swap/fiat_confirmed', { payment_reference: PAY_REF_A }, T0 + 240); // fiat receiver = customer
    c.add(k.customer, 'core/authorize_settlement', undefined, T0 + 300);
    c.add(k.escrow, 'core/settle', undefined, T0 + 360);
    return [desc, root, ...c.events];
  }),
];

function main() {
  const all: NostrEvent[] = [];
  const summary: { name: string; count: number }[] = [];
  for (const s of scenarios) {
    for (const e of s.events) all.push(e);
    summary.push({ name: s.name, count: s.events.length });
  }
  const outDir = join(process.cwd(), 'fixtures');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'events.json');
  writeFileSync(outPath, JSON.stringify(all, null, 2));
  console.log(`Wrote ${all.length} events for ${scenarios.length} scenarios to ${outPath}`);
  for (const s of summary) console.log(`  ${s.name.padEnd(32)} ${s.count} events`);
  console.log('\nRun the explorer against them with:');
  console.log('  npm run dev -- --offline fixtures/events.json list');
  console.log('  npm run dev -- --offline fixtures/events.json inspect <root-id>');
}

main();
