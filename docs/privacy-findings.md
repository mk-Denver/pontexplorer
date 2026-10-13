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

---

## Recommendations

### Recommendation 1: Use fresh ephemeral keypairs per swap (participant roles only)

For each swap, both `swap/agent` and `swap/customer` generate **fresh, one-time-use keypairs**. The root event binds these ephemeral pubkeys — not the participants' long-term Nostr identities. All action events are signed by the ephemeral keys.

The real identity mapping is encrypted (NIP-44 ECDH) to the escrow and resolver via a new root content field `participant_identities`:

```json
{
  "participant_identities": {
    "algorithm": "nip44-ecdh",
    "recipients": [
      { "to": "<escrow_pubkey>", "ciphertext": "<nip44-encrypted JSON>" },
      { "to": "<resolver_pubkey>", "ciphertext": "<nip44-encrypted JSON>" }
    ]
  }
}
```

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
- The escrow and resolver know the real identities (via the encrypted mapping), which is inherent — the escrow must know who they're holding funds for, and the resolver must know who they're arbitrating between.

### Recommendation 2: Add a privacy considerations section to PIP-02

PIP-02 should include a section covering:

- The fact that all participant pubkeys are public on relays.
- The risk of key reuse across swaps and the linkability it creates.
- The recommendation to use ephemeral keys for `swap/agent` and `swap/customer` (while keeping `core/escrow` and `core/resolver` as public service identities).
- The trade-offs: ephemeral keys add key management complexity but break cross-swap correlation.
- The residual risks that ephemeral keys do not address (see below).

### Recommendation 3: Document residual risks

Even with ephemeral keys, the following privacy risks remain and should be documented:

**Terms-based correlation.** The swap terms (currency, amount, direction, payment channel, network) remain public. If an observer knows that a specific person frequently does 5000 KES → 10000 sats via M-Pesa on spark, they could narrow candidates. Mitigation: terms are required for coordination transparency; reducing their granularity would harm auditability.

**Timing correlation.** A real-time observer can correlate the timing of swap events with other Nostr activity (posts, zaps, relay connections) to probabilistically link an ephemeral key to a long-term identity. Mitigation: participants should avoid other Nostr activity during active swaps, or use disjoint relay sets for swap coordination.

**Relay/IP correlation.** If a participant's long-term identity and ephemeral key connect to the same relay from the same IP, the relay operator or ISP can link them. Mitigation: use a VPN or Tor for swap coordination, or use relay sets disjoint from normal Nostr activity.

**Escrow/resolver as correlation anchors.** If an escrow only serves a small, known set of agents, the escrow's pubkey itself narrows the candidate pool. If a resolver only serves one escrow, the link is trivial. Mitigation: escrows and resolvers should serve diverse client bases.

**Escrow and resolver are trusted with identity.** The encrypted identity mapping is decryptable by the escrow and resolver. If either is compromised, participant identities are exposed. This is inherent to the trust model — the escrow must know who they're escrowing for.

### Recommendation 4: Consider NIP-17 private messages for dispute evidence exchange

Currently, dispute resolution requires the resolver to contact the real participants. With ephemeral keys, the resolver uses the decrypted identity mapping to reach the real parties via NIP-17 private direct messages. The public coordination chain shows only that "the resolver ruled with effect `authorize_settlement`" — not who the real disputing parties are.

This keeps dispute proceedings private while keeping the coordination chain's integrity public and verifiable.

### Alternatives considered

**Commitment-based delayed reveal.** Root contains `commitment:sha256:<pubkey>` for participants instead of raw pubkeys. The real pubkey is revealed only when the participant signs their first action (unavoidable in Nostr). Only protects the proposing phase; once any action is signed, the long-term pubkey is public. Provides no protection for active or completed swaps.

**NIP-17 private coordination.** The entire chain is sent privately; only a final settlement record is public. Full privacy for participants, but third-party explorers cannot independently verify the chain without access to private messages. The escrow becomes a trusted oracle for chain integrity, contradicting PIP-02's trust-minimized design.

**Zero-knowledge proofs.** Participants prove authorization without revealing their pubkey. Would provide true cryptographic privacy, but requires fundamental changes to Nostr's event model (events must carry a verifiable pubkey). Not practical with current Nostr protocol capabilities.

---

## Impact on pontexplorer

The explorer requires **no changes** to support ephemeral keys. It already verifies signatures against the pubkeys bound by the root event (whether real or ephemeral) and reconstructs state from the public action chain. The displayed npubs would simply show ephemeral keys, which is correct.

The `participant_identities` field in the root content would be ignored by the explorer (it cannot decrypt it). An optional future enhancement could detect the field and display "identities encrypted to escrow + resolver" instead of showing raw pubkeys.