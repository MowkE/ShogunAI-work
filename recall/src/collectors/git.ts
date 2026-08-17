// Git collector: commit history → pointers ("for a change like <subject>, these files moved together"),
// co-change interactions between files, and decision candidates from commit bodies.
// Read-only; uses the git CLI. Redaction is applied to messages by the caller.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DraftEntity, Provenance } from '../core/schema.js';

export interface Commit { sha: string; author: string; date: string; subject: string; body: string; files: string[] }

const IGNORE = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage)(\/|$)|\.(lock|png|jpg|jpeg|gif|svg|ico|pdf|zip|tgz|gz|woff2?|ttf|map)$|(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)yarn\.lock$/i;
const NOISE_SUBJECT = /^(merge|wip|update|fix typo|bump|initial commit|misc|minor|tmp|temp|save|checkpoint|\.)/i;

export function isGitRepo(dir: string) { return existsSync(join(dir, '.git')); }

export function gitLog(repo: string, max = 400): Commit[] {
  let out: string;
  try {
    out = execFileSync('git', ['-C', repo, 'log', `-n`, String(max), '--no-merges', '--date=iso-strict', '--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f', '--name-only'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const commits: Commit[] = [];
  for (const block of out.split('\x1e')) {
    if (!block.trim()) continue;
    const [sha, author, date, subject, body, filesText] = block.split('\x1f');
    if (!sha) continue;
    // body is terminated by an explicit \x1f; everything after it is the --name-only file list
    const files = (filesText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    commits.push({ sha: sha.trim(), author: author ?? '', date: date ?? '', subject: (subject ?? '').trim(), body: (body ?? '').trim(), files: files.filter((f) => !IGNORE.test(f)) });
  }
  return commits;
}

export function gitRemote(repo: string): { owner: string; repo: string } | null {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch { return null; }
}

/** Heuristic drafts from commits. */
export function extractFromCommits(repo: string, commits: Commit[]): DraftEntity[] {
  const out: DraftEntity[] = [];
  const cochange = new Map<string, Map<string, number>>();
  for (const c of commits) {
    if (!c.files.length || c.files.length > 25) continue; // skip empty and mega-commits
    if (NOISE_SUBJECT.test(c.subject) || c.subject.length < 8) continue;
    const prov: Provenance = { source: 'git', commit: c.sha, author: c.author, observedAt: c.date || new Date().toISOString(), extractor: 'heuristic' };
    const outcome = c.subject.replace(/^\w+(\([^)]*\))?!?:\s*/, ''); // strip conventional-commit prefix for the class
    out.push({
      type: 'pointer', scope: 'project', sensitivity: 'internal', projectPath: repo, provenance: [prov],
      outcomeClass: outcome.slice(0, 140), signals: [], resolution: c.body ? c.body.replace(/\s+/g, ' ').slice(0, 220) : undefined,
      targets: c.files.slice(0, 8).map((f, i) => ({ path: f, reason: `changed in commit "${c.subject.slice(0, 60)}"`, priority: 8 - i })),
      decoys: [], confidence: 0.45, paths: c.files.slice(0, 8),
    });
    // decision candidates: commit bodies that explain a choice
    if (/\b(because|instead of|rather than|so that|to avoid|tradeoff|trade-off)\b/i.test(c.body) && c.body.length > 40) {
      out.push({
        type: 'decision', scope: 'project', sensitivity: 'internal', projectPath: repo, provenance: [prov],
        title: outcome.slice(0, 100), context: '', choice: c.body.replace(/\s+/g, ' ').slice(0, 300), alternatives: [], consequences: [], status: 'active',
        confidence: 0.45, paths: c.files.slice(0, 5),
      });
    }
    for (const a of c.files) { for (const b of c.files) { if (a === b) continue; const m = cochange.get(a) ?? new Map(); m.set(b, (m.get(b) ?? 0) + 1); cochange.set(a, m); } }
  }
  // co-change subjects: files that repeatedly change together (≥3 commits) — surfaced as interactions
  for (const [a, m] of cochange) {
    const strong = [...m.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 6);
    if (!strong.length) continue;
    out.push({
      type: 'subject', scope: 'project', sensitivity: 'internal', projectPath: repo, provenance: [{ source: 'git', observedAt: new Date().toISOString(), extractor: 'heuristic' }],
      kind: 'module', path: a, summary: `${a.split('/').pop()} — frequently changes together with ${strong.map(([b]) => b.split('/').pop()).join(', ')}`,
      responsibilities: [], constraints: [], interactions: strong.map(([b, n]) => ({ path: b, text: `co-changed in ${n} commits` })),
      confidence: 0.4, paths: [a, ...strong.map(([b]) => b)],
    });
  }
  return out;
}

const repoIdCache = new Map<string, string | undefined>();
/** Stable repo identity for a directory (walks up to the git toplevel): "github.com/owner/name" or undefined. */
export function repoIdFor(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  if (repoIdCache.has(dir)) return repoIdCache.get(dir);
  let id: string | undefined;
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const url = execFileSync('git', ['-C', top, 'remote', 'get-url', 'origin'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/);
    id = m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
  } catch { id = undefined; }
  repoIdCache.set(dir, id);
  return id;
}
