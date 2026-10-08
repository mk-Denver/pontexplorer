import { readFileSync } from 'node:fs';
import { OfflineSource } from './core/source.js';
import { listSwaps } from './core/reconstruct.js';
import type { SwapReconstruction } from './core/types.js';

interface Expect {
  state: string;
  terminal: boolean;
  disputed?: boolean;
  forks?: number;
  anomalies?: number;
  accepted?: number;
}

const EXPECT: Record<string, Expect> = {
  'normal-settlement': { state: 'settled', terminal: true, accepted: 6, anomalies: 0 },
  'no-payment-refund': { state: 'refunded', terminal: true, accepted: 4, anomalies: 0 },
  'dispute-resolved-to-settle': { state: 'settled', terminal: true, accepted: 6, anomalies: 0, disputed: false },
  'dispute-resolved-to-refund': { state: 'refunded', terminal: true, accepted: 6, anomalies: 0 },
  'fork-at-fiat-sent': { state: 'secured', terminal: false, forks: 1, accepted: 2, anomalies: 0 },
  'unauthorized-secure': { state: 'accepted', terminal: false, anomalies: 1, accepted: 1 },
  'duplicate-event': { state: 'settled', terminal: true, accepted: 6, anomalies: 1 },
  'dangling-prev': { state: 'secured', terminal: false, anomalies: 1, accepted: 2 },
  'replay-accept': { state: 'fiat_sent', terminal: false, anomalies: 1, accepted: 3 },
  'mismatched-payment-reference': { state: 'fiat_sent', terminal: false, anomalies: 1, accepted: 3 },
  'expired-unaccepted': { state: 'expired', terminal: true, accepted: 1, anomalies: 0 },
  'declined': { state: 'declined', terminal: true, accepted: 1, anomalies: 0 },
  'bad-signature': { state: 'accepted', terminal: false, anomalies: 1, accepted: 1 },
  'btc-to-fiat-direction': { state: 'settled', terminal: true, accepted: 6, anomalies: 0 },
};

function rootScenario(r: SwapReconstruction): string | null {
  // identify by canonical action sequence signature
  const seq = r.canonical.map((a) => a.action).join(',');
  const forked = r.forks.length > 0;
  const disputeOpened = r.canonical.some((a) => a.action === 'core/open_dispute');
  const map: { key: string; seq: string; forked?: boolean; dispute?: boolean }[] = [
    { key: 'normal-settlement', seq: 'core/accept,core/secure,swap/fiat_sent,swap/fiat_confirmed,core/authorize_settlement,core/settle' },
    { key: 'no-payment-refund', seq: 'core/accept,core/secure,core/authorize_refund,core/refund' },
    { key: 'dispute-resolved-to-settle', seq: 'core/accept,core/secure,swap/fiat_sent,core/open_dispute,core/resolve_dispute,core/settle', dispute: true },
    { key: 'dispute-resolved-to-refund', seq: 'core/accept,core/secure,swap/fiat_sent,core/open_dispute,core/resolve_dispute,core/refund', dispute: true },
    { key: 'fork-at-fiat-sent', seq: 'core/accept,core/secure', forked: true },
    { key: 'unauthorized-secure', seq: 'core/accept' },
    { key: 'duplicate-event', seq: 'core/accept,core/secure,swap/fiat_sent,swap/fiat_confirmed,core/authorize_settlement,core/settle' },
    { key: 'dangling-prev', seq: 'core/accept,core/secure' },
    { key: 'replay-accept', seq: 'core/accept,core/secure,swap/fiat_sent' },
    { key: 'mismatched-payment-reference', seq: 'core/accept,core/secure,swap/fiat_sent' },
    { key: 'expired-unaccepted', seq: 'core/expire' },
    { key: 'declined', seq: 'core/decline' },
    { key: 'bad-signature', seq: 'core/accept' },
    { key: 'btc-to-fiat-direction', seq: 'core/accept,core/secure,swap/fiat_sent,swap/fiat_confirmed,core/authorize_settlement,core/settle' },
  ];
  const cands = map.filter(
    (m) => m.seq === seq && !!m.forked === forked && !!m.dispute === disputeOpened,
  );
  // disambiguate duplicate-event vs normal-settlement vs btc-to-fiat (same seq, no fork/dispute)
  if (cands.length > 1) {
    const dir = r.rootContent.terms.direction;
    const anom = r.anomalies.length;
    const pick = cands.find((m) => {
      if (m.key === 'btc-to-fiat-direction') return dir === 'btc_to_fiat';
      if (m.key === 'duplicate-event') return anom === 1;
      if (m.key === 'normal-settlement') return anom === 0 && dir === 'fiat_to_btc';
      return false;
    });
    return pick?.key ?? cands[0].key;
  }
  return cands[0]?.key ?? null;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

async function main() {
  const text = readFileSync('fixtures/events.json', 'utf8');
  const source = OfflineSource.fromFile(text);
  const results = await listSwaps(source);
  console.log(`Reconstructed ${results.length} swaps.\n`);

  for (const res of results) {
    if (!res.reconstruction) {
      fail++;
      console.log(`  FAIL  root ${res.rootEvent.id} did not parse`);
      continue;
    }
    const r = res.reconstruction;
    const key = rootScenario(r);
    if (!key) { fail++; console.log(`  FAIL  could not identify scenario for ${r.root.id} (seq=${r.canonical.map((a) => a.action).join(',')})`); continue; }
    const e = EXPECT[key];
    console.log(`[${key}]  root ${r.root.id.slice(0, 8)}…`);
    check(`${key}: state=${e.state}`, r.state === e.state, `got ${r.state}`);
    check(`${key}: terminal=${e.terminal}`, r.terminal === e.terminal, `got ${r.terminal}`);
    if (e.forks != null) check(`${key}: forks=${e.forks}`, r.forks.length === e.forks, `got ${r.forks.length}`);
    if (e.anomalies != null) check(`${key}: anomalies=${e.anomalies}`, r.anomalies.length === e.anomalies, `got ${r.anomalies.length}: ${r.anomalies.map((a) => a.kind).join(',')}`);
    if (e.accepted != null) check(`${key}: accepted=${e.accepted}`, r.acceptedCount === e.accepted, `got ${r.acceptedCount}`);
    if (e.disputed != null) check(`${key}: disputed=${e.disputed}`, r.disputed === e.disputed, `got ${r.disputed}`);
    // root always verifies + descriptor valid
    check(`${key}: descriptor valid`, !!r.descriptor && r.descriptor.valid, r.descriptor?.issues.join('; '));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
