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

let allSwaps = [];
let selectedId = null;
let currentRelays = [];
let defaultRelays = [];

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

/* ── relay management ── */

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

async function loadRelays() {
  try {
    const r = await fetch('/api/relays');
    const d = await r.json();
    defaultRelays = d.defaultRelays || [];
    const stored = localStorage.getItem('pontexplorer_relays');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length) {
          currentRelays = parsed;
          await pushRelaysToServer(parsed);
        } else {
          currentRelays = d.relays || [...defaultRelays];
        }
      } catch {
        currentRelays = d.relays || [...defaultRelays];
      }
    } else {
      currentRelays = d.relays || [...defaultRelays];
    }
    renderRelayChips();
    updateSourceInfo();
  } catch { currentRelays = []; }
}

async function pushRelaysToServer(relays) {
  try {
    await fetch('/api/relays', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relays }),
    });
  } catch {}
}

function saveRelays() {
  localStorage.setItem('pontexplorer_relays', JSON.stringify(currentRelays));
}

async function addRelay() {
  const val = relayInput.value.trim();
  if (!val) return;
  if (!/^wss?:\/\/.+/.test(val)) { relayInput.style.borderColor = 'var(--red)'; return; }
  relayInput.style.borderColor = '';
  if (currentRelays.includes(val)) { relayInput.value = ''; return; }
  currentRelays.push(val);
  saveRelays();
  renderRelayChips();
  relayInput.value = '';
  await pushRelaysToServer(currentRelays);
  loadList();
}

async function removeRelay(r) {
  if (currentRelays.length <= 1) return;
  currentRelays = currentRelays.filter((x) => x !== r);
  saveRelays();
  renderRelayChips();
  await pushRelaysToServer(currentRelays);
  loadList();
}

async function resetRelays() {
  currentRelays = [...defaultRelays];
  localStorage.removeItem('pontexplorer_relays');
  renderRelayChips();
  await pushRelaysToServer(currentRelays);
  loadList();
}

relayAddBtn.addEventListener('click', addRelay);
relayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRelay(); });
relayResetBtn.addEventListener('click', resetRelays);

/* ── swap list ── */

async function loadList() {
  statusEl.textContent = 'fetching swaps…';
  try {
    const res = await fetch('/api/swaps');
    const data = await res.json();
    allSwaps = data.swaps || [];
    statusEl.textContent = `${allSwaps.length} swap(s)${data.invalidRoots?.length ? ` · ${data.invalidRoots.length} invalid root(s)` : ''}`;
    renderRows();
  } catch (e) {
    statusEl.textContent = 'error: ' + e.message;
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

async function select(id) {
  selectedId = id;
  renderRows();
  detailEl.innerHTML = `<div class="placeholder">loading ${esc(short(id, 8))}…</div>`;
  try {
    const res = await fetch('/api/swaps/' + encodeURIComponent(id));
    const d = await res.json();
    if (!res.ok) { detailEl.innerHTML = `<div class="placeholder">Error: ${esc(d.error || res.status)}</div>`; return; }
    renderDetail(d);
  } catch (e) {
    detailEl.innerHTML = `<div class="placeholder">Error: ${esc(e.message)}</div>`;
  }
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
  parts.push(kv('deadlines', `fiat_pay_by=${fmtEAT(t.deadlines.fiat_pay_by)}<br>fiat_confirm_by=${fmtEAT(t.deadlines.fiat_confirm_by)}`));

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
    parts.push(kv('expires_at', d.descriptor.content.expires_at + ' (' + fmtEAT(d.descriptor.content.expires_at) + ')'));
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

/* ── EAT helper (client-side, mirrors server fmtEat) ── */
function fmtEAT(unixTs) {
  if (unixTs == null) return '';
  const d = new Date((unixTs + 3 * 3600) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s} EAT`;
}

function updateSourceInfo() {
  sourceEl.textContent = currentRelays.length + ' relay(s): ' + currentRelays.join(', ');
}

const fetchBtn = $('#fetch-relays');

filterEl.addEventListener('input', renderRows);
$('#refresh').addEventListener('click', loadList);
fetchBtn.addEventListener('click', loadList);
document.addEventListener('keydown', (e) => { if (e.key === 'r' && e.ctrlKey) { e.preventDefault(); loadList(); } });

/* ── init ── */
await loadRelays();
statusEl.textContent = 'Click "Fetch from relays" to load swaps from ' + currentRelays.length + ' relay(s).';
