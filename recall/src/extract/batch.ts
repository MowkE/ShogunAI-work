// Message Batches backfill (Anthropic SDK; -50% cost, async). Requires ANTHROPIC_API_KEY / `ant auth login`.
//   recall ingest --batch [--since N] [--max-segments N]   → submits one batch, records it under ~/.recall/batches/<id>.json
//   recall batch status <id> | recall batch apply <id>      → poll; when ended, map results → drafts → merge
// Untested against a live key in the authoring session; the request shape follows the SDK docs (custom_id + params, output_config.format).
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Segment } from '../core/schema.js';
import { Store } from '../core/store.js';
import { mergeDrafts } from '../core/merge.js';
import { pickEmbedder, type Embedder } from '../core/embed.js';
import { discoverAll, readAny } from '../collectors/index.js';
import { redactDeep } from '../core/redact.js';
import { segmentSession } from './segment.js';
import { buildExtractionRequest, mapExtraction } from './llm.js';
import { DEFAULT_MODEL } from './model.js';

const DIR = join(homedir(), '.recall', 'batches');
interface BatchRecord { id: string; model: string; createdAt: string; segments: Record<string, { sessionId: string; projectPath: string; agent: string; startedAt: string; userPrompt: string; filesRead: string[]; filesMutated: string[]; nEvents: number; segment: Segment }>; status: 'submitted' | 'applied' }

async function client() { const { default: Anthropic } = await import('@anthropic-ai/sdk'); return new Anthropic(); }

/** Collect segments eligible for LLM refinement (not yet LLM-extracted). */
export function collectSegments(store: Store, opts: { since?: number; project?: string; max?: number; minEvents?: number } = {}): Segment[] {
  let refs = discoverAll();
  if (opts.since) { const cutoff = Date.now() - opts.since * 86400000; refs = refs.filter((r) => r.mtimeMs >= cutoff); }
  if (opts.project) refs = refs.filter((r) => r.projectPath.includes(opts.project!));
  const out: Segment[] = [];
  for (const ref of refs.reverse()) {
    let sess; try { sess = readAny(ref); } catch { continue; }
    if (sess.events.length < 4) continue;
    const projectPath = (sess.cwd ?? ref.projectPath) || `unknown:${ref.collector}:${ref.sessionId.slice(0, 8)}`;
    for (const seg of segmentSession(ref.sessionId, projectPath, redactDeep(sess.events))) {
      if (seg.events.length < (opts.minEvents ?? 6) || seg.userPrompt.length <= 20) continue;
      const done = store.hasSegment(seg.id); if (done && done.extractor !== 'heuristic') continue;
      out.push(seg); if (opts.max && out.length >= opts.max) return out;
    }
  }
  return out;
}

export async function submitBatch(store: Store, segs: Segment[], model = DEFAULT_MODEL): Promise<{ id: string; count: number }> {
  const c = await client();
  const requests = segs.map((seg) => { const r = buildExtractionRequest(seg); return { custom_id: seg.id, params: { model, max_tokens: 8000, system: [{ type: 'text', text: r.system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: r.user }], output_config: { format: { type: 'json_schema', schema: r.schema } } } }; });
  const b = await (c as unknown as { messages: { batches: { create(x: unknown): Promise<{ id: string }> } } }).messages.batches.create({ requests });
  mkdirSync(DIR, { recursive: true });
  const rec: BatchRecord = { id: b.id, model, createdAt: new Date().toISOString(), status: 'submitted', segments: Object.fromEntries(segs.map((s) => [s.id, { sessionId: s.sessionId, projectPath: s.projectPath, agent: s.agent, startedAt: s.startedAt, userPrompt: s.userPrompt, filesRead: s.filesRead, filesMutated: s.filesMutated, nEvents: s.events.length, segment: s }])) };
  writeFileSync(join(DIR, `${b.id}.json`), JSON.stringify(rec));
  return { id: b.id, count: segs.length };
}

export function listBatches(): { id: string; createdAt: string; status: string; count: number }[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => { const r = JSON.parse(readFileSync(join(DIR, f), 'utf-8')) as BatchRecord; return { id: r.id, createdAt: r.createdAt, status: r.status, count: Object.keys(r.segments).length }; });
}

export async function batchStatus(id: string): Promise<unknown> {
  const c = await client();
  return (c as unknown as { messages: { batches: { retrieve(id: string): Promise<unknown> } } }).messages.batches.retrieve(id);
}

export async function applyBatch(store: Store, id: string, embedder: Embedder = pickEmbedder(), onProgress?: (m: string) => void): Promise<{ applied: number; failed: number; inserted: number; merged: number }> {
  const path = join(DIR, `${id}.json`);
  const rec = JSON.parse(readFileSync(path, 'utf-8')) as BatchRecord;
  const c = await client();
  const st = await (c as unknown as { messages: { batches: { retrieve(id: string): Promise<{ processing_status: string }> } } }).messages.batches.retrieve(id);
  if (st.processing_status !== 'ended') throw new Error(`batch ${id} is ${st.processing_status}; try again later`);
  const results = await (c as unknown as { messages: { batches: { results(id: string): Promise<AsyncIterable<{ custom_id: string; result: { type: string; message?: { content: { type: string; text?: string }[] } } }>> } } }).messages.batches.results(id);
  let applied = 0, failed = 0, inserted = 0, merged = 0;
  for await (const r of results) {
    const meta = rec.segments[r.custom_id]; if (!meta) continue;
    if (r.result.type !== 'succeeded' || !r.result.message) { failed++; continue; }
    const text = r.result.message.content.find((b) => b.type === 'text')?.text ?? '{}';
    let data: unknown; try { data = JSON.parse(text); } catch { failed++; continue; }
    const { drafts, outcome } = mapExtraction(meta.segment, data, rec.model);
    const m = await mergeDrafts(store, drafts, embedder); inserted += m.inserted; merged += m.merged; applied++;
    store.recordSegment({ id: r.custom_id, sessionId: meta.sessionId, projectPath: meta.projectPath, agent: meta.agent, startedAt: meta.startedAt, userPrompt: meta.userPrompt, outcome, filesRead: meta.filesRead, filesMutated: meta.filesMutated, nEvents: meta.nEvents, extractor: store.hasSegment(r.custom_id) ? 'both' : 'llm', costUsd: 0 });
    onProgress?.(`applied ${r.custom_id}: ${drafts.length} entities`);
  }
  rec.status = 'applied'; writeFileSync(path, JSON.stringify(rec));
  return { applied, failed, inserted, merged };
}
