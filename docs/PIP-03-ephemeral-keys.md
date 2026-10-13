# PIP-03: Participant Privacy via Ephemeral Keys

> Status: Draft  
> Profile: `pontmore/swap@1` (no changes required)  
> Depends on: PIP-02 (Coordination Event Chains), NIP-44 (ECDH encryption), NIP-17 (Private Direct Messages)

## Problem

PIP-02 coordination event chains are published to **public Nostr relays**. The root event (kind 7300) binds all four participant roles via plaintext `p` tags:

- `swap/agent` — the swap operator
- `swap/customer` — the counterparty
- `core/escrow` — the bitcoin custodian
- `core/resolver` — the dispute arbitrator

Every action event (kind 7301) also carries the signer's pubkey in the Nostr `pubkey` field — this is **unavoidable**: relays need it to verify signatures, and it is fundamental to how Nostr works.

As the explorer demonstrates, anyone on a public relay can:

1. Read all participant pubkeys from the root event.
2. Link those pubkeys to Nostr profiles, prior posts, relay lists, and timing patterns.
3. Correlate swap terms (currency, amount, direction, payment channel, network) with the identified participants.
4. Build a complete history of every swap a person has ever participated in.

PIP-02 provides **pseudonymity** (a public key, not a name), but not **anonymity**. The link between a pubkey and a real person is often trivial to establish.

## Goal

Hide the long-term Nostr identities of `swap/agent` and `swap/customer` from public observers, while:

- Keeping `core/escrow` and `core/resolver` pubkeys **public** (they are service providers whose accountability and reputation are their value).
- Allowing the escrow to know who they are escrowing for.
- Allowing the resolver to identify and arbitrate between the real parties in a dispute.
- Maintaining full public verifiability of the coordination chain — anyone can still verify signatures, chain integrity, and state transitions without knowing who the participants really are.
- Requiring **no changes** to `pontmore/swap@1` verification logic. The authorization table, state machine, and invariant checks work identically.

## Design: Per-Swap Ephemeral Keys

### Overview

For each swap, both application participants generate **fresh, one-time-use keypairs**. The root event binds these ephemeral pubkeys — not the participants' long-term Nostr identities. All action events are signed by the ephemeral keys. The mapping between ephemeral keys and real identities is shared **privately** (encrypted) with the escrow and resolver.

### 1. Root event (kind 7300) — public

The root event is published to public relays as before, with one addition:

```
tags: [
  ["p", <ephemeral_agent_pubkey>, "", "swap/agent"],
  ["p", <ephemeral_customer_pubkey>, "", "swap/customer"],
  ["p", <escrow_pubkey>, "", "core/escrow"],       // real, public
  ["p", <resolver_pubkey>, "", "core/resolver"],   // real, public
  ...
]
```

The root event **pubkey** (the proposer) is also an ephemeral key.

A new content field `participant_identities` carries the encrypted identity mapping:

```json
{
  "version": 2,
  "profile": "pontmore/swap@1",
  "terms": { ... },
  "expires_at": 1234567890,
  "participant_identities": {
    "algorithm": "nip44-ecdh",
    "recipients": [
      {
        "to": "<escrow_pubkey>",
        "ciphertext": "<nip44-encrypted JSON: { swap/agent: <real_pubkey>, swap/customer: <real_pubkey> }>"
      },
      {
        "to": "<resolver_pubkey>",
        "ciphertext": "<nip44-encrypted JSON: same payload>"
      }
    ]
  }
}
```

The escrow and resolver decrypt this with their private keys to learn the real identities behind the ephemeral keys. No one else can decrypt it.

### 2. Action events (kind 7301) — public

Action events are signed by the **ephemeral keys** and published to public relays as before:

```
pubkey: <ephemeral_agent_pubkey>   // or ephemeral_customer_pubkey, or escrow_pubkey, or resolver_pubkey
```

The Nostr `pubkey` field is the ephemeral key, not the participant's long-term identity. An observer sees that "some key signed `swap/fiat_sent`" but cannot link that key to any person, profile, or other swap.

### 3. Why verification logic is unchanged

The `pontmore/swap@1` authorization table in `chain.ts` checks:

```
signer !== escrow            → core/secure, core/settle, core/refund
signer !== fiatSenderPubkey  → swap/fiat_sent
signer !== fiatReceiverPubkey → swap/fiat_confirmed, core/authorize_settlement
signer !== resolver          → core/resolve_dispute
isAppParticipant(p, signer)  → core/open_dispute, core/cancel, core/expire
```

All comparisons use the pubkeys **bound by the root event**. If the root binds ephemeral keys, the verification works identically — it checks that the action's signer matches the ephemeral key bound by the root. No code changes are needed.

The explorer, or any third-party verifier, can still:
- Verify all signatures (schnorr against the ephemeral pubkeys).
- Recompute event IDs.
- Reconstruct the full state machine.
- Detect forks, anomalies, replays, and out-of-order actions.

They simply cannot link the ephemeral keys to real people.

### 4. Dispute resolution flow

When a dispute is opened:

1. `core/open_dispute` is signed by the ephemeral key of the disputing participant (public, verifiable).
2. The resolver decrypts `participant_identities` from the root event to learn the real pubkeys behind both ephemeral keys.
3. The resolver contacts the real parties via NIP-17 private messages to gather evidence, ask questions, and arbitrate.
4. The resolver publishes `core/resolve_dispute` signed by their own (public, real) key with the effect and policy.
5. The public chain shows that "the resolver ruled with effect `authorize_settlement`" — but not who the real disputing parties are.

### 5. Post-swap lifecycle

After the swap reaches a terminal state (settled, refunded, cancelled, etc.):

- The ephemeral keys are **discarded**. They are never reused for another swap or any other Nostr activity.
- Since they have no profile, no relay list, no prior posts, and no future activity, they cannot be correlated to any person.
- The only parties who know the real identities are the escrow and resolver (who received the encrypted mapping), and the participants themselves.

## What this protects against

| Attack | Before (current PIP-02) | After (ephemeral keys) |
|--------|------------------------|----------------------|
| Linking a swap to a Nostr profile | Trivial — pubkey is in the root | Not possible — ephemeral key has no profile |
| Correlating multiple swaps by the same person | Easy — same pubkey across swaps | Not possible — fresh key per swap |
| Linking swap terms to a person | Trivial — pubkey + terms are public | Not possible — key is one-time-use |
| Building a swap history for a person | Trivial — query relay by pubkey | Not possible — different key each time |
| Real-time observer sees swap happening | Yes | Yes (but can't identify who) |
| Escrow knows participant identity | Yes | Yes (via encrypted mapping) |
| Resolver can arbitrate disputes | Yes | Yes (via encrypted mapping + NIP-17) |

## What this does NOT protect against

### 1. Terms-based correlation
The swap terms (currency, amount, direction, payment channel, network) remain public. If an observer knows that "Alice frequently does 5000 KES → 10000 sats via M-Pesa on spark," they could narrow down candidates. Mitigation: terms are required for coordination transparency; reducing their granularity would harm the protocol's auditability.

### 2. Timing correlation
A real-time observer can correlate the timing of swap events with other Nostr activity (posts, zaps, relay connections) to probabilistically link an ephemeral key to a long-term identity. Mitigation: participants should avoid posting other Nostr activity during active swaps, or use a separate relay set for swap coordination.

### 3. Relay/IP correlation
If a participant's long-term identity and ephemeral key connect to the same relay from the same IP address, the relay operator or ISP could link them. Mitigation: use a VPN or Tor for swap coordination, or use relay sets that are disjoint from the participant's normal Nostr activity.

### 4. Escrow/resolver as correlation anchors
If an escrow only serves a small, known set of agents, the escrow's pubkey itself narrows down who the agent might be. Similarly, if a resolver only serves one escrow, the link is trivial. Mitigation: escrows and resolvers should serve diverse client bases; the more swaps an escrow handles, the harder it is to single out any one participant.

### 5. Escrow and resolver are trusted with identity
The escrow and resolver learn the real identities via the encrypted mapping. If either is compromised, participant identities are exposed. Mitigation: this is inherent — the escrow must know who they're holding funds for, and the resolver must know who they're arbitrating between. The trust model is unchanged from current PIP-02 (both parties already trust the escrow with their bitcoin).

## Alternatives considered

### A. Commitment-based delayed reveal (weaker, simpler)

The root contains `commitment:sha256:<pubkey>` for participants instead of raw pubkeys. The real pubkey is revealed only when the participant signs their first action (unavoidable in Nostr).

- **Pros**: No key management; minimal protocol change.
- **Cons**: Only protects the proposing phase (before any action is signed). Once a participant acts, their long-term pubkey is public. Provides **no** protection for active or completed swaps.

### B. NIP-17 private coordination (strongest, architecture change)

The entire coordination chain is sent privately via NIP-17 direct messages. Only the participants, escrow, and resolver see the chain. A public "settlement record" signed by the escrow could be published for transparency, containing only the final state.

- **Pros**: Full privacy — nothing is public except the final outcome.
- **Cons**: Fundamentally changes the architecture. Third-party explorers cannot independently verify the chain without access to the private messages. The escrow becomes a trusted oracle for chain integrity, which contradicts PIP-02's trust-minimized design. Requires all parties to be online and reachable via NIP-17.

### C. Zero-knowledge proofs (future research)

Participants prove authorization via ZK proofs without revealing their pubkey. Each action would carry a ZK proof that "I am authorized to perform this action" without revealing which authorized key signed it.

- **Pros**: True cryptographic privacy — no pubkey is ever revealed.
- **Cons**: Requires fundamental changes to Nostr's event model (events must carry a verifiable pubkey). Far beyond current Nostr protocol capabilities. Would require a new event kind or a Nostr protocol extension. Not practical today.

## Recommendation

**Adopt the ephemeral keys design (Section 1-5).** It provides strong practical privacy with zero changes to the `pontmore/swap@1` verification logic. The protocol additions are:

1. A new root content field `participant_identities` (NIP-44 encrypted to escrow + resolver).
2. A convention that participants generate fresh keypairs per swap.
3. A recommendation that participants discard ephemeral keys after swap completion.

The escrow and resolver remain public — their accountability is their value. The swap participants gain per-swap pseudonymity that cannot be linked across swaps or to their long-term Nostr identities.

## Implementation notes for pontexplorer

The explorer requires **no changes** to support ephemeral keys. It already:

- Verifies signatures against the pubkeys bound by the root event (whether those are real or ephemeral).
- Reconstructs state from the public action chain.
- Displays participant pubkeys as npubs — these would simply show ephemeral keys, which is correct and expected.

The `participant_identities` field in the root content would be ignored by the explorer (it cannot decrypt it). An optional future enhancement could detect the field and display "identities encrypted to escrow + resolver" instead of showing raw pubkeys.
