#!/usr/bin/env node
// Recall Team Server (alpha): a shared knowledge base that clients push promoted entities to and pull from.
// Zero-dependency (node:http + the same SQLite Store). Auth: bearer API keys (RECALL_TEAM_KEYS=key1,key2 or --keys).
// Entities are keyed by id; server-side merge = max evidence, union provenance, keep newest fields. Only scope 'team' is stored.
// Run: recall team-server --port 47900 --db ~/.recall/team.db --keys <key>[,<key>]
// Postgres/pgvector and RLS come later; the API is the contract.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from '../core/store.js';
import type { Entity } from '../core/schema.js';

export interface TeamServerOptions { port: number; dbPath: string; keys: string[]; host?: string }

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } }); });
}
function json(res: ServerResponse, code: number, body: unknown) { const b = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); }

/** Merge an incoming team entity into the server store (idempotent). */
export function mergeTeamEntity(store: Store, incoming: Entity, author?: string): 'inserted' | 'merged' {
  const e: Entity = { ...incoming, scope: 'team' };
  if (!e.provenance.some((p) => p.author) && author) e.provenance = e.provenance.map((p) => ({ ...p, author }));
  const cur = store.getEntity(e.id);
  if (!cur) { store.upsertEntity(e); return 'inserted'; }
  const seen = new Set(cur.provenance.map((p) => `${p.source}|${p.sessionId ?? ''}|${p.commit ?? ''}|${p.prNumber ?? ''}|${p.segmentId ?? ''}`));
  for (const p of e.provenance) { const k = `${p.source}|${p.sessionId ?? ''}|${p.commit ?? ''}|${p.prNumber ?? ''}|${p.segmentId ?? ''}`; if (!seen.has(k)) { cur.provenance.push(p); seen.add(k); } }
  cur.validity.evidence = Math.max(cur.validity.evidence, e.validity.evidence, cur.provenance.length);
  cur.validity.confidence = Math.max(cur.validity.confidence, e.validity.confidence);
  cur.validity.lastConfirmed = cur.validity.lastConfirmed > e.validity.lastConfirmed ? cur.validity.lastConfirmed : e.validity.lastConfirmed;
  cur.validity.usefulness = (cur.validity.usefulness + e.validity.usefulness) / 2;
  cur.paths = [...new Set([...cur.paths, ...e.paths])];
  cur.repo = cur.repo ?? e.repo;
  // newest text/fields win when the incoming one is newer
  if (e.validity.lastConfirmed >= cur.validity.lastConfirmed) { const keep = cur.validity; const prov = cur.provenance; Object.assign(cur, e); cur.validity = keep; cur.provenance = prov; cur.scope = 'team'; }
  store.upsertEntity(cur);
  return 'merged';
}

export function startTeamServer(opts: TeamServerOptions) {
  const store = new Store(opts.dbPath);
  const keys = new Set(opts.keys.filter(Boolean));
  const authed = (req: IncomingMessage) => { const h = req.headers.authorization ?? ''; const k = h.replace(/^Bearer\s+/i, '').trim(); return keys.size === 0 ? 'anonymous' : (keys.has(k) ? k.slice(0, 6) : null); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1/health') return json(res, 200, { ok: true, entities: store.countByType(), db: opts.dbPath });
      const who = authed(req);
      if (!who) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/v1/push') {
        const body = await readBody(req);
        const ents = Array.isArray(body.entities) ? (body.entities as Entity[]) : [];
        let inserted = 0, merged = 0;
        for (const e of ents) { if (!e?.id || !e.type) continue; if (e.sensitivity === 'restricted') continue; const r = mergeTeamEntity(store, e, body.author as string | undefined); if (r === 'inserted') inserted++; else merged++; }
        return json(res, 200, { inserted, merged });
      }
      if (req.method === 'GET' && url.pathname === '/v1/pull') {
        const since = url.searchParams.get('since') ?? undefined; const repo = url.searchParams.get('repo') ?? undefined;
        let ents = store.allEntities({ scope: 'team', updatedSince: since });
        if (repo) ents = ents.filter((e) => !e.repo || e.repo === repo || e.projectPath === '');
        return json(res, 200, { entities: ents.map((e) => ({ ...e, embedding: undefined })), serverTime: new Date().toISOString() });
      }
      if (req.method === 'POST' && url.pathname === '/v1/feedback') {
        const body = await readBody(req);
        store.recordFeedback(String(body.entityId), String(body.signal), undefined, body.note as string | undefined);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/v1/stats') return json(res, 200, { entities: store.countByType(), feedback: store.injectionStats() });
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 500, { error: (e as Error).message }); }
  });
  server.listen(opts.port, opts.host ?? '0.0.0.0', () => console.error(`recall team-server listening on ${opts.host ?? '0.0.0.0'}:${opts.port} · db ${opts.dbPath} · ${keys.size ? keys.size + ' keys' : 'NO AUTH (dev only)'}`));
  return server;
}
