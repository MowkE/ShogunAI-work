// GitHub PR collector via the `gh` CLI (uses your existing gh auth; nothing else to configure).
// PR review comments are the richest source of Rules: human corrections, already scoped to a file/line.
// PR title/body/files → pointers. Read-only.

import { execFileSync } from 'node:child_process';
import type { DraftEntity, Provenance, RuleCategory } from '../core/schema.js';

export interface PrSummary { number: number; title: string; body: string; author: string; mergedAt?: string | null; createdAt: string; files: string[] }
export interface ReviewComment { prNumber: number; path: string; line?: number; body: string; author: string; createdAt: string; kind: 'inline' | 'review' | 'issue' }

function gh<T>(args: string[]): T | null {
  try { return JSON.parse(execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })) as T; }
  catch { return null; }
}

export function ghAvailable(): boolean { try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); return true; } catch { return false; } }

export function listPRs(owner: string, repo: string, max = 50): PrSummary[] {
  const prs = gh<{ number: number; title: string; body: string | null; user: { login: string }; merged_at: string | null; created_at: string }[]>(
    ['api', `repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${Math.min(max, 100)}`]) ?? [];
  const out: PrSummary[] = [];
  for (const p of prs) {
    const files = gh<{ filename: string }[]>(['api', `repos/${owner}/${repo}/pulls/${p.number}/files?per_page=100`]) ?? [];
    out.push({ number: p.number, title: p.title, body: p.body ?? '', author: p.user?.login ?? '', mergedAt: p.merged_at, createdAt: p.created_at, files: files.map((f) => f.filename) });
  }
  return out;
}

export function listReviewComments(owner: string, repo: string, prNumber: number): ReviewComment[] {
  const inline = gh<{ path: string; line: number | null; original_line: number | null; body: string; user: { login: string }; created_at: string }[]>(
    ['api', `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`]) ?? [];
  const reviews = gh<{ body: string; state: string; user: { login: string }; submitted_at: string }[]>(
    ['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`]) ?? [];
  const out: ReviewComment[] = [];
  for (const c of inline) out.push({ prNumber, path: c.path, line: c.line ?? c.original_line ?? undefined, body: c.body ?? '', author: c.user?.login ?? '', createdAt: c.created_at, kind: 'inline' });
  for (const r of reviews) if (r.body && r.body.trim().length > 20 && r.state !== 'APPROVED') out.push({ prNumber, path: '', body: r.body, author: r.user?.login ?? '', createdAt: r.submitted_at, kind: 'review' });
  return out;
}

const REQUEST_RE = /\b(should|please|don't|do not|use|instead|avoid|prefer|consider|remove|rename|move|extract|nit|why not|must|never|always|let's|lets|can we|could we|shouldn't|needs? to)\b/i;

function categorize(text: string): RuleCategory {
  if (/\b(secrets?|tokens?|passwords?|credentials?|injection|xss|csrf|sanitiz|escap|auth\w*|leak\w*|permission|privilege)/i.test(text)) return 'safety';
  if (/\b(file|folder|directory|move|belongs in|put (this|it) in)\b/i.test(text)) return 'wrong_file';
  if (/\b(use|instead of|prefer|library|helper|util|api|method|function)\b/i.test(text)) return 'wrong_pattern';
  if (/\b(remove|unnecessary|don't need|dead code|unused|redundant)\b/i.test(text)) return 'unnecessary_work';
  if (/\b(name|naming|rename|style|format|lint|convention)\b/i.test(text)) return 'convention';
  return 'convention';
}

/** Rules from review comments; pointers from PRs. */
export function extractFromPRs(repo: string, prs: PrSummary[], comments: ReviewComment[]): DraftEntity[] {
  const out: DraftEntity[] = [];
  const byPr = new Map<number, PrSummary>(prs.map((p) => [p.number, p]));
  for (const c of comments) {
    const body = c.body.replace(/\s+/g, ' ').trim();
    if (body.length < 15 || body.length > 1200) continue;
    if (!REQUEST_RE.test(body)) continue;               // only correction-shaped comments
    if (/^(lgtm|looks good|nice|great|thanks|\+1|👍)/i.test(body)) continue;
    const pr = byPr.get(c.prNumber);
    const prov: Provenance = { source: 'pr', prNumber: c.prNumber, author: c.author, docPath: c.path || undefined, observedAt: c.createdAt, extractor: 'heuristic' };
    const paths = c.path ? [c.path] : (pr?.files.slice(0, 5) ?? []);
    out.push({
      type: 'rule', scope: 'project', sensitivity: 'internal', projectPath: repo, provenance: [prov],
      ruleText: (c.path ? `[${c.path.split('/').pop()}] ` : '') + (body.length > 240 ? body.slice(0, 240) + '…' : body),
      category: categorize(body), appliesTo: { paths }, enforcement: 'inform', confidence: 0.6, paths,
    });
  }
  for (const p of prs) {
    if (!p.files.length || p.files.length > 40 || p.title.length < 8) continue;
    const prov: Provenance = { source: 'pr', prNumber: p.number, author: p.author, observedAt: p.mergedAt ?? p.createdAt, extractor: 'heuristic' };
    out.push({
      type: 'pointer', scope: 'project', sensitivity: 'internal', projectPath: repo, provenance: [prov],
      outcomeClass: p.title.slice(0, 140), signals: [], resolution: p.body ? p.body.replace(/\s+/g, ' ').slice(0, 220) : undefined,
      targets: p.files.slice(0, 8).map((f, i) => ({ path: f, reason: `changed in PR #${p.number} "${p.title.slice(0, 50)}"`, priority: 8 - i })),
      decoys: [], confidence: p.mergedAt ? 0.55 : 0.4, paths: p.files.slice(0, 8),
    });
  }
  return out;
}
