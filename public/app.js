import { RelaySource, DEFAULT_RELAYS, listSwaps, npub, fmtEat } from './core.js';

const $ = (s) => document.querySelector(s);
const rowsEl = $('#swap-rows');
const statusEl = $('#status');
const detailEl = $('#detail-pane');
const filterEl = $('#filter');
const sourceEl = $('#source-info');
const relayChipsEl = $('#relay-chips');
const relayInput = $('#relay-input');
const relayAddBtn = $('#relay-add-btn');
const relayResetBtn = $('#relay-reset');
const fetchBtn = $('#fetch-relays');

let allSwaps = [];
let allResults = [];
let selectedId = null;
let currentRelays = [];
let defaultRelays = [...DEFAULT_RELAYS];

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function short(h, n = 8) { return h && h.length > n * 2 + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h; }
function fmtTerms(s) {
  const t = s.terms;
  const arrow = s.direction === 'fiat_to_btc' ? '→' : '←';
  return `${t.fiat.amount} ${t.fiat.currency} ${arrow} ${t.bitcoin.amount} ${t.bitcoin.unit}`;
}

function stateBadges(s) {
  const out = [];
  const cls = s.terminal
    ? (s.state === 'settled' ? 'badge terminal-green' : 'badge terminal-red')
    : (s.disputed ? 'badge disputed' : (s.forks ? 'badge forked' : 'badge live'));
  out.push(`<span class="${cls}">${esc(s.state)}${s.disputed && !s.terminal ? ' ⚠' : ''}</span>`);
  if (s.terminal) out.push(`<span class="badge">terminal</span>`);
  if (s.forks) out.push(`<span class="badge forked">fork</span>`);
  return out.join(' ');
}

/* ── data: summary + detail (ported from server.ts) ── */

function summary(r) {
  const t = r.rootContent.terms;
  return {
    id: r.root.id,
    created_at: r.root.created_at,
    created_at_eat: fmtEat(r.root.created_at),
    state: r.state,
    terminal: r.terminal,
    disputed: r.disputed,
    forks: r.forks.length,
    anomalies: r.anomalies.length,
    accepted: r.acceptedCount,
    direction: t.direction,
    terms: {
      fiat: t.fiat,
      bitcoin: t.bitcoin,
      payment_channel: t.payment_channel,
    },
    proposer: npub(r.participants.proposer),
  };
}

function detail(r) {
  return {
    id: r.root.id,
    created_at: r.root.created_at,
    created_at_eat: fmtEat(r.root.created_at),
    state: r.state,
    preDisputeState: r.preDisputeState,
    terminal: r.terminal,
    disputed: r.disputed,
    profile: r.rootContent.profile,
    expires_at: r.rootContent.expires_at,
    expires_at_eat: fmtEat(r.rootContent.expires_at),
    terms: r.rootContent.terms,
    participants: {
      'swap/agent': npub(r.participants.agent),
      'swap/customer': npub(r.participants.customer),
      'core/escrow': npub(r.participants.escrow),
      'core/resolver': r.participants.resolver ? npub(r.participants.resolver) : null,
      proposer: npub(r.participants.proposer),
      accepter: npub(r.participants.accepter),
    },
    participantPubkeys: {
      'swap/agent': r.participants.agent,
      'swap/customer': r.participants.customer,
      'core/escrow': r.participants.escrow,
      'core/resolver': r.participants.resolver ?? null,
      proposer: r.participants.proposer,
      accepter: r.participants.accepter,
    },
    derived: r.derived,
    descriptor: r.descriptor
      ? {
          valid: r.descriptor.valid,
          issues: r.descriptor.issues,
          content: JSON.parse(r.descriptor.event.content),
          id: r.descriptor.event.id,
          created_at: r.descriptor.event.created_at,
          created_at_eat: fmtEat(r.descriptor.event.created_at),
          pubkey: r.descriptor.event.pubkey,
        }
      : null,
    canonical: r.canonical.map((a, i) => ({
      index: i + 1,
      action: a.action,
      signer: a.signer,
      signerNpub: npub(a.signer),
      created_at: a.created_at,
      created_at_eat: fmtEat(a.created_at),
      id: a.id,
      data: a.data ?? null,
    })),
    forks: r.forks.map((f) => ({
      atPrev: f.atPrev,
      actions: f.actions.map((e) => {
        const c = JSON.parse(e.content);
        return { id: e.id, action: c.action, signer: e.pubkey, signerNpub: npub(e.pubkey), created_at: e.created_at, created_at_eat: fmtEat(e.created_at) };
      }),
    })),
    anomalies: r.anomalies,
    dispute: r.dispute
      ? {
          openedAt: r.dispute.openedAt,
          openedAt_eat: fmtEat(r.dispute.openedAt),
          openedBy: r.dispute.openedBy,
          openedByNpub: npub(r.dispute.openedBy),
          class: r.dispute.class ?? null,
          openedActionId: r.dispute.openedActionId,
          resolvedAt: r.dispute.resolvedAt ?? null,
          resolvedAt_eat: r.dispute.resolvedAt ? fmtEat(r.dispute.resolvedAt) : null,
          resolvedBy: r.dispute.resolvedBy ?? null,
          resolvedByNpub: r.dispute.resolvedBy ? npub(r.dispute.resolvedBy) : null,
          resolvedActionId: r.dispute.resolvedActionId ?? null,
          effect: r.dispute.effect ?? null,
          policy: r.dispute.policy ?? null,
        }
      : null,
  };
}

/* ── relay management (localStorage only, no server) ── */

function renderRelayChips() {
  const defSet = new Set(defaultRelays);
  relayChipsEl.innerHTML = currentRelays.map((r) => {
    const isDef = defSet.has(r);
    return `<span class="relay-chip ${isDef ? 'default' : ''}">
      ${esc(r)}
      ${currentRelays.length > 1 ? `<button class="remove" data-relay="${esc(r)}" title="remove">×</button>` : ''}
    </span>`;
  }).join('');
  relayChipsEl.querySelectorAll('.remove').forEach((b) =>
    b.addEventListener('click', () => removeRelay(b.dataset.relay)),
  );
}

function loadRelays() {
  defaultRelays = [...DEFAULT_RELAYS];
  const stored = localStorage.getItem('pontexplorer_relays');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length) {
        currentRelays = parsed;
      } else {
        currentRelays = [...defaultRelays];
      }
    } catch {
      currentRelays = [...defaultRelays];
    }
  } else {
    currentRelays = [...defaultRelays];
  }
  renderRelayChips();
  updateSourceInfo();
}

function saveRelays() {
  localStorage.setItem('pontexplorer_relays', JSON.stringify(currentRelays));
}

function addRelay() {
  const val = relayInput.value.trim();
  if (!val) return;
  if (!/^wss?:\/\/.+/.test(val)) { relayInput.style.borderColor = 'var(--red)'; return; }
  relayInput.style.borderColor = '';
  if (currentRelays.includes(val)) { relayInput.value = ''; return; }
  currentRelays.push(val);
  saveRelays();
  renderRelayChips();
  relayInput.value = '';
}

function removeRelay(r) {
  if (currentRelays.length <= 1) return;
  currentRelays = currentRelays.filter((x) => x !== r);
  saveRelays();
  renderRelayChips();
}

function resetRelays() {
  currentRelays = [...defaultRelays];
  localStorage.removeItem('pontexplorer_relays');
  renderRelayChips();
}

relayAddBtn.addEventListener('click', addRelay);
relayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRelay(); });
relayResetBtn.addEventListener('click', resetRelays);

/* ── swap list ── */

async function loadList() {
  statusEl.textContent = 'fetching swaps…';
  const source = new RelaySource(currentRelays);
  try {
    const results = await listSwaps(source);
    allResults = results;
    allSwaps = results.filter((r) => r.reconstruction).map((r) => summary(r.reconstruction));
    const invalidCount = results.filter((r) => !r.reconstruction).length;
    statusEl.textContent = `${allSwaps.length} swap(s)${invalidCount ? ` · ${invalidCount} invalid root(s)` : ''}`;
    renderRows();
  } catch (e) {
    statusEl.textContent = 'error: ' + e.message;
  } finally {
    await source.close?.();
  }
}

function renderRows() {
  const f = filterEl.value.trim().toLowerCase();
  const rows = allSwaps.filter((s) => {
    if (!f) return true;
    return (s.state + ' ' + s.id + ' ' + s.proposer + ' ' + s.terms.fiat.currency).toLowerCase().includes(f);
  });
  rowsEl.innerHTML = rows.map((s) => `
    <tr data-id="${esc(s.id)}" class="${s.id === selectedId ? 'selected' : ''}">
      <td>${stateBadges(s)}</td>
      <td class="mono">${esc(fmtTerms(s))}</td>
      <td class="num">${s.accepted}</td>
      <td class="num">${s.anomalies}</td>
      <td class="num">${s.forks}</td>
      <td class="eat">${esc(s.created_at_eat || '')}</td>
      <td class="root-id">${esc(short(s.id, 6))}</td>
    </tr>`).join('');
  rowsEl.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => select(tr.dataset.id)));
}

/* ── swap detail ── */

function select(id) {
  selectedId = id;
  renderRows();
  const found = allResults.find((r) => r.rootEvent.id === id || r.rootEvent.id.startsWith(id));
  if (!found) { detailEl.innerHTML = `<div class="placeholder">not found: ${esc(short(id, 8))}</div>`; return; }
  if (!found.reconstruction) { detailEl.innerHTML = `<div class="placeholder">invalid root: ${esc(found.rootIssues.join('; '))}</div>`; return; }
  renderDetail(detail(found.reconstruction));
}

function renderDetail(d) {
  const t = d.terms;
  const parts = [];
  parts.push(`<div class="detail-body">`);
  parts.push(`<div class="state-row">${stateBadges(d)}</div>`);
  parts.push(`<h2>Coordination root</h2>`);
  parts.push(kv('root id', d.id, true));
  parts.push(kv('created (EAT)', d.created_at_eat));
  parts.push(kv('profile', d.profile));
  parts.push(kv('expires (EAT)', `${d.expires_at_eat}  (${d.expires_at})`));
  parts.push(kv('direction', d.direction));
  parts.push(kv('terms', `${t.fiat.amount} ${t.fiat.currency} ↔ ${t.bitcoin.amount} ${t.bitcoin.unit} on ${t.bitcoin.network}`));
  parts.push(kv('payment_channel', t.payment_channel));
  parts.push(kv('deadlines', `fiat_pay_by=${fmtEat(t.deadlines.fiat_pay_by)}<br>fiat_confirm_by=${fmtEat(t.deadlines.fiat_confirm_by)}`));

  parts.push(`<h2>Participants</h2>`);
  for (const [role, npub2] of Object.entries(d.participants)) {
    parts.push(kv(role, npub2 + (d.participantPubkeys[role] ? '  ·  ' + short(d.participantPubkeys[role]) : ''), true));
  }
  parts.push(`<h2>Direction-derived roles</h2>`);
  parts.push(kv('fiat sender', d.derived.fiatSender));
  parts.push(kv('fiat receiver', d.derived.fiatReceiver));
  parts.push(kv('bitcoin provider', d.derived.bitcoinProvider));
  parts.push(kv('bitcoin recipient', d.derived.bitcoinRecipient));

  parts.push(`<h2>PIP-01 escrow descriptor</h2>`);
  if (d.descriptor) {
    parts.push(kv('valid', d.descriptor.valid ? 'yes ✓' : 'no ✗', false, d.descriptor.valid ? 'desc-ok' : 'desc-bad'));
    parts.push(kv('descriptor id', d.descriptor.id, true));
    parts.push(kv('created (EAT)', d.descriptor.created_at_eat));
    parts.push(kv('escrow_type', d.descriptor.content.escrow_type));
    parts.push(kv('networks', d.descriptor.content.networks.join(', ')));
    parts.push(kv('expires_at', d.descriptor.content.expires_at + ' (' + fmtEat(d.descriptor.content.expires_at) + ')'));
    if (d.descriptor.issues?.length) parts.push(`<div class="anomaly">${d.descriptor.issues.map(esc).join('<br>')}</div>`);
  } else {
    parts.push(`<div class="empty">not found</div>`);
  }

  parts.push(`<h2>Canonical action chain (${d.canonical.length})</h2>`);
  if (!d.canonical.length) parts.push(`<div class="empty">no accepted actions</div>`);
  parts.push(`<ul class="timeline">`);
  for (const a of d.canonical) {
    const term = ['core/settle', 'core/refund', 'core/cancel', 'core/expire', 'core/decline'].includes(a.action);
    const disp = a.action === 'core/open_dispute' || a.action === 'core/resolve_dispute';
    parts.push(`<li class="${term ? 'terminal-step' : ''}${disp ? ' dispute-step' : ''}">
      <div class="act">${esc(a.action)}</div>
      <div class="meta">by ${esc(short(a.signer))} · ${esc(a.signerNpub)} · ${esc(a.created_at_eat)} · ${esc(short(a.id, 6))}</div>
      ${a.data ? `<div class="data">${esc(JSON.stringify(a.data))}</div>` : ''}
    </li>`);
  }
  parts.push(`</ul>`);

  if (d.dispute) {
    parts.push(`<h2>Dispute</h2>`);
    parts.push(kv('opened by', d.dispute.openedByNpub + ' · ' + short(d.dispute.openedBy), true));
    parts.push(kv('opened (EAT)', d.dispute.openedAt_eat));
    parts.push(kv('class', d.dispute.class ?? '(none)'));
    if (d.dispute.resolvedBy) {
      parts.push(kv('resolved by', d.dispute.resolvedByNpub + ' · ' + short(d.dispute.resolvedBy), true));
      parts.push(kv('resolved (EAT)', d.dispute.resolvedAt_eat));
      parts.push(kv('effect', d.dispute.effect));
      parts.push(kv('policy', d.dispute.policy));
    }
  }

  if (d.forks?.length) {
    parts.push(`<h2>Forks (${d.forks.length}) — economic action frozen</h2>`);
    for (const f of d.forks) {
      parts.push(`<div class="fork"><div>at predecessor ${esc(short(f.atPrev, 10))}</div>`);
      for (const b of f.actions) parts.push(`<div class="branch">↳ ${esc(b.action)} by ${esc(short(b.signer))} · ${esc(b.created_at_eat)} · ${esc(short(b.id, 6))}</div>`);
      parts.push(`</div>`);
    }
  }

  if (d.anomalies?.length) {
    parts.push(`<h2>Anomalies / rejected actions (${d.anomalies.length})</h2>`);
    for (const a of d.anomalies) parts.push(`<div class="anomaly">[${esc(a.kind)}] ${esc(a.message)}${a.eventId ? ' · ' + esc(short(a.eventId, 6)) : ''}</div>`);
  } else if (!d.forks?.length) {
    parts.push(`<h2>Anomalies</h2><div class="empty">none detected</div>`);
  }

  parts.push(`</div>`);
  detailEl.innerHTML = parts.join('\n');
}

function kv(k, v, mono, cls) {
  return `<div class="kv"><div class="k">${esc(k)}</div><div class="v ${cls || ''}">${v}</div></div>`;
}

function updateSourceInfo() {
  sourceEl.textContent = currentRelays.length + ' relay(s): ' + currentRelays.join(', ');
}

filterEl.addEventListener('input', renderRows);
$('#refresh').addEventListener('click', loadList);
fetchBtn.addEventListener('click', loadList);
document.addEventListener('keydown', (e) => { if (e.key === 'r' && e.ctrlKey) { e.preventDefault(); loadList(); } });

/* ── init ── */
loadRelays();
statusEl.textContent = 'Click "Fetch from relays" to load swaps from ' + currentRelays.length + ' relay(s).';