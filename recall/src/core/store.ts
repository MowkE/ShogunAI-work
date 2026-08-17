import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Entity, EntityType } from './schema.js';

export function defaultDbPath(): string {
  return process.env.RECALL_DB ?? join(homedir(), '.recall', 'recall.db');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  project_path TEXT NOT NULL,
  text TEXT NOT NULL,
  json TEXT NOT NULL,
  embedding BLOB,
  evidence INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.5,
  usefulness REAL NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_confirmed TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_path);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(id UNINDEXED, type UNINDEXED, text, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS file_index (
  path TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (path, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_file_index_entity ON file_index(entity_id);
CREATE TABLE IF NOT EXISTS ingest_cursor (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  agent TEXT NOT NULL,
  started_at TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  outcome TEXT NOT NULL,
  files_read TEXT NOT NULL,
  files_mutated TEXT NOT NULL,
  n_events INTEGER NOT NULL,
  extractor TEXT NOT NULL,          -- 'heuristic' | 'llm' | 'both'
  cost_usd REAL NOT NULL DEFAULT 0,
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  surface TEXT NOT NULL,            -- 'hook:prompt' | 'hook:session-start' | 'mcp' | 'cli'
  query TEXT NOT NULL,
  entity_ids TEXT NOT NULL,         -- JSON array
  cwd TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  session_id TEXT,
  signal TEXT NOT NULL,             -- 'used' | 'ignored' | 'useful' | 'not_useful' | 'wrong'
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_entity ON feedback(entity_id);
`;

export interface EntityRow {
  id: string; type: EntityType; scope: string; sensitivity: string; project_path: string; text: string;
  json: string; embedding: Uint8Array | null; evidence: number; confidence: number; usefulness: number;
  first_seen: string; last_confirmed: string; updated_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA_SQL);
  }

  close() { this.db.close(); }

  static exists(path: string = defaultDbPath()) { return existsSync(path); }

  // ---------- entities ----------

  upsertEntity(e: Entity) {
    const now = new Date().toISOString();
    const emb = e.embedding ? Buffer.from(new Float32Array(e.embedding).buffer) : null;
    const existing = this.db.prepare('SELECT id FROM entities WHERE id = ?').get(e.id) as { id: string } | undefined;
    this.db.prepare(`
      INSERT INTO entities (id,type,scope,sensitivity,project_path,text,json,embedding,evidence,confidence,usefulness,first_seen,last_confirmed,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type, scope=excluded.scope, sensitivity=excluded.sensitivity,
        project_path=excluded.project_path, text=excluded.text, json=excluded.json, embedding=excluded.embedding,
        evidence=excluded.evidence, confidence=excluded.confidence, usefulness=excluded.usefulness,
        last_confirmed=excluded.last_confirmed, updated_at=excluded.updated_at
    `).run(e.id, e.type, e.scope, e.sensitivity, e.projectPath, e.text, JSON.stringify(e), emb,
      e.validity.evidence, e.validity.confidence, e.validity.usefulness, e.validity.firstSeen, e.validity.lastConfirmed, now);
    if (existing) this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(e.id);
    this.db.prepare('INSERT INTO entities_fts (id,type,text) VALUES (?,?,?)').run(e.id, e.type, e.text);
    this.db.prepare('DELETE FROM file_index WHERE entity_id = ?').run(e.id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO file_index (path, entity_id) VALUES (?,?)');
    for (const p of new Set(e.paths)) ins.run(p, e.id);
  }

  getEntity(id: string): Entity | undefined {
    const r = this.db.prepare('SELECT json, embedding FROM entities WHERE id = ?').get(id) as { json: string; embedding: Uint8Array | null } | undefined;
    if (!r) return undefined;
    return rowToEntity(r);
  }

  deleteEntity(id: string) {
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM file_index WHERE entity_id = ?').run(id);
  }

  allEntities(filter: { type?: EntityType; projectPath?: string } = {}): Entity[] {
    const where: string[] = []; const args: (string)[] = [];
    if (filter.type) { where.push('type = ?'); args.push(filter.type); }
    if (filter.projectPath !== undefined) { where.push("(project_path = ? OR project_path = '')"); args.push(filter.projectPath); }
    const sql = `SELECT json, embedding FROM entities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    return (this.db.prepare(sql).all(...args) as { json: string; embedding: Uint8Array | null }[]).map(rowToEntity);
  }

  countByType(): Record<string, number> {
    const rows = this.db.prepare('SELECT type, COUNT(*) n FROM entities GROUP BY type').all() as { type: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /** FTS5 BM25 candidates. Returns id -> bm25 (lower is better) */
  ftsSearch(query: string, limit = 50, type?: EntityType): { id: string; bm25: number }[] {
    const q = toFtsQuery(query);
    if (!q) return [];
    try {
      const rows = this.db.prepare(
        `SELECT id, bm25(entities_fts) AS s FROM entities_fts WHERE entities_fts MATCH ? ${type ? 'AND type = ?' : ''} ORDER BY s LIMIT ?`,
      ).all(...(type ? [q, type, limit] : [q, limit])) as { id: string; s: number }[];
      return rows.map((r) => ({ id: r.id, bm25: r.s }));
    } catch { return []; }
  }

  entitiesForPaths(paths: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!paths.length) return out;
    const stmt = this.db.prepare('SELECT entity_id FROM file_index WHERE path = ?');
    for (const p of paths) for (const r of stmt.all(p) as { entity_id: string }[]) out.set(r.entity_id, (out.get(r.entity_id) ?? 0) + 1);
    return out;
  }

  // ---------- cursors / segments ----------

  getCursor(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM ingest_cursor WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }
  setCursor(key: string, value: string) {
    this.db.prepare('INSERT INTO ingest_cursor (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, value, new Date().toISOString());
  }
  hasSegment(id: string): { extractor: string } | undefined {
    return this.db.prepare('SELECT extractor FROM segments WHERE id = ?').get(id) as { extractor: string } | undefined;
  }
  recordSegment(s: { id: string; sessionId: string; projectPath: string; agent: string; startedAt: string; userPrompt: string; outcome: string; filesRead: string[]; filesMutated: string[]; nEvents: number; extractor: string; costUsd: number }) {
    this.db.prepare(`INSERT INTO segments (id,session_id,project_path,agent,started_at,user_prompt,outcome,files_read,files_mutated,n_events,extractor,cost_usd,ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET extractor=excluded.extractor, cost_usd=segments.cost_usd+excluded.cost_usd, ingested_at=excluded.ingested_at`)
      .run(s.id, s.sessionId, s.projectPath, s.agent, s.startedAt, s.userPrompt.slice(0, 2000), s.outcome, JSON.stringify(s.filesRead), JSON.stringify(s.filesMutated), s.nEvents, s.extractor, s.costUsd, new Date().toISOString());
  }
  segmentStats(): { n: number; llm: number; cost: number; sessions: number } {
    const r = this.db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN extractor IN ('llm','both') THEN 1 ELSE 0 END) llm, COALESCE(SUM(cost_usd),0) cost, COUNT(DISTINCT session_id) sessions FROM segments`).get() as { n: number; llm: number; cost: number; sessions: number };
    return r;
  }
  segmentsForEval(limit = 200): { id: string; session_id: string; project_path: string; started_at: string; user_prompt: string; files_read: string; files_mutated: string; outcome: string }[] {
    return this.db.prepare(`SELECT id, session_id, project_path, started_at, user_prompt, files_read, files_mutated, outcome FROM segments ORDER BY started_at ASC LIMIT ?`).all(limit) as never;
  }

  // ---------- injections / feedback ----------

  recordInjection(x: { sessionId?: string; surface: string; query: string; entityIds: string[]; cwd?: string; latencyMs: number }) {
    this.db.prepare('INSERT INTO injections (session_id,surface,query,entity_ids,cwd,latency_ms,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(x.sessionId ?? null, x.surface, x.query.slice(0, 500), JSON.stringify(x.entityIds), x.cwd ?? null, x.latencyMs, new Date().toISOString());
  }
  lastInjection(sessionId?: string): { entity_ids: string; query: string; created_at: string; surface: string } | undefined {
    return (sessionId
      ? this.db.prepare('SELECT entity_ids, query, created_at, surface FROM injections WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId)
      : this.db.prepare('SELECT entity_ids, query, created_at, surface FROM injections ORDER BY id DESC LIMIT 1').get()) as never;
  }
  recentInjectionsForSession(sessionId: string, limit = 5): { entity_ids: string }[] {
    return this.db.prepare('SELECT entity_ids FROM injections WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit) as never;
  }
  recordFeedback(entityId: string, signal: string, sessionId?: string, note?: string) {
    this.db.prepare('INSERT INTO feedback (entity_id,session_id,signal,note,created_at) VALUES (?,?,?,?,?)').run(entityId, sessionId ?? null, signal, note ?? null, new Date().toISOString());
    // update usefulness (bounded running score)
    const w: Record<string, number> = { used: 0.15, useful: 0.3, ignored: -0.05, not_useful: -0.3, wrong: -0.6 };
    const e = this.getEntity(entityId);
    if (e) {
      e.validity.usefulness = Math.max(-1, Math.min(1, e.validity.usefulness + (w[signal] ?? 0)));
      if (signal === 'useful' || signal === 'used') { e.validity.lastConfirmed = new Date().toISOString(); }
      this.upsertEntity(e);
    }
  }
  injectionStats(): { injections: number; feedback: number; used: number } {
    const a = this.db.prepare('SELECT COUNT(*) n FROM injections').get() as { n: number };
    const b = this.db.prepare('SELECT COUNT(*) n FROM feedback').get() as { n: number };
    const c = this.db.prepare("SELECT COUNT(*) n FROM feedback WHERE signal IN ('used','useful')").get() as { n: number };
    return { injections: a.n, feedback: b.n, used: c.n };
  }
}

function rowToEntity(r: { json: string; embedding: Uint8Array | null }): Entity {
  const e = JSON.parse(r.json) as Entity;
  if (r.embedding) {
    const buf = Buffer.from(r.embedding);
    e.embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return e;
}

/** Turn free text into a safe FTS5 OR-query of quoted terms. */
export function toFtsQuery(text: string): string {
  const toks = text.toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').split(/\s+/).filter((t) => t.length > 1);
  const uniq = [...new Set(toks)].slice(0, 24);
  if (!uniq.length) return '';
  return uniq.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
