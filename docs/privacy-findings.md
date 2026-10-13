# Privacy findings & recommendations: participant pubkeys in PIP-02 coordination chains

> Source: `pontexplorer` — read-only PIP-02 / `pontmore/swap@1` swap reconstruction  
> Date: October 2026

## Finding 1: All participant pubkeys are public

PIP-02 coordination root events (kind 7300) bind all four participant roles via plaintext `p` tags:

- `swap/agent` — the swap operator
- `swap/customer` — the counterparty
- `core/escrow` — the bitcoin custodian
- `core/resolver` — the dispute arbitrator

Every action event (kind 7301) also carries the signer's pubkey in the Nostr `pubkey` field. This is **unavoidable** — relays need it to verify signatures, and it is fundamental to how Nostr works.

Because these events are published to public relays, anyone can:

1. Read all participant pubkeys from the root event.
2. Link those pubkeys to Nostr profiles, prior posts, relay lists, and timing patterns.
3. Correlate swap terms (currency, amount, direction, payment channel, network) with the identified participants.
4. Build a complete history of every swap a person has ever participated in — across all swaps, not just one.

PIP-02 provides **pseudonymity** (a public key, not a name), but not **anonymity**. The link between a pubkey and a real person is often trivial to establish.

## Finding 2: The same pubkey is reused across swaps

There is no mechanism in PIP-02 or `pontmore/swap@1` that requires or encourages participants to use a fresh keypair per swap. In practice, participants reuse their long-term Nostr identity for every swap.

This means:

- All swaps by the same `swap/agent` are trivially linkable by querying a relay for kind 7300/7301 events with that pubkey.
- All swaps by the same `swap/customer` are similarly linkable.
- An observer can build a complete transaction history for any participant.

## Finding 3: Swap terms are public and correlate to participants

The swap terms (fiat currency, fiat amount, bitcoin amount in sats, direction, payment channel, network) are in the root event's JSON content — fully public. Combined with the participant pubkeys, an observer can determine:

- Who trades which currencies.
- Typical swap sizes per participant.
- Payment channels used (M-Pesa, bank transfer, etc.).
- Bitcoin networks and amounts per participant.

Even without linking a pubkey to a real-world identity, this creates a detailed behavioral profile per pubkey.

## Finding 4: Escrow and resolver pubkeys are inherently public service identities

The `core/escrow` and `core/resolver` roles are **service providers**. Their value proposition is accountability and reputation — they **must** be publicly identifiable so that:

- Participants can choose a trusted escrow/resolver.
- Their track record (past swaps, dispute resolutions, settlement/refund history) is publicly auditable.
- They can be held accountable for misbehavior.

Hiding escrow/resolver pubkeys would undermine the protocol's trust model. These pubkeys should remain public.

## Finding 5: No privacy guidance exists in the current specifications

Neither PIP-02 nor `pontmore/swap@1` discusses:

- Key reuse across swaps and its privacy implications.
- The linkability of participant pubkeys to Nostr profiles and other activity.
- Recommended practices for participants who want to reduce correlation.
- The trade-off between coordination transparency and participant privacy.

There is no privacy threat model, no guidance for implementers, and no privacy considerations section.

## Finding 6: The escrow does not need to know participant identities

The escrow's role in PIP-02 is **bitcoin custodianship**, not identity verification. The escrow performs three actions:

- `core/secure` — locks bitcoin into escrow
- `core/settle` — releases bitcoin to the recipient
- `core/refund` — returns bitcoin to the provider

What the escrow actually needs to perform these actions:

| What the escrow needs | Where it comes from | Tied to Nostr identity? |
|-----------------------|---------------------|------------------------|
| Which bitcoin to lock (UTXOs, addresses, scripts) | PIP-01 escrow descriptor (kind 30361) | No — bitcoin addresses, not Nostr pubkeys |
| When to settle (chain reaches `settlement_authorized`) | Public coordination chain (kind 7301) | No — public state transition |
| When to refund (chain reaches `refund_authorized`) | Public coordination chain (kind 7301) | No — public state transition |
| Which bitcoin address to send to on settle/refund | PIP-01 escrow descriptor | No — bitcoin addresses, not Nostr pubkeys |

The escrow interacts with the **bitcoin blockchain**, not with the participants' Nostr identities. The "who" in bitcoin terms (addresses, scripts, UTXOs) is encoded in the PIP-01 escrow descriptor, which is a separate event from the coordination root. The coordination chain tells the escrow **when** to act, not **who** to act for.

During an active swap, the escrow can communicate with participants via NIP-17 direct messages to their ephemeral keys (which are live during the swap). After the swap completes, the ephemeral keys are discarded.

**Conclusion: the escrow does not need to know the real Nostr identities of `swap/agent` or `swap/customer`.** Any identity verification (KYC, AML) is an off-protocol concern handled out-of-band, not a PIP-02 concern.

## Finding 7: The resolver only needs identities during a dispute

The resolver's role in PIP-02 is **dispute arbitration**. The resolver performs one action:

- `core/resolve_dispute` — rules on a dispute with an effect (`resume`, `authorize_settlement`, `authorize_refund`, `cancel`)

Before a dispute is opened, the resolver has no role and no need to know who the participants are. The resolver only needs to identify the real parties when:

1. A `core/open_dispute` action is published on the coordination chain.
2. The resolver needs to contact both parties to gather evidence and arbitrate.

The resolver's ruling itself (`core/resolve_dispute`) is a public coordination-chain event — it records the effect and policy, not the parties' identities.

**Conclusion: the resolver should only learn participant identities at dispute time, not at root creation.**

---

## Recommendations

### Recommendation 1: Use fresh ephemeral keypairs per swap (participant roles only)

For each swap, both `swap/agent` and `swap/customer` generate **fresh, one-time-use keypairs**. The root event binds these ephemeral pubkeys — not the participants' long-term Nostr identities. All action events are signed by the ephemeral keys.

After the swap reaches a terminal state, the ephemeral keys are discarded. Since they have no profile, no relay list, no prior posts, and no future activity, they cannot be correlated to any person or any other swap.

**What this achieves:**

| Attack | Current | With ephemeral keys |
|--------|---------|-------------------|
| Linking a swap to a Nostr profile | Trivial | Not possible — ephemeral key has no profile |
| Correlating multiple swaps by the same person | Easy — same pubkey | Not possible — fresh key per swap |
| Building a swap history for a person | Trivial — query relay by pubkey | Not possible — different key each time |
| Linking swap terms to a person | Trivial | Not possible — key is one-time-use |

**What this does not change:**

- Public verifiability of the coordination chain — anyone can still verify signatures, chain integrity, and state transitions against the ephemeral keys.
- The `pontmore/swap@1` authorization table — all comparisons use pubkeys bound by the root event, whether real or ephemeral. No verification logic changes.

### Recommendation 2: Do NOT encrypt identities to the escrow

The escrow does not need participant identities (see Finding 6). Its job is bitcoin custodianship driven by the PIP-01 escrow descriptor (bitcoin addresses) and the public coordination chain (state transitions). It should never receive the real Nostr identities of `swap/agent` or `swap/customer`.

This means:

- No `participant_identities` field encrypted to the escrow in the root event.
- The escrow interacts with the swap purely through the public coordination chain and the PIP-01 escrow descriptor.
- If the escrow is compromised, participant Nostr identities are **not** exposed (unlike a model where the escrow holds the encrypted mapping).

### Recommendation 3: Reveal identities to the resolver only at dispute time

Instead of encrypting identities in the root event at swap creation, identities should be revealed to the resolver **only when a dispute is opened**:

1. **At swap creation**: no identity information is published or encrypted. The root binds only ephemeral keys for `swap/agent` and `swap/customer`, and public keys for `core/escrow` and `core/resolver`.

2. **When a dispute is opened** (`core/open_dispute` is published on the public chain): the disputing party contacts the resolver via NIP-17 private direct messages, revealing:
   - Their own real Nostr identity (so the resolver can verify who they are and contact them).
   - The other party's real Nostr identity (so the resolver can contact them for their side of the dispute).
   - Any evidence supporting their case.

3. **The resolver arbitrates**: contacts both real parties via NIP-17, gathers evidence, and publishes `core/resolve_dispute` on the public chain with the effect and policy. The public chain shows that "the resolver ruled with effect `authorize_settlement`" — but not who the real disputing parties are.

4. **After resolution**: the resolver discards the identity information. It is not published on any relay and leaves no permanent record.

**Advantages over encrypting identities at root creation:**

| | Encrypted at root (earlier proposal) | Revealed at dispute time (recommended) |
|---|---|---|
| Escrow learns identities | Yes (at creation) | **Never** |
| Resolver learns identities | Yes (at creation) | **Only if a dispute is opened** |
| Identities on any relay | Encrypted ciphertext in root content | **None** — sent via NIP-17, never published |
| Compromise of escrow | Exposes all participants' identities | **No identities to expose** |
| Compromise of resolver | Exposes all participants' identities | Exposes only participants of **disputed** swaps |
| Privacy for non-disputed swaps | Resolver has identities but doesn't need them | **No one has the identities** — maximum privacy |

For the vast majority of swaps that never reach a dispute, no one — not the escrow, not the resolver, not any relay — ever knows the real Nostr identities of the participants. The identities exist only in the participants' own clients and in private NIP-17 messages sent during a dispute.

### Recommendation 4: Add a privacy considerations section to PIP-02

PIP-02 should include a section covering:

- The fact that all participant pubkeys are public on relays.
- The risk of key reuse across swaps and the linkability it creates.
- The recommendation to use ephemeral keys for `swap/agent` and `swap/customer` (while keeping `core/escrow` and `core/resolver` as public service identities).
- The finding that the escrow does not need participant Nostr identities (bitcoin custody is driven by the PIP-01 descriptor and the public coordination chain).
- The finding that the resolver only needs identities at dispute time (via NIP-17, not published on relays).
- The trade-offs: ephemeral keys add key management complexity but break cross-swap correlation; conditional identity reveal minimizes the parties who ever learn real identities.
- The residual risks that ephemeral keys and conditional reveal do not address (see below).

### Recommendation 5: Document residual risks

Even with ephemeral keys and conditional identity reveal, the following privacy risks remain and should be documented:

**Terms-based correlation.** The swap terms (currency, amount, direction, payment channel, network) remain public. If an observer knows that a specific person frequently does 5000 KES → 10000 sats via M-Pesa on spark, they could narrow candidates. Mitigation: terms are required for coordination transparency; reducing their granularity would harm auditability.

**Timing correlation.** A real-time observer can correlate the timing of swap events with other Nostr activity (posts, zaps, relay connections) to probabilistically link an ephemeral key to a long-term identity. Mitigation: participants should avoid other Nostr activity during active swaps, or use disjoint relay sets for swap coordination.

**Relay/IP correlation.** If a participant's long-term identity and ephemeral key connect to the same relay from the same IP, the relay operator or ISP can link them. Mitigation: use a VPN or Tor for swap coordination, or use relay sets disjoint from normal Nostr activity.

**Escrow/resolver as correlation anchors.** If an escrow only serves a small, known set of agents, the escrow's pubkey itself narrows the candidate pool. If a resolver only serves one escrow, the link is trivial. Mitigation: escrows and resolvers should serve diverse client bases.

**Dispute-time identity exposure.** When a dispute is opened, the disputing party reveals identities to the resolver via NIP-17. If the resolver is compromised, the identities of the disputing parties are exposed. If NIP-17 messages are stored on relays (even encrypted), they create a persistent record. Mitigation: NIP-17 messages should use ephemeral relays and be deleted after the dispute is resolved. This risk is limited to disputed swaps only — non-disputed swaps have no identity exposure at all.

**Collusion between escrow and resolver.** If the escrow and resolver collude, they could combine their knowledge (the escrow knows the bitcoin side, the resolver knows the identities from disputes) to link participants across swaps. Mitigation: this is a fundamental trust assumption — the protocol assumes the escrow and resolver are independent. In practice, they should be separate operators with no data-sharing agreements.

### Alternatives considered

**Encrypted identities at root creation (earlier draft of this proposal).** Identities are NIP-44 encrypted to both escrow and resolver in the root event content. The escrow and resolver can decrypt at any time. Rejected because: (a) the escrow does not need identities (Finding 6), (b) it creates a persistent ciphertext record on public relays, (c) it exposes all participants' identities if the escrow or resolver is compromised — not just disputed swaps, and (d) the resolver having identities before any dispute exists is unnecessary.

**Commitment-based delayed reveal.** Root contains `commitment:sha256:<pubkey>` for participants instead of raw pubkeys. The real pubkey is revealed only when the participant signs their first action (unavoidable in Nostr). Only protects the proposing phase; once any action is signed, the long-term pubkey is public. Provides no protection for active or completed swaps. Rejected.

**NIP-17 private coordination.** The entire chain is sent privately; only a final settlement record is public. Full privacy for participants, but third-party explorers cannot independently verify the chain without access to private messages. The escrow becomes a trusted oracle for chain integrity, contradicting PIP-02's trust-minimized design. Rejected.

**Zero-knowledge proofs.** Participants prove authorization without revealing their pubkey. Would provide true cryptographic privacy, but requires fundamental changes to Nostr's event model (events must carry a verifiable pubkey). Not practical with current Nostr protocol capabilities. Rejected as not implementable today; noted as future research.

---

## Impact on pontexplorer

The explorer requires **no changes** to support ephemeral keys. It already verifies signatures against the pubkeys bound by the root event (whether real or ephemeral) and reconstructs state from the public action chain. The displayed npubs would simply show ephemeral keys, which is correct.

The conditional identity reveal (NIP-17 at dispute time) happens entirely outside the coordination chain — the explorer never sees it and requires no changes. The public chain shows the same `core/open_dispute` and `core/resolve_dispute` events regardless of whether identities were revealed privately.