import type { Participants, DerivedRoles, Hex } from './types.js';

export const KERNEL_ACTIONS = new Set([
  'core/accept',
  'core/decline',
  'core/secure',
  'core/authorize_settlement',
  'core/settle',
  'core/authorize_refund',
  'core/refund',
  'core/cancel',
  'core/expire',
  'core/open_dispute',
  'core/resolve_dispute',
]);

export const PROFILE_ACTIONS = new Set(['swap/fiat_sent', 'swap/fiat_confirmed']);

export const DISPUTE_CLASSES = new Set([
  'fiat_not_received',
  'incorrect_fiat_amount',
  'payment_reference_invalid',
  'escrow_not_secured',
  'bitcoin_not_released',
  'conflicting_confirmation',
  'timeout',
]);

export const RESOLUTION_EFFECTS = new Set(['resume', 'authorize_settlement', 'authorize_refund', 'cancel']);

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export function isAppParticipant(p: Participants, pk: Hex): boolean {
  return pk === p.agent || pk === p.customer;
}

export function appRole(p: Participants, pk: Hex): 'swap/agent' | 'swap/customer' | undefined {
  if (pk === p.agent) return 'swap/agent';
  if (pk === p.customer) return 'swap/customer';
  return undefined;
}

export function pubkeyForRole(p: Participants, role: 'swap/agent' | 'swap/customer'): Hex {
  return role === 'swap/agent' ? p.agent : p.customer;
}

export function fiatSenderPubkey(p: Participants, d: DerivedRoles): Hex {
  return pubkeyForRole(p, d.fiatSender);
}
export function fiatReceiverPubkey(p: Participants, d: DerivedRoles): Hex {
  return pubkeyForRole(p, d.fiatReceiver);
}
export function bitcoinProviderPubkey(p: Participants, d: DerivedRoles): Hex {
  return pubkeyForRole(p, d.bitcoinProvider);
}

const SAFE_PAYMENT_REFERENCE = /^(commitment:sha256:[0-9a-f]{64}|opaque:[A-Za-z0-9._\-:]+)$/;

export type PaymentRef = string | { algorithm: string; digest: string };

export function normalizePaymentRef(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') {
    const o = ref as any;
    if (typeof o.algorithm === 'string' && typeof o.digest === 'string')
      return `${o.algorithm}:${o.digest}`;
  }
  return undefined;
}

export function validatePaymentReference(ref: unknown): { ok: boolean; reason?: string; value?: PaymentRef } {
  if (ref == null) return { ok: false, reason: 'payment_reference missing' };
  // object form: { algorithm, digest } — a PIP-02 commitment
  if (typeof ref === 'object') {
    const o = ref as any;
    if (typeof o.algorithm !== 'string' || o.algorithm.length === 0)
      return { ok: false, reason: 'payment_reference.algorithm missing' };
    if (typeof o.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o.digest))
      return { ok: false, reason: 'payment_reference.digest must be sha256:<64hex>' };
    return { ok: true, value: ref as PaymentRef };
  }
  if (typeof ref !== 'string' || ref.length === 0) return { ok: false, reason: 'payment_reference missing' };
  if (ref.length > 256) return { ok: false, reason: 'payment_reference too long' };
  if (!SAFE_PAYMENT_REFERENCE.test(ref))
    return { ok: false, reason: 'payment_reference must be opaque:<id>, commitment:sha256:<64hex>, or a {algorithm,digest} object' };
  return { ok: true, value: ref };
}

export function referencesSamePayment(a: unknown, b: unknown): boolean {
  const na = normalizePaymentRef(a);
  const nb = normalizePaymentRef(b);
  return na != null && nb != null && na === nb;
}

export function validateEvidence(e: any): { ok: boolean; reason?: string } {
  if (!e || typeof e !== 'object') return { ok: false, reason: 'evidence entry must be an object' };
  if (e.type !== 'event' && e.type !== 'commitment' && e.type !== 'opaque')
    return { ok: false, reason: 'evidence.type must be event|commitment|opaque' };
  if (typeof e.value !== 'string' || e.value.length === 0)
    return { ok: false, reason: 'evidence.value missing' };
  return { ok: true };
}
