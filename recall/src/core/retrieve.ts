import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Entity, EntityType } from './schema.js';
import { Store } from './store.js';
import { cosine, defaultEmbedder, type Embedder } from './embed.js';

export interface Query {
  intent: string;
  cwd?: string;             // project root the agent is working in
  files?: string[];         // files being touched / mentioned
  sessionId?: string;
  types?: EntityType[];
  topK?: Partial<Record<EntityType, number>>;
  /** Minimum confidence per type (defaults: rules/decisions 0.5 so raw heuristic corrections are not injected as rules). */
  minConfidence?: Partial<Record<EntityType, number>>;
  /** Only entities of this project (or global scope). Default: cross-project pointers/subjects/procedures allowed at a penalty; rules/decisions never cross projects unless personal-scope. */
  projectOnly?: boolean;
}
const DEFAULT_MIN_CONF: Partial<Record<EntityType, number>> = { rule: 0.5, decision: 0.5 };

export interface Hit { entity: Entity; score: number; caveats: string[]; verified: boolean | null }

const DEFAULT_TOPK: Record<EntityType, number> = { pointer: 3, procedure: 2, rule: 5, decision: 2, subject: 3 };
// Tunable via env for calibration runs (see eval/replay). Defaults were set by replay eval on 2026-08-16.
const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const W_VEC = num('RECALL_W_VEC', 0.25), W_LEX = num('RECALL_W_LEX', 0.65), W_FILE = num('RECALL_W_FILE', 0.25);
const MIN_BASE = num('RECALL_MIN_SCORE', 0.12);
const MIN_SCORE: Record<EntityType, number> = { pointer: MIN_BASE, procedure: MIN_BASE, rule: MIN_BASE * 0.85, decision: MIN_BASE * 0.9, subject: MIN_BASE * 1.1 };

function daysBetween(a: string, b: Date) { return Math.max(0, (b.getTime() - new Date(a).getTime()) / 86400000); }

/** Verify path-anchored entities against the working tree; returns caveats and a boolean (null = nothing to verify). */
export function verifyEntity(e: Entity, cwd?: string): { ok: boolean | null; caveats: string[] } {
  const caveats: string[] = [];
  const v = e.validity.verify;
  if (!v || v.kind !== 'path' || !cwd) return { ok: null, caveats };
  const p = isAbsolute(v.target) ? v.target : join(cwd, v.target);
  if (existsSync(p)) return { ok: true, caveats };
  caveats.push(`referenced path no longer exists: ${v.target} (last confirmed ${e.validity.lastConfirmed.slice(0, 10)})`);
  return { ok: false, caveats };
}

export function retrieve(store: Store, q: Query, embedder: Embedder = defaultEmbedder): Hit[] {
  const now = new Date();
  const project = q.cwd ?? '';
  const types = q.types ?? (Object.keys(DEFAULT_TOPK) as EntityType[]);
  const intent = [q.intent, ...(q.files ?? []).map((f) => f.split('/').pop() ?? '')].join(' ');
  const qEmb = embedder.embed(intent);
  const fileHits = store.entitiesForPaths(q.files ?? []);

  // Candidate pool: FTS (per type) ∪ file-index hits ∪ project entities (small KBs) — then score all
  const cand = new Map<string, Entity>();
  const bm25 = new Map<string, number>();
  for (const t of types) for (const r of store.ftsSearch(intent, 40, t)) { bm25.set(r.id, r.bm25); }
  for (const id of [...bm25.keys(), ...fileHits.keys()]) { const e = store.getEntity(id); if (e) cand.set(id, e); }
  if (cand.size < 40) for (const e of store.allEntities({ projectPath: project })) if (types.includes(e.type)) cand.set(e.id, e);

  // normalize bm25 → 0..1 (bm25 in FTS5 is negative; more negative = better)
  const bmVals = [...bm25.values()]; const bmMin = Math.min(0, ...bmVals); // most negative
  const bmNorm = (id: string) => { const v = bm25.get(id); if (v === undefined || bmMin === 0) return 0; return Math.min(1, v / bmMin); };

  const hits: Hit[] = [];
  for (const e of cand.values()) {
    if (!types.includes(e.type)) continue;
    if (e.sensitivity === 'restricted' && e.projectPath !== project) continue;
    const minC = q.minConfidence?.[e.type] ?? DEFAULT_MIN_CONF[e.type] ?? 0;
    if (e.validity.confidence < minC) continue;
    const isGlobal = e.projectPath === '' || e.scope === 'personal';
    const sameProject = isGlobal || e.projectPath === project || (!!project && !!e.projectPath && (project.startsWith(e.projectPath + '/') || e.projectPath.startsWith(project + '/')));
    if (!sameProject && (q.projectOnly || e.type === 'rule' || e.type === 'decision')) continue;
    const vec = e.embedding ? Math.max(0, cosine(qEmb, e.embedding)) : 0;
    const lex = bmNorm(e.id);
    const fileBoost = fileHits.has(e.id) ? W_FILE : 0;
    const age = daysBetween(e.validity.lastConfirmed, now);
    const decay = Math.pow(0.5, age / e.validity.decayHalfLifeDays);
    const evidence = Math.min(0.15, 0.03 * Math.log2(1 + e.validity.evidence));
    const conf = e.validity.confidence;
    const use = e.validity.usefulness * 0.15;
    let score = W_VEC * vec + W_LEX * lex + fileBoost + evidence + use;
    score = score * (0.75 + 0.25 * decay) * (0.8 + 0.2 * conf) * (sameProject ? 1 : 0.45);
    if (score < MIN_SCORE[e.type]) continue;
    const v = verifyEntity(e, q.cwd);
    if (v.ok === false) score *= 0.5;
    hits.push({ entity: e, score, caveats: v.caveats, verified: v.ok });
  }
  hits.sort((a, b) => b.score - a.score);
  const perType: Record<string, number> = {};
  const out: Hit[] = [];
  for (const h of hits) {
    const k = h.entity.type; const cap = q.topK?.[k] ?? DEFAULT_TOPK[k];
    if ((perType[k] ?? 0) >= cap) continue;
    perType[k] = (perType[k] ?? 0) + 1; out.push(h);
  }
  return out;
}

/** Render hits as the <recall-context> block injected into the agent. */
export function formatContext(hits: Hit[], opts: { maxChars?: number; showIds?: boolean } = {}): string {
  if (!hits.length) return '';
  const max = opts.maxChars ?? 3500;
  const L: string[] = [];
  L.push('<recall-context source="recall" note="Auto-retrieved from your local knowledge base (built from past agent sessions). Background context — verify before relying on it. Each item has an id; call recall_feedback if one was wrong or useful.">');
  const by = (t: EntityType) => hits.filter((h) => h.entity.type === t);
  const idOf = (h: Hit) => (opts.showIds === false ? '' : ` [${h.entity.id.slice(0, 8)}]`);
  const conf = (h: Hit) => `${Math.round(h.entity.validity.confidence * 100)}%·×${h.entity.validity.evidence}`;
  const ptrs = by('pointer');
  if (ptrs.length) { L.push('Where to look:'); for (const h of ptrs) { const e = h.entity as Extract<Entity, { type: 'pointer' }>;
    L.push(`  • ${e.outcomeClass.slice(0, 110)}${idOf(h)} (${conf(h)})`);
    for (const t of e.targets.slice(0, 3)) L.push(`      → ${t.path}: ${t.reason.slice(0, 120)}`);
    for (const d of e.decoys.slice(0, 2)) L.push(`      ✗ ${d.path}: ${d.reason.slice(0, 90)}`);
    if (e.resolution) L.push(`      fix: ${e.resolution.slice(0, 160)}`);
    for (const c of h.caveats) L.push(`      ⚠ ${c}`); } }
  const rules = by('rule');
  if (rules.length) { L.push('Rules (from past corrections):'); for (const h of rules) { const e = h.entity as Extract<Entity, { type: 'rule' }>;
    L.push(`  • ${e.ruleText.slice(0, 200)}${idOf(h)} (${conf(h)})`); } }
  const procs = by('procedure');
  if (procs.length) { L.push('Procedures that worked:'); for (const h of procs) { const e = h.entity as Extract<Entity, { type: 'procedure' }>;
    L.push(`  • ${e.goal.slice(0, 110)}${idOf(h)}`); for (const s of e.steps.slice(0, 5)) L.push(`      ${s.command ? '$ ' + s.command.slice(0, 120) : s.do.slice(0, 120)}`);
    for (const a of e.antiPatterns.slice(0, 2)) L.push(`      avoid: ${a.desc.slice(0, 100)}`); } }
  const decs = by('decision');
  if (decs.length) { L.push('Decisions in force:'); for (const h of decs) { const e = h.entity as Extract<Entity, { type: 'decision' }>;
    L.push(`  • ${e.title.slice(0, 100)}${idOf(h)}: ${e.choice.slice(0, 160)}`); } }
  const subs = by('subject');
  if (subs.length) { L.push('Context:'); for (const h of subs) { const e = h.entity as Extract<Entity, { type: 'subject' }>;
    L.push(`  • ${e.path}${idOf(h)}: ${e.summary.slice(0, 160)}`); for (const c of h.caveats) L.push(`      ⚠ ${c}`); } }
  L.push('</recall-context>');
  let s = L.join('\n');
  if (s.length > max) s = s.slice(0, max - 20) + '\n…</recall-context>';
  return s;
}
