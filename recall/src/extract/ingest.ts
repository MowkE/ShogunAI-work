import type { SourceRef, Segment, DraftEntity } from '../core/schema.js';
import { Store } from '../core/store.js';
import { redactDeep, type RedactionReport } from '../core/redact.js';
import { mergeDrafts } from '../core/merge.js';
import * as claudeCode from '../collectors/claude-code.js';
import { segmentSession } from './segment.js';
import { heuristicExtract } from './heuristic.js';
import { llmExtract } from './llm.js';
import type { JsonModel } from './model.js';

export interface IngestOptions {
  since?: number;             // days
  project?: string;           // substring filter on projectPath
  session?: string;           // session id prefix
  max?: number;               // max sessions
  llm?: JsonModel | null;     // model for refinement (null = heuristic only)
  maxLlmSegments?: number;    // cap LLM calls this run
  maxCostUsd?: number;        // stop LLM once exceeded
  minSegmentEvents?: number;  // skip tiny segments for LLM
  onProgress?: (msg: string, cur?: number, total?: number) => void;
  force?: boolean;            // re-ingest even if cursor says done
  paths?: string[];           // explicit transcript files (e.g. from a hook)
}

export interface IngestResult {
  sessions: number; segments: number; llmSegments: number; inserted: number; merged: number; costUsd: number; redactions: number; skipped: number;
}

export async function ingest(store: Store, opts: IngestOptions = {}): Promise<IngestResult> {
  const res: IngestResult = { sessions: 0, segments: 0, llmSegments: 0, inserted: 0, merged: 0, costUsd: 0, redactions: 0, skipped: 0 };
  const log = opts.onProgress ?? (() => {});
  let refs: SourceRef[] = opts.paths?.length
    ? opts.paths.map((p) => claudeCode.discover().find((r) => r.path === p)).filter((x): x is SourceRef => !!x)
    : claudeCode.discover();
  if (opts.since) { const cutoff = Date.now() - opts.since * 86400000; refs = refs.filter((r) => r.mtimeMs >= cutoff); }
  if (opts.project) refs = refs.filter((r) => r.projectPath.includes(opts.project!));
  if (opts.session) refs = refs.filter((r) => r.sessionId.startsWith(opts.session!));
  if (opts.max) refs = refs.slice(-opts.max);
  log(`found ${refs.length} sessions`);

  const llmBudgetLeft = () => (opts.maxLlmSegments === undefined || res.llmSegments < opts.maxLlmSegments) && (opts.maxCostUsd === undefined || res.costUsd < opts.maxCostUsd);

  let i = 0;
  for (const ref of refs) {
    i++;
    const cursorKey = `cc:${ref.sessionId}`;
    const prev = store.getCursor(cursorKey);
    const stamp = `${ref.mtimeMs}:${ref.sizeBytes}`;
    const llmWanted = !!opts.llm && llmBudgetLeft();
    if (!opts.force && prev === stamp + (llmWanted ? '' : '') && !llmWanted) { res.skipped++; continue; }
    let sess; try { sess = claudeCode.readSession(ref); } catch { res.skipped++; continue; }
    if (sess.events.length < 4) { store.setCursor(cursorKey, stamp); res.skipped++; continue; }
    const rep: RedactionReport = { replaced: {}, total: 0 };
    const events = redactDeep(sess.events, rep); res.redactions += rep.total;
    const projectPath = sess.cwd ?? ref.projectPath;
    const segs = segmentSession(ref.sessionId, projectPath, events);
    res.sessions++;
    log(`[${i}/${refs.length}] ${ref.sessionId.slice(0, 8)} ${projectPath.split('/').slice(-2).join('/')} → ${segs.length} segments`, i, refs.length);
    for (const seg of segs) {
      const done = store.hasSegment(seg.id);
      const wantLlm = !!opts.llm && llmBudgetLeft() && seg.events.length >= (opts.minSegmentEvents ?? 6) && seg.userPrompt.length > 20 && (!done || (done.extractor === 'heuristic' && !opts.force ? true : !!opts.force));
      if (done && !wantLlm && !opts.force) continue;
      let drafts: DraftEntity[] = [];
      let extractor: 'heuristic' | 'llm' | 'both' = 'heuristic';
      let cost = 0;
      if (!done || opts.force) drafts.push(...heuristicExtract(seg));
      if (wantLlm) {
        try {
          const r = await llmExtract(seg, opts.llm!);
          drafts.push(...r.drafts); cost = r.costUsd; res.costUsd += cost; res.llmSegments++;
          seg.outcome = r.outcome; extractor = done ? 'llm' : 'both';
          log(`   llm: ${r.drafts.length} entities ($${cost.toFixed(3)}) from "${seg.userPrompt.slice(0, 60).replace(/\n/g, ' ')}"`);
        } catch (e) {
          log(`   llm failed: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      const m = mergeDrafts(store, drafts);
      res.inserted += m.inserted; res.merged += m.merged; res.segments++;
      store.recordSegment({ id: seg.id, sessionId: seg.sessionId, projectPath: seg.projectPath, agent: seg.agent, startedAt: seg.startedAt, userPrompt: seg.userPrompt, outcome: seg.outcome, filesRead: seg.filesRead, filesMutated: seg.filesMutated, nEvents: seg.events.length, extractor: done && extractor === 'llm' ? 'both' : extractor, costUsd: cost });
    }
    store.setCursor(cursorKey, stamp);
  }
  return res;
}

export function segmentsOf(ref: SourceRef): Segment[] {
  const sess = claudeCode.readSession(ref);
  return segmentSession(ref.sessionId, sess.cwd ?? ref.projectPath, redactDeep(sess.events));
}
