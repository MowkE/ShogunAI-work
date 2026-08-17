import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromCommits, gitLog, isGitRepo } from '../collectors/git.js';
import { extractFromPRs } from '../collectors/github.js';
import { Store } from '../core/store.js';
import { mergeDrafts } from '../core/merge.js';
import { retrieve } from '../core/retrieve.js';

test('commits → pointers + decision candidates + co-change subjects', async () => {
  const commits = [
    { sha: 'a1', author: 'x', date: '2026-08-01T00:00:00Z', subject: 'fix(auth): refresh token rotation rejected valid sessions', body: 'Rotate on the server instead of the client because the client clock skews.', files: ['src/middleware/auth.ts', 'src/lib/tokens.ts', 'test/auth.test.ts'] },
    { sha: 'a2', author: 'x', date: '2026-08-02T00:00:00Z', subject: 'feat(auth): add session revocation endpoint', body: '', files: ['src/middleware/auth.ts', 'src/lib/tokens.ts', 'src/routes/session.ts'] },
    { sha: 'a3', author: 'x', date: '2026-08-03T00:00:00Z', subject: 'chore(auth): tighten token expiry', body: '', files: ['src/middleware/auth.ts', 'src/lib/tokens.ts'] },
    { sha: 'a4', author: 'x', date: '2026-08-04T00:00:00Z', subject: 'wip', body: '', files: ['x.ts'] },
  ];
  const drafts = extractFromCommits('/repo', commits);
  const types = drafts.map((d) => d.type);
  assert.equal(types.filter((t) => t === 'pointer').length, 3, 'wip commit skipped');
  assert.ok(types.includes('decision'), 'because-clause body → decision candidate');
  assert.ok(types.includes('subject'), 'auth.ts + tokens.ts co-change ≥3 → subject');
  const store = new Store(':memory:');
  await mergeDrafts(store, drafts);
  const hits = retrieve(store, { intent: 'refresh token rotation bug: valid sessions rejected', cwd: '/repo', types: ['pointer'] });
  assert.ok(hits.length && (hits[0].entity as { targets: { path: string }[] }).targets.some((t) => t.path === 'src/middleware/auth.ts'));
  store.close();
});

test('PR review comments → rules (correction-shaped only), PRs → pointers', () => {
  const prs = [{ number: 12, title: 'Add rate limiting to login', body: 'Closes #3', author: 'alice', mergedAt: '2026-08-05T00:00:00Z', createdAt: '2026-08-04T00:00:00Z', files: ['src/routes/login.ts', 'src/lib/ratelimit.ts'] }];
  const comments = [
    { prNumber: 12, path: 'src/routes/login.ts', line: 40, body: 'Please use the shared `rateLimit()` helper from lib instead of hand-rolling the window logic here.', author: 'bob', createdAt: '2026-08-04T10:00:00Z', kind: 'inline' as const },
    { prNumber: 12, path: 'src/lib/ratelimit.ts', line: 3, body: 'LGTM 👍', author: 'bob', createdAt: '2026-08-04T10:01:00Z', kind: 'inline' as const },
    { prNumber: 12, path: '', body: 'Never log the raw Authorization header — this leaks tokens into our log pipeline.', author: 'carol', createdAt: '2026-08-04T11:00:00Z', kind: 'review' as const },
  ];
  const drafts = extractFromPRs('/repo', prs, comments);
  const rules = drafts.filter((d) => d.type === 'rule') as { ruleText: string; category: string; appliesTo: { paths?: string[] } }[];
  assert.equal(rules.length, 2, 'LGTM comment is not a rule');
  assert.ok(rules.some((r) => r.category === 'safety'), 'token-leak comment categorized as safety');
  assert.ok(rules.some((r) => r.appliesTo.paths?.includes('src/routes/login.ts')));
  assert.equal(drafts.filter((d) => d.type === 'pointer').length, 1);
});

test('gitLog parses this repository', () => {
  const repo = process.cwd().replace(/\/recall$/, '');
  if (!isGitRepo(repo)) return;
  const commits = gitLog(repo, 5);
  assert.ok(commits.length >= 1);
  assert.ok(commits[0].sha.length === 40 && commits[0].subject.length > 0);
});
