#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { OfflineSource, RelaySource, DEFAULT_RELAYS } from './core/source.js';
import { listSwapsProgress } from './core/reconstruct.js';
import { npub, shortHex } from './core/crypto.js';
import { fmtEat } from './core/time.js';
import type { SwapReconstruction } from './core/types.js';

interface Args {
  offline?: string;
  relays: string[];
  command: 'list' | 'inspect';
  target?: string;
}

function parseArgs(argv: string[]): Args {
  const relays: string[] = [];
  let offline: string | undefined;
  let command: Args['command'] | undefined;
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline' || a === '-o') offline = argv[++i];
    else if (a === '--relay' || a === '-r') relays.push(...(argv[++i] || '').split(',').filter(Boolean));
    else if (a === 'list') command = 'list';
    else if (a === 'inspect') {
      command = 'inspect';
      target = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('--') && !command) {
      command = 'list';
    }
  }
  if (!command) command = 'list';
  if (!target && command === 'inspect') {
    console.error('inspect requires a root id (or "latest")');
    process.exit(2);
  }
  if (!offline && relays.length === 0) relays.push(...DEFAULT_RELAYS);
  return { offline, relays, command, target };
}

function printHelp() {
  console.log(`pontexplorer — read-only Pontmore swap explorer (PIP-02 + pontmore/swap@1)

Usage:
  pontexplorer [source] <command> [args]

Sources (choose one):
  --offline <file>      read events from a local JSON file (e.g. fixtures/events.json)
  --relay <wss://...>   comma-separated relays to read from (default: public set)

Commands:
  list                 list discovered pontmore/swap@1 coordination roots and derived state
  inspect <root-id>    show full reconstruction for one swap (use "latest" for the newest root)

Examples:
  npm run dev -- --offline fixtures/events.json list
  npm run dev -- --offline fixtures/events.json inspect latest
  npm run dev -- --relay wss://relay.damus.io list
`);
}

function makeSource(args: Args): any {
  if (args.offline) {
    const text = readFileSync(args.offline, 'utf8');
    return OfflineSource.fromFile(text);
  }
  return new RelaySource(args.relays);
}

function stateLabel(r: SwapReconstruction): string {
  let s: string = r.state;
  if (r.disputed && !r.terminal) s = `${s} (disputed)`;
  if (r.forks.length) s = `${s} +FORKED`;
  if (r.terminal) s = `${s} [terminal]`;
  return s;
}

function termsLabel(r: SwapReconstruction): string {
  const t = r.rootContent.terms;
  const arrow = t.direction === 'fiat_to_btc' ? '->' : '<-';
  return `${t.fiat.amount} ${t.fiat.currency} ${arrow} ${t.bitcoin.amount} ${t.bitcoin.unit}`;
}

async function cmdList(source: any) {
  const results = await listSwapsProgress(source, (msg) => process.stderr.write(`  ${msg}\r`));
  process.stderr.write(' '.repeat(80) + '\r');
  if (results.length === 0) {
    console.log('No pontmore/swap@1 coordination roots found.');
    return;
  }
  console.log(
    pad('STATE', 30) +
    pad('TERMS', 24) +
    pad('#ACT', 5) +
    pad('ANOM', 5) +
    pad('FORK', 5) +
    pad('CREATED (EAT)', 20) +
    'ROOT ID',
  );
  console.log('-'.repeat(130));
  for (const res of results) {
    if (!res.reconstruction) {
      console.log(`${pad('INVALID ROOT', 30)}${''.padEnd(24)}${''.padEnd(5)}${''.padEnd(5)}${''.padEnd(5)}${''.padEnd(20)}${res.rootEvent.id}`);
      continue;
    }
    const r = res.reconstruction;
    console.log(
      pad(stateLabel(r), 30) +
      pad(termsLabel(r), 24) +
      pad(String(r.acceptedCount), 5) +
      pad(String(r.anomalies.length), 5) +
      pad(String(r.forks.length), 5) +
      pad(fmtEat(r.root.created_at), 20) +
      r.root.id,
    );
  }
  console.log(`\n${results.length} swap(s). Use "inspect <root-id>" for details.`);
}

async function cmdInspect(source: any, target: string) {
  const results = await listSwapsProgress(source, (msg) => process.stderr.write(`  ${msg}\r`));
  process.stderr.write(' '.repeat(80) + '\r');
  const found = target === 'latest'
    ? results[0]
    : results.find((r) => r.rootEvent.id === target || r.rootEvent.id.startsWith(target));
  if (!found) {
    console.error(`No root found for "${target}".`);
    process.exit(1);
  }
  if (!found.reconstruction) {
    console.log(`Root ${found.rootEvent.id} is not a valid pontmore/swap@1 coordination root:`);
    for (const i of found.rootIssues) console.log(`  - ${i}`);
    return;
  }
  printReconstruction(found.reconstruction);
}

function printReconstruction(r: SwapReconstruction) {
  const t = r.rootContent.terms;
  console.log(`\n=== Swap ${r.root.id} ===`);
  console.log(`created_at : ${fmtEat(r.root.created_at)}  (${r.root.created_at})`);
  console.log(`state      : ${stateLabel(r)}`);
  console.log(`terminal   : ${r.terminal}   disputed: ${r.disputed}   forks: ${r.forks.length}`);
  console.log(`profile    : ${r.rootContent.profile}   expires_at: ${r.rootContent.expires_at}`);
  console.log(`direction  : ${t.direction}`);
  console.log(`terms      : ${t.fiat.amount} ${t.fiat.currency}  <->  ${t.bitcoin.amount} ${t.bitcoin.unit} on ${t.bitcoin.network}`);
  console.log(`channel    : ${t.payment_channel}`);
  console.log(`deadlines  : fiat_pay_by=${t.deadlines.fiat_pay_by}  fiat_confirm_by=${t.deadlines.fiat_confirm_by}`);

  console.log('\nParticipants:');
  console.log(`  swap/agent     : ${npub(r.participants.agent)}`);
  console.log(`  swap/customer  : ${npub(r.participants.customer)}`);
  console.log(`  core/escrow    : ${npub(r.participants.escrow)}`);
  if (r.participants.resolver) console.log(`  core/resolver  : ${npub(r.participants.resolver)}`);
  console.log(`  proposer       : ${npub(r.participants.proposer)}  (accepter: ${npub(r.participants.accepter)})`);

  const d = r.derived;
  console.log('\nDirection-derived roles:');
  console.log(`  fiat sender/receiver : ${d.fiatSender} / ${d.fiatReceiver}`);
  console.log(`  bitcoin provider/recipient : ${d.bitcoinProvider} / ${d.bitcoinRecipient}`);

  if (r.descriptor) {
    console.log('\nPIP-01 escrow descriptor:');
    console.log(`  valid: ${r.descriptor.valid}`);
    const c = JSON.parse(r.descriptor.event.content);
    console.log(`  escrow_type: ${c.escrow_type}  networks: ${JSON.stringify(c.networks)}  expires_at: ${c.expires_at}`);
    if (r.descriptor.issues.length) for (const i of r.descriptor.issues) console.log(`  - ${i}`);
  } else {
    console.log('\nPIP-01 escrow descriptor: not found');
  }

  console.log(`\nCanonical action chain (${r.canonical.length}):`);
  if (r.canonical.length === 0) console.log('  (no accepted actions)');
  for (let i = 0; i < r.canonical.length; i++) {
    const a = r.canonical[i];
    console.log(`  ${String(i + 1).padStart(2)}. ${a.action.padEnd(28)} by ${shortHex(a.signer)}  ${fmtEat(a.created_at)}  ${shortHex(a.id)}`);
    if (a.data && Object.keys(a.data).length) console.log(`        data: ${JSON.stringify(a.data)}`);
  }

  if (r.dispute) {
    console.log('\nDispute:');
    console.log(`  opened by ${shortHex(r.dispute.openedBy)} ${fmtEat(r.dispute.openedAt)} class=${r.dispute.class ?? '(none)'}`);
    if (r.dispute.resolvedBy) {
      console.log(`  resolved by ${shortHex(r.dispute.resolvedBy)} ${fmtEat(r.dispute.resolvedAt!)} effect=${r.dispute.effect} policy=${r.dispute.policy}`);
    }
  }

  if (r.forks.length) {
    console.log('\nFORKS (economic action frozen):');
    for (const f of r.forks) {
      console.log(`  at predecessor ${shortHex(f.atPrev)}:`);
      for (const e of f.actions) {
        const c = JSON.parse(e.content);
        console.log(`    - ${c.action} by ${shortHex(e.pubkey)}  ${shortHex(e.id)}`);
      }
    }
  }

  if (r.anomalies.length) {
    console.log('\nAnomalies / rejected actions:');
    for (const a of r.anomalies) {
      console.log(`  [${a.kind}] ${a.message}${a.eventId ? '  ' + shortHex(a.eventId) : ''}`);
    }
  } else {
    console.log('\nNo anomalies detected.');
  }
  console.log('');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = makeSource(args);
  try {
    if (args.command === 'list') await cmdList(source);
    else await cmdInspect(source, args.target!);
  } finally {
    await source.close?.();
  }
}

main().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
