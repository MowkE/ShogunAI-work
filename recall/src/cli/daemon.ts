#!/usr/bin/env node
// recall daemon: keeps the SQLite store and the transformer embedder warm, serves hooks/MCP over
// 127.0.0.1 HTTP, and watches transcript directories to ingest new sessions incrementally.
// Usage: node dist/cli/daemon.js            (foreground)
// Managed by: recall daemon start|stop|status

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { watch, existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, appendFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { retrieveAsync, formatContext, type Query, type Hit } from '../core/retrieve.js';
import { pickEmbedder, type Embedder } from '../core/embed.js';
import { reindex } from '../core/merge.js';
import { ingest } from '../extract/ingest.js';
import { claudeProjectsDir } from '../collectors/claude-code.js';
import { handleHook, type HookInput } from './hook-logic.js';
import { codexDirs } from '../collectors/codex.js';
import { cursorGlobalDb } from '../collectors/cursor.js';

export const DAEMON_PORT = Number(process.env.RECALL_PORT ?? 47821);
const DIR = join(homedir(), '.recall');
const PID = join(DIR, 'daemon.pid');
const LOGF = join(DIR, 'daemon.log');

function log(msg: string) { try { mkdirSync(DIR, { recursive: true }); appendFileSync(LOGF, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } }

// ---------------- client (used by hooks/CLI) ----------------

export interface DaemonHit { id: string; type: string; score: number; caveats: string[]; verified: boolean | null }

export function daemonCall<T>(path: string, body: unknown, timeoutMs = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body ?? {}));
    const req = httpRequest({ host: '127.0.0.1', port: DAEMON_PORT, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, (res) => {
      let s = ''; res.setEncoding('utf-8'); res.on('data', (d) => (s += d));
      res.on('end', () => { try { const j = JSON.parse(s); if (res.statusCode && res.statusCode >= 400) reject(new Error(j.error ?? `HTTP ${res.statusCode}`)); else resolve(j as T); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('daemon timeout')); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

export function daemonRunning(): number | null {
  try { const pid = Number(readFileSync(PID, 'utf-8').trim()); if (pid && isAlive(pid)) return pid; } catch { /* no pid */ }
  return null;
}
function isAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Spawn the daemon detached (idempotent). */
export function ensureDaemon(): boolean {
  if (daemonRunning()) return true;
  try {
    mkdirSync(DIR, { recursive: true });
    const script = fileURLToPath(new URL('./daemon.js', import.meta.url));
    const out = openSync(LOGF, 'a');
    const child = spawn(process.execPath, ['--no-warnings', script], { detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    return true;
  } catch (e) { log(`spawn failed: ${(e as Error).message}`); return false; }
}

// ---------------- server ----------------

async function serve() {
  mkdirSync(DIR, { recursive: true });
  const existing = daemonRunning();
  if (existing && existing !== process.pid) { console.error(`daemon already running (pid ${existing})`); process.exit(0); }
  writeFileSync(PID, String(process.pid));
  const store = new Store();
  const embedder: Embedder = pickEmbedder();
  const t0 = Date.now();
  if ('warm' in embedder && typeof (embedder as { warm?: () => Promise<void> }).warm === 'function') {
    try { await (embedder as { warm: () => Promise<void> }).warm(); log(`embedder ${embedder.name} warm in ${Date.now() - t0}ms`); }
    catch (e) { log(`embedder warm failed: ${(e as Error).message}`); }
  }
  let ingesting = false; const pending = new Set<string>(); let debounce: NodeJS.Timeout | null = null;

  const runIngest = async (paths?: string[]) => {
    if (ingesting) { paths?.forEach((p) => pending.add(p)); return; }
    ingesting = true;
    try { const r = await ingest(store, { paths, llm: null, embedder }); log(`ingest ${paths ? paths.length + ' files' : 'all'}: ${JSON.stringify(r)}`); }
    catch (e) { log(`ingest error: ${(e as Error).message}`); }
    finally { ingesting = false; if (pending.size) { const p = [...pending]; pending.clear(); void runIngest(p); } }
  };

  // Watch transcripts (macOS/Windows support recursive fs.watch; Linux ≥ 20 too)
  const schedule = (path?: string, delay = 15_000) => { if (path) pending.add(path); if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { const p = [...pending]; pending.clear(); void runIngest(p.length ? p : undefined); }, delay); };
  for (const dir of [claudeProjectsDir(), ...codexDirs()]) {
    if (!existsSync(dir)) continue;
    try { watch(dir, { recursive: true }, (_ev, fname) => { if (fname && String(fname).endsWith('.jsonl')) schedule(join(dir, String(fname))); }); log(`watching ${dir}`); }
    catch (e) { log(`watch failed ${dir}: ${(e as Error).message}`); }
  }
  const cdb = cursorGlobalDb();
  if (cdb) { try { watch(cdb, () => schedule(undefined, 60_000)); log(`watching ${cdb}`); } catch { /* ignore */ } }

  const json = (res: ServerResponse, code: number, body: unknown) => { const b = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  const readBody = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } }); });

  const server = createServer(async (req, res) => {
    const t = Date.now();
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, pid: process.pid, embedder: embedder.name, uptimeS: Math.round(process.uptime()), entities: store.countByType() });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = await readBody(req);
      switch (req.url) {
        case '/retrieve': {
          const q = body.query as Query;
          const hits = await retrieveAsync(store, q, embedder);
          const ctx = formatContext(hits, { maxChars: (body.maxChars as number) ?? 3500 });
          if (body.record !== false) store.recordInjection({ sessionId: q.sessionId, surface: (body.surface as string) ?? 'daemon', query: q.intent, entityIds: hits.map((h) => h.entity.id), cwd: q.cwd, latencyMs: Date.now() - t });
          return json(res, 200, { hits: hits.map(serializeHit), context: ctx, latencyMs: Date.now() - t });
        }
        case '/hook': {
          const out = await handleHook(store, embedder, String(body.event ?? ''), (body.input ?? {}) as HookInput, { onIngest: (paths) => { void runIngest(paths); } });
          log(`hook ${body.event}: ${out ? 'context' : 'silent'} in ${Date.now() - t}ms`);
          return json(res, 200, out ?? {});
        }
        case '/feedback': { store.recordFeedback(String(body.entityId), String(body.signal), body.sessionId as string | undefined, body.note as string | undefined); return json(res, 200, { ok: true }); }
        case '/ingest': { void runIngest(body.paths as string[] | undefined); return json(res, 202, { queued: true }); }
        case '/reindex': { const n = await reindex(store, embedder); return json(res, 200, { reindexed: n, embedder: embedder.name }); }
        case '/shutdown': { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 50); return; }
        default: return json(res, 404, { error: 'not found' });
      }
    } catch (e) { log(`error ${req.url}: ${(e as Error).stack ?? e}`); return json(res, 500, { error: (e as Error).message }); }
  });
  server.listen(DAEMON_PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${DAEMON_PORT} (pid ${process.pid})`));
  const bye = () => { try { if (readFileSync(PID, 'utf-8').trim() === String(process.pid)) unlinkSync(PID); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

function serializeHit(h: Hit): DaemonHit & { entity: unknown } {
  return { id: h.entity.id, type: h.entity.type, score: h.score, caveats: h.caveats, verified: h.verified, entity: { ...h.entity, embedding: undefined } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve().catch((e) => { log(`fatal: ${e?.stack ?? e}`); process.exit(1); });
}
