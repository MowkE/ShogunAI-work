import type { SourceRef, Segment, DraftEntity } from '../core/schema.js';
import { Store } from '../core/store.js';
import { redactDeep, type RedactionReport } from '../core/redact.js';
import { mergeDrafts } from '../core/merge.js';
import { type Embedder, pickEmbedder } from '../core/embed.js';
import { discoverAll, readAny } from '../collectors/index.js';
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
  embedder?: Embedder;        // defaults to pickEmbedder()
  collectors?: string[];      // restrict to these collectors (default all)
}

export interface IngestResult {
  sessions: number; segments: number; llmSegments: number; inserted: number; merged: number; costUsd: number; redactions: number; skipped: number;
}

export async function ingest(store: Store, opts: IngestOptions = {}): Promise<IngestResult> {
  const res: IngestResult = { sessions: 0, segments: 0, llmSegments: 0, inserted: 0, merged: 0, costUsd: 0, redactions: 0, skipped: 0 };
  const log = opts.onProgress ?? (() => {});
  const embedder = opts.embedder ?? pickEmbedder();
  const all = discoverAll(opts.collectors);
  let refs: SourceRef[] = opts.paths?.length ? all.filter((r) => opts.paths!.includes(r.path)) : all;
  if (opts.since) { const cutoff = Date.now() - opts.since * 86400000; refs = refs.filter((r) => r.mtimeMs >= cutoff); }
  if (opts.project) refs = refs.filter((r) => r.projectPath.includes(opts.project!));
  if (opts.session) refs = refs.filter((r) => r.sessionId.startsWith(opts.session!));
  if (opts.max) refs = refs.slice(-opts.max);
  log(`found ${refs.length} sessions`);

  const llmBudgetLeft = () => (opts.maxLlmSegments === undefined || res.llmSegments < opts.maxLlmSegments) && (opts.maxCostUsd === undefined || res.costUsd < opts.maxCostUsd);

  let i = 0;
  for (const ref of refs) {
    i++;
    const cursorKey = `${ref.collector === 'claude-code' ? 'cc' : ref.collector}:${ref.sessionId}`;
    const prev = store.getCursor(cursorKey);
    const stamp = `${ref.mtimeMs}:${ref.sizeBytes}`;
    const llmWanted = !!opts.llm && llmBudgetLeft();
    if (!opts.force && prev === stamp + (llmWanted ? '' : '') && !llmWanted) { res.skipped++; continue; }
    let sess; try { sess = readAny(ref); } catch { res.skipped++; continue; }
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
      const m = await mergeDrafts(store, drafts, embedder);
      res.inserted += m.inserted; res.merged += m.merged; res.segments++;
      store.recordSegment({ id: seg.id, sessionId: seg.sessionId, projectPath: seg.projectPath, agent: seg.agent, startedAt: seg.startedAt, userPrompt: seg.userPrompt, outcome: seg.outcome, filesRead: seg.filesRead, filesMutated: seg.filesMutated, nEvents: seg.events.length, extractor: done && extractor === 'llm' ? 'both' : extractor, costUsd: cost });
    }
    store.setCursor(cursorKey, stamp);
  }
  return res;
}

export function segmentsOf(ref: SourceRef): Segment[] {
  const sess = readAny(ref);
  return segmentSession(ref.sessionId, sess.cwd ?? ref.projectPath, redactDeep(sess.events));
}

// ---------------- git + GitHub PR ingestion ----------------
import { gitLog, isGitRepo, gitRemote, extractFromCommits } from '../collectors/git.js';
import { listPRs, listReviewComments, extractFromPRs, ghAvailable } from '../collectors/github.js';
import { redact } from '../core/redact.js';

export interface RepoIngestResult { repo: string; commits: number; prs: number; reviewComments: number; inserted: number; merged: number; skipped?: string }

/** Ingest a repository's git history and (if gh is authenticated and origin is GitHub) its PRs/review comments. */
export async function ingestRepo(store: Store, repo: string, opts: { maxCommits?: number; maxPrs?: number; prs?: boolean; embedder?: Embedder; force?: boolean; onProgress?: (m: string) => void } = {}): Promise<RepoIngestResult> {
  const log = opts.onProgress ?? (() => {});
  const res: RepoIngestResult = { repo, commits: 0, prs: 0, reviewComments: 0, inserted: 0, merged: 0 };
  if (!isGitRepo(repo)) { res.skipped = 'not a git repo'; return res; }
  const embedder = opts.embedder ?? pickEmbedder();
  const drafts: DraftEntity[] = [];

  // git log (cursor on HEAD sha)
  const commits = gitLog(repo, opts.maxCommits ?? 400).map((c) => ({ ...c, subject: redact(c.subject).text, body: redact(c.body).text }));
  const head = commits[0]?.sha ?? '';
  const ck = `git:${repo}`;
  if (opts.force || store.getCursor(ck) !== head) {
    drafts.push(...extractFromCommits(repo, commits));
    res.commits = commits.length;
    store.setCursor(ck, head);
    log(`git: ${commits.length} commits → ${drafts.length} drafts`);
  } else log('git: up to date');

  // PRs via gh
  const remote = gitRemote(repo);
  if (opts.prs !== false && remote && ghAvailable()) {
    const prs = listPRs(remote.owner, remote.repo, opts.maxPrs ?? 40);
    const comments = prs.flatMap((p) => {
      const key = `pr:${remote.owner}/${remote.repo}#${p.number}`;
      if (!opts.force && store.getCursor(key)) return [];
      const cs = listReviewComments(remote.owner, remote.repo, p.number);
      store.setCursor(key, p.mergedAt ?? p.createdAt);
      return cs;
    }).map((c) => ({ ...c, body: redact(c.body).text }));
    const before = drafts.length;
    drafts.push(...extractFromPRs(repo, prs.map((p) => ({ ...p, title: redact(p.title).text, body: redact(p.body).text })), comments));
    res.prs = prs.length; res.reviewComments = comments.length;
    log(`github: ${prs.length} PRs, ${comments.length} review comments → ${drafts.length - before} drafts`);
  }
  if (drafts.length) { const m = await mergeDrafts(store, drafts, embedder); res.inserted = m.inserted; res.merged = m.merged; }
  return res;
}
