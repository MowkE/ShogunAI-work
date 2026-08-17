#!/usr/bin/env node
// Replay eval: for segments ingested, does retrieval on the *first prompt* surface the files that were eventually edited?
// hit@k over pointer/subject targets; a BM25-only baseline is reported alongside for comparison.
// Usage: node dist/eval/replay.js [--limit 300] [--project substr]

import { Store } from '../core/store.js';
import { retrieve } from '../core/retrieve.js';
import type { Entity } from '../core/schema.js';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const limit = Number(opt('--limit', '400'));
const projectFilter = opt('--project');

const store = new Store();
const segs = store.segmentsForEval(5000).filter((s) => (!projectFilter || s.project_path.includes(projectFilter)) && s.files_mutated !== '[]' && s.user_prompt.length > 20).slice(-limit);

function pathsOf(e: Entity): string[] {
  if (e.type === 'pointer') return e.targets.map((t) => t.path);
  if (e.type === 'subject') return [e.path];
  return e.paths;
}

let n = 0, hit1 = 0, hit3 = 0, hitAny = 0, precTotal = 0, precN = 0, latency = 0;
let baseHit3 = 0;
for (const s of segs) {
  const edited = new Set<string>(JSON.parse(s.files_mutated));
  if (!edited.size) continue;
  const t0 = Date.now();
  // Exclude entities whose provenance includes this very segment (no leakage): filter after retrieval
  const hits = retrieve(store, { intent: s.user_prompt, cwd: s.project_path, types: ['pointer', 'subject', 'procedure'] })
    .filter((h) => !h.entity.provenance.some((p) => p.segmentId === s.id));
  latency += Date.now() - t0;
  n++;
  const ranked = hits.map((h) => pathsOf(h.entity));
  const rankHit = ranked.findIndex((ps) => ps.some((p) => edited.has(p)));
  if (rankHit === 0) hit1++;
  if (rankHit >= 0 && rankHit < 3) hit3++;
  if (rankHit >= 0) hitAny++;
  if (hits.length) { const good = hits.filter((h) => pathsOf(h.entity).some((p) => edited.has(p))).length; precTotal += good / hits.length; precN++; }
  // baseline: FTS only, top 3 by bm25 across pointer/subject
  const base = store.ftsSearch(s.user_prompt, 3).map((r) => store.getEntity(r.id)).filter((e): e is Entity => !!e && !e.provenance.some((p) => p.segmentId === s.id));
  if (base.some((e) => pathsOf(e).some((p) => edited.has(p)))) baseHit3++;
}
const pct = (x: number) => (n ? (100 * x / n).toFixed(1) + '%' : 'n/a');
console.log(JSON.stringify({
  segmentsEvaluated: n,
  hit_at_1: pct(hit1), hit_at_3: pct(hit3), hit_any: pct(hitAny),
  precision_mean: precN ? (precTotal / precN).toFixed(3) : 'n/a',
  bm25_only_hit_at_3: pct(baseHit3),
  avg_latency_ms: n ? Math.round(latency / n) : 0,
  note: 'Leakage-controlled: entities derived from the evaluated segment itself are excluded. Small KBs will score low; watch the trend as more sessions/LLM refinement land.',
}, null, 2));
store.close();
