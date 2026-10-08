import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineSource, RelaySource, DEFAULT_RELAYS } from './core/source.js';
import { listSwaps, type ReconstructRootResult } from './core/reconstruct.js';
import type { SwapReconstruction } from './core/types.js';
import { npub } from './core/crypto.js';
import { fmtEat } from './core/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

interface ServerState {
  offline?: string;
  relays: string[];
  port: number;
  host: string;
  cache: Map<string, ReconstructRootResult>;
  cacheTime: number;
  cacheTtl: number;
}

function makeSource(state: ServerState) {
  if (state.offline) {
    const text = readFileSync(state.offline, 'utf8');
    return OfflineSource.fromFile(text);
  }
  return new RelaySource(state.relays);
}

function summary(r: SwapReconstruction) {
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

function detail(r: SwapReconstruction) {
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res: ServerResponse, status: number, body: any, type = 'application/json') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  let p = decodeURIComponent(new URL(req.url || '/', `http://x`).pathname);
  if (p === '/' || p === '') p = '/index.html';
  const fp = join(PUBLIC_DIR, p);
  if (!fp.startsWith(PUBLIC_DIR)) {
    send(res, 403, { error: 'forbidden' });
    return true;
  }
  if (!existsSync(fp) || statSync(fp).isDirectory()) return false;
  const ext = extname(fp).toLowerCase();
  send(res, 200, readFileSync(fp), MIME[ext] || 'application/octet-stream');
  return true;
}

function parseOpts(): ServerState {
  const args = process.argv.slice(2);
  let offline: string | undefined;
  const relays: string[] = [];
  let port = 4780;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--offline' || a === '-o') offline = args[++i];
    else if (a === '--relay' || a === '-r') relays.push(...(args[++i] || '').split(',').filter(Boolean));
    else if (a === '--port' || a === '-p') port = Number(args[++i]) || port;
    else if (a === '--host') host = args[++i] || host;
  }
  if (!offline && relays.length === 0) {
    relays.push(...DEFAULT_RELAYS);
  }
  return { offline, relays, port, host, cache: new Map(), cacheTime: 0, cacheTtl: 60000 } as ServerState;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, state: ServerState): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'x'}`);
  const path = url.pathname;
  const method = req.method || 'GET';
  if (!path.startsWith('/api/')) return false;

  if (path === '/api/health' && method === 'GET') {
    send(res, 200, {
      ok: true,
      source: state.offline ? 'offline' : 'relay',
      offline: state.offline ?? null,
      relays: state.relays,
      defaultRelays: DEFAULT_RELAYS,
    });
    return true;
  }

  if (path === '/api/relays' && method === 'GET') {
    send(res, 200, { relays: state.relays, defaultRelays: DEFAULT_RELAYS });
    return true;
  }

  if (path === '/api/relays' && method === 'POST') {
    if (state.offline) { send(res, 400, { error: 'cannot change relays in offline mode' }); return true; }
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { send(res, 400, { error: 'invalid JSON' }); return true; }
    const incoming = Array.isArray(parsed.relays) ? parsed.relays : undefined;
    if (!incoming) { send(res, 400, { error: 'expected { relays: [...] }' }); return true; }
    const validated = incoming
      .map((r: unknown) => String(r).trim())
      .filter((r: string) => /^wss?:\/\/.+/.test(r));
    if (validated.length === 0) { send(res, 400, { error: 'no valid wss:// relays provided' }); return true; }
    state.relays = validated;
    state.cache.clear();
    state.cacheTime = 0;
    console.log(`relays updated to: ${validated.join(', ')}`);
    send(res, 200, { relays: state.relays });
    return true;
  }

  async function ensureCache(): Promise<ReconstructRootResult[]> {
    const now = Date.now();
    if (state.cache.size > 0 && now - state.cacheTime < state.cacheTtl) {
      return [...state.cache.values()];
    }
    const source = makeSource(state);
    try {
      const results = await listSwaps(source);
      state.cache.clear();
      for (const r of results) state.cache.set(r.rootEvent.id, r);
      state.cacheTime = Date.now();
      return results;
    } finally { await source.close?.(); }
  }

  if (path === '/api/swaps' && method === 'GET') {
    try {
      const results = await ensureCache();
      const rows = results.filter((r) => r.reconstruction).map((r) => summary(r.reconstruction!));
      const invalid = results.filter((r) => !r.reconstruction).map((r) => ({ id: r.rootEvent.id, issues: r.rootIssues }));
      send(res, 200, { swaps: rows, invalidRoots: invalid, count: rows.length });
      return true;
    } catch (e: any) {
      send(res, 500, { error: e?.message || String(e) });
      return true;
    }
  }

  const m = path.match(/^\/api\/swaps\/(.+)$/);
  if (m && method === 'GET') {
    const target = decodeURIComponent(m[1]);
    try {
      const results = await ensureCache();
      const found = target === 'latest'
        ? results[0]
        : results.find((r) => r.rootEvent.id === target || r.rootEvent.id.startsWith(target));
      if (!found) { send(res, 404, { error: 'not found', target }); return true; }
      if (!found.reconstruction) { send(res, 422, { id: found.rootEvent.id, issues: found.rootIssues }); return true; }
      send(res, 200, detail(found.reconstruction));
      return true;
    } catch (e: any) {
      send(res, 500, { error: e?.message || String(e) });
      return true;
    }
  }

  send(res, 404, { error: 'unknown endpoint', path, method });
  return true;
}

async function main() {
  const state = parseOpts();
  const server = createServer(async (req, res) => {
    try {
      if (await handleApi(req, res, state)) return;
      if (serveStatic(req, res)) return;
      send(res, 404, { error: 'not found', path: req.url });
    } catch (e: any) {
      send(res, 500, { error: e?.message || String(e) });
    }
  });
  server.listen(state.port, state.host, () => {
    console.log(`pontexplorer server listening on http://${state.host}:${state.port}`);
    console.log(`  source: ${state.offline ? 'offline ' + state.offline : 'relays ' + state.relays.join(', ')}`);
    console.log(`  open http://${state.host}:${state.port} in your browser`);
  });
}

void join;
main().catch((e) => { console.error(e); process.exit(1); });
