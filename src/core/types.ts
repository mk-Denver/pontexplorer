export type Hex = string;

export interface NostrEvent {
  id: Hex;
  pubkey: Hex;
  sig: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export type Tag = string[];

export const PIP02_VERSION = 2;
export const PROFILE_ID = 'pontmore/swap@1';

export const KIND_ROOT = 7300;
export const KIND_ACTION = 7301;
export const KIND_DESCRIPTOR = 30361;

export type Direction = 'fiat_to_btc' | 'btc_to_fiat';

export interface SwapTerms {
  direction: Direction;
  fiat: { currency: string; amount: string };
  bitcoin: { amount: string; unit: 'sat'; network: string };
  payment_channel: string;
  deadlines: { fiat_pay_by: number; fiat_confirm_by: number };
}

export interface Commitment {
  algorithm: string;
  digest: string;
}

export interface RootContent {
  version: number;
  profile: string;
  terms: SwapTerms;
  expires_at: number;
  commitments?: Record<string, Commitment>;
}

export type AppRole = 'swap/agent' | 'swap/customer';
export type AuthorityRole = 'core/escrow' | 'core/resolver';
export type Role = AppRole | AuthorityRole;

export interface Participants {
  agent: Hex;
  customer: Hex;
  escrow: Hex;
  resolver?: Hex;
  proposer: Hex;
  accepter: Hex;
}

export interface DerivedRoles {
  fiatSender: AppRole;
  fiatReceiver: AppRole;
  bitcoinProvider: AppRole;
  bitcoinRecipient: AppRole;
}

export interface ActionContent {
  version: number;
  action: string;
  data?: any;
}

export type SwapState =
  | 'proposed'
  | 'accepted'
  | 'secured'
  | 'fiat_sent'
  | 'fiat_confirmed'
  | 'settlement_authorized'
  | 'refund_authorized'
  | 'settled'
  | 'refunded'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface DisputeInfo {
  openedAt: number;
  openedBy: Hex;
  class?: string;
  openedActionId: Hex;
  resolvedAt?: number;
  resolvedBy?: Hex;
  resolvedActionId?: Hex;
  effect?: 'resume' | 'authorize_settlement' | 'authorize_refund' | 'cancel';
  policy?: string;
}

export interface ChainAction {
  event: NostrEvent;
  action: string;
  data?: any;
  signer: Hex;
  created_at: number;
  id: Hex;
}

export type AnomalyKind =
  | 'invalid_signature'
  | 'invalid_id'
  | 'malformed_event'
  | 'malformed_content'
  | 'wrong_kind'
  | 'missing_root_ref'
  | 'missing_prev_ref'
  | 'dangling_prev'
  | 'duplicate_event_id'
  | 'replayed_action'
  | 'unauthorized_signer'
  | 'invalid_action_data'
  | 'out_of_order'
  | 'precondition_violation'
  | 'action_after_terminal'
  | 'disputed_freeze'
  | 'fork'
  | 'expired'
  | 'unsupported_version'
  | 'unsupported_profile';

export interface Anomaly {
  kind: AnomalyKind;
  message: string;
  eventId?: Hex;
  action?: string;
}

export interface ForkBranch {
  atPrev: Hex;
  actions: NostrEvent[];
}

export interface SwapReconstruction {
  root: NostrEvent;
  rootContent: RootContent;
  participants: Participants;
  derived: DerivedRoles;
  descriptor?: { event: NostrEvent; valid: boolean; issues: string[] };
  state: SwapState;
  preDisputeState?: SwapState;
  disputed: boolean;
  terminal: boolean;
  dispute: DisputeInfo | null;
  canonical: ChainAction[];
  forks: ForkBranch[];
  anomalies: Anomaly[];
  acceptedCount: number;
  proposerNpub: string;
}

export interface EventSource {
  fetchRoots(): Promise<NostrEvent[]>;
  fetchActions(rootId: Hex): Promise<NostrEvent[]>;
  fetchAllActions(rootIds: Hex[]): Promise<Map<Hex, NostrEvent[]>>;
  fetchDescriptorsByAddr(addrs: Hex[]): Promise<Map<string, NostrEvent>>;
  fetchDescriptorByAddr(addr: string): Promise<NostrEvent | undefined>;
  fetchDescriptorById(id: Hex): Promise<NostrEvent | undefined>;
  close(): Promise<void> | void;
}
