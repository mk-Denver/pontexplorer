# pontexplorer

A **read-only** explorer for Pontmore fiat/Bitcoin swaps. It reconstructs swap state from public Nostr events — implementing [PIP-01: Escrow Descriptor](https://github.com/pontmore/protocol/blob/main/PIP-01-escrow-descriptor.md), [PIP-02: Coordination Event Chains](https://github.com/pontmore/protocol/blob/main/PIP-02-coordination-event-chains.md), and the [`pontmore/swap@1`](https://github.com/pontmore/protocol/blob/main/profiles/swap-v1.md) profile.

It does **not** read any escrow database, operator dashboard, private API, or private message. It only reads the public event chain that PIP-02 makes possible.

## What it does

```
Nostr relays (or an offline file)
   ↓
find kind 7300 roots (pontmore/swap@1)
   ↓
find kind 7301 actions for each root
   ↓
verify Nostr IDs and schnorr signatures (strict)
   ↓
follow root and prev links
   ↓
apply PIP-02 kernel invariants + pontmore/swap@1 rules
   ↓
display derived swap state
```

The explorer derives the full swap state machine:

```
proposed → accepted → secured → fiat_sent → fiat_confirmed → settlement_authorized → settled
                                   ↘ (no payment)                          ↘ disputed → resolved → …
                                       refund_authorized → refunded
```

It also detects: **disputes**, **refunds**, **cancellations**, **expiry**, **invalid signatures/IDs**, **duplicate event IDs**, **replayed semantic actions**, **out-of-order actions**, **unauthorized signers**, **dangling `prev` references**, **forks** (two valid actions on the same predecessor → economic action frozen), and **mismatched payment references**.

## Privacy (what is and is not visible)

Consistent with PIP-02, this explorer sees **public keys and public terms** but not real-world identities:

- **Visible:** the `swap/agent`, `swap/customer`, `core/escrow`, and `core/resolver` Nostr public keys; the swap terms (currency, amounts, direction, network, payment channel, deadlines); the public action history; the PIP-01 descriptor compatibility facts.
- **Not visible:** names, phone numbers, bank or mobile-money account details, invoices, receipts, screenshots, credentials, tokens, settlement secrets. Those are never placed in public event content. Actions carry only safe opaque identifiers or versioned commitments (e.g. `commitment:sha256:…`).

PIP-02 provides **pseudonymity**, not anonymity. A public key can still be linked to a person through prior posts, profiles, relay lists, timing, or out-of-protocol messages.

## Quick start

```bash
npm install
npm run fixtures        # generate signed demo event chains to fixtures/events.json
npm run dev -- --offline fixtures/events.json list
npm run dev -- --offline fixtures/events.json inspect latest
npm run server -- --offline fixtures/events.json   # web UI at http://127.0.0.1:4780
```

No internet access is required for the offline demo. All events are real, cryptographically signed Nostr events.

## Reading from real relays

```bash
npm run dev -- --relay wss://relay.damus.io,wss://nos.lol list
npm run server -- --relay wss://relay.damus.io
```

The default relay set is `wss://relay.damus.io`, `wss://nos.lol`, and `wss://relay.primal.net`.

> **Note:** as of October 2026, there are already live `pontmore/swap@1` v2 coordination chains on public Nostr relays (test swaps on `spark` network with KES/sats terms). Run `npm run dev -- --relay wss://relay.damus.io,wss://nos.lol list` to see them. The explorer fetches all roots in one batched query, then all actions and descriptors in parallel, so it handles dozens of swaps in seconds.

## Commands

### CLI

```
pontexplorer [--offline <file> | --relay <wss://...,...>] <command>

Commands:
  list                 list discovered roots with derived state, anomalies, forks
  inspect <root-id>    show full reconstruction (use "latest" for the newest root)

Sources (choose one):
  --offline <file>     read events from a local JSON file
  --relay <wss://...>  comma-separated relays (default: wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net)
```

### HTTP server + web UI

```
npm run server -- [--offline <file> | --relay <wss://...>] [--port 4780] [--host 127.0.0.1]
```

Endpoints:

| Method | Path                  | Description                                  |
|--------|-----------------------|----------------------------------------------|
| GET    | `/api/health`         | server + source info                          |
| GET    | `/api/relays`         | current + default relay list                  |
| POST   | `/api/relays`         | update the active relay list (`{ relays: [...] }`) |
| GET    | `/api/swaps`          | summary list of all reconstructed swaps       |
| GET    | `/api/swaps/:id`      | full detail for one swap (`:id` may be `latest` or a prefix) |

The web UI (`/`) shows a filterable swap list and a detailed pane with the canonical action timeline, participants, derived roles, descriptor, dispute info, forks, and anomalies. Swaps are **not** fetched automatically on page load — press the **Fetch from relays** button (or `↻` / `Ctrl+R`) to query the configured relays and populate the list. The relay bar lets you add, remove, or reset relays at runtime; the active set is pushed to the server via `POST /api/relays`.

## Netlify deployment

The web UI runs entirely client-side — it bundles `src/core/` (via esbuild) and connects to Nostr relays directly from the browser using `nostr-tools`'s `SimplePool` (native `WebSocket`). No server functions are required.

```bash
npm run build:web   # bundle src/core → public/core.js
```

`netlify.toml` is configured to run `npm run build:web` and deploy `public/` as a static site. The CLI/HTTP server (`npm run server`) is unaffected and still available for local or self-hosted use.

## Scripts

| Script            | Description                                              |
|-------------------|----------------------------------------------------------|
| `npm run fixtures`| Generate 14 signed demo scenarios to `fixtures/events.json` |
| `npm run dev`     | Run the CLI via tsx                                       |
| `npm run server`  | Run the HTTP server + web UI                              |
| `npm test`        | Run the reconstruction test suite (72 assertions)         |
| `npm run lint`    | Typecheck with `tsc --noEmit`                            |
| `npm run build`   | Compile to `dist/`                                        |
| `npm run build:web` | Bundle `src/core` for browser → `public/core.js` (Netlify) |

## How it verifies events (strict)

The explorer does not trust relay-provided metadata. For every event it:

1. Validates the structure (`id`, `pubkey`, `sig`, `kind`, `created_at`, `tags`, `content`).
2. **Recomputes the event id** as `sha256(serialized)` and rejects mismatches. (The `nostr-tools` `verifyEvent` helper only checks the signature against the *claimed* `id`, so an event with a tampered payload but the original `id`/`sig` would otherwise pass.)
3. Clears `nostr-tools`' cached verification result and runs the schnorr signature check.
4. Parses content as JSON and applies the PIP-02 / `pontmore/swap@1` rules.

Only events passing all of the above can contribute to a swap's derived state.

## What the explorer enforces (PIP-02 kernel invariants)

- one immutable root and one linear, append-only action chain via `root` + `prev` references;
- exact PIP-02 content version `2` and profile `pontmore/swap@1` binding;
- signer authorization derived from the participants bound by the root (no action may add or change authority);
- no action after a terminal outcome (`settled`, `refunded`, `declined`, `cancelled`, `expired`);
- `core/secure`, `core/settle`, `core/refund` only by the bound `core/escrow` pubkey;
- no `core/authorize_settlement` before `core/secure`;
- no `core/settle` before `core/authorize_settlement` (or a dispute resolution with effect `authorize_settlement`);
- no `core/refund` before `core/authorize_refund` (or a dispute resolution with effect `authorize_refund`);
- `core/settle` and `core/refund` are mutually exclusive final economic outcomes;
- no ordinary profile progress or economic action while disputed;
- `core/resolve_dispute` only by the bound `core/resolver`;
- rejection of duplicate event IDs, replayed semantic actions, and out-of-order actions;
- **forks**: two otherwise-valid actions referencing the same predecessor freeze further economic action — no winner is selected by relay order, timestamp, or event-id order.

## What the explorer enforces (`pontmore/swap@1`)

- exactly one `swap/agent` and one `swap/customer` pubkey (different), one `core/escrow`, one `core/resolver`;
- `terms`: direction, fiat currency (ISO 4217) and decimal amount, bitcoin integer amount in `sat`, network, versioned `payment_channel`, and `deadlines` with `expires_at < fiat_pay_by < fiat_confirm_by`;
- direction-derived roles (fiat sender/receiver, bitcoin provider/recipient);
- `core/accept` by the non-proposing participant before `expires_at`;
- `core/decline` / `core/cancel` / `core/expire` per the profile's authorization table;
- `swap/fiat_sent` by the fiat sender after `core/secure` and by `fiat_pay_by`, with a `payment_reference` that is a safe opaque identifier, a `commitment:sha256:…` string, or a PIP-02 commitment object (`{"algorithm":"sha256-bytes@1","digest":"sha256:…"}`);
- `swap/fiat_confirmed` by the fiat receiver with a `payment_reference` identifying the **same** committed payment as `swap/fiat_sent` (compared by normalized digest);
- `core/authorize_settlement` by the fiat receiver who confirmed fiat;
- `core/authorize_refund` by the bitcoin provider only after `fiat_pay_by` elapsed with no valid `swap/fiat_sent`;
- dispute classes (`fiat_not_received`, `incorrect_fiat_amount`, `payment_reference_invalid`, `escrow_not_secured`, `bitcoin_not_released`, `conflicting_confirmation`, `timeout`) and resolution effects (`resume`, `authorize_settlement`, `authorize_refund`, `cancel`).

## Included demo scenarios

`npm run fixtures` builds 14 fully-signed chains covering the profile's conformance vectors:

| Scenario                        | Expected state | Notes                                              |
|---------------------------------|----------------|----------------------------------------------------|
| normal-settlement               | settled        | both directions covered (see `btc-to-fiat-direction`) |
| no-payment-refund               | refunded       | fiat_pay_by elapsed, no fiat_sent                  |
| dispute-resolved-to-settle      | settled        | open → authorize_settlement → settle               |
| dispute-resolved-to-refund      | refunded       | open → authorize_refund → refund                  |
| fork-at-fiat-sent               | secured        | two swap/fiat_sent on same predecessor → frozen    |
| unauthorized-secure             | accepted       | core/secure signed by customer (not escrow)        |
| duplicate-event                 | settled        | same event id published twice → duplicate anomaly  |
| dangling-prev                   | secured        | action references an unknown predecessor          |
| replay-accept                   | fiat_sent      | second core/accept is a replayed semantic action  |
| mismatched-payment-reference    | fiat_sent      | confirmed reference differs from sent reference  |
| expired-unaccepted              | expired        | core/expire after expires_at                       |
| declined                        | declined       | core/decline before acceptance                     |
| bad-signature                    | accepted       | core/secure with a zeroed signature → rejected    |
| btc-to-fiat-direction           | settled        | roles reversed; proposer = customer               |

Run `npm test` to assert the explorer derives the expected state for each.

## Project layout

```
src/
  core/
    types.ts        PIP-02 / swap@1 types and constants
    crypto.ts       strict event verification (id recompute + schnorr)
    tags.ts         Nostr tag helpers
    source.ts       OfflineSource (file) and RelaySource (SimplePool)
    descriptor.ts   PIP-01 (kind 30361) parser/validator
    root.ts         PIP-02 root (kind 7300) + swap@1 terms + participant binding
    action.ts       PIP-02 action (kind 7301) parser
    swapProfile.ts  swap@1 authorization table, profile actions, evidence refs
    chain.ts        append-only chain reconstruction + state machine + invariants
    reconstruct.ts  top-level: root + descriptor + actions → SwapReconstruction
  fixtures.ts       signed demo scenario generator
  cli.ts            list / inspect
  server.ts         HTTP + JSON API + static UI
  test.ts           reconstruction assertions
public/
  index.html        web UI
  style.css
  app.js
fixtures/
  events.json       generated by `npm run fixtures`
```

## Status

PIP-02 and `pontmore/swap@1` are **experimental drafts**. This explorer follows the published specifications but, like them, should be described as experimental until independent implementations and shared conformance vectors exist.

## License

MIT.
