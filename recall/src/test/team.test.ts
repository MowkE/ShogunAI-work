import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { mergeDrafts } from '../core/merge.js';
import { retrieve } from '../core/retrieve.js';
import { mergeTeamEntity } from '../team/server.js';
import { repoIdFor } from '../collectors/git.js';
import type { DraftEntity, Entity } from '../core/schema.js';

test('repo identity lets a teammate on a different path retrieve team knowledge for the same repo', async () => {
  const myRepo = repoIdFor(process.cwd().replace(/\/recall$/, ''));
  if (!myRepo) return; // this checkout has no origin — skip
  const teammate = new Store(':memory:');
  const draft: DraftEntity & { repo?: string } = { type: 'decision', scope: 'team', sensitivity: 'internal', projectPath: '/Users/teammate/work/clone', repo: myRepo,
    provenance: [{ source: 'agent', observedAt: '2026-08-01T00:00:00Z' }], title: 'Keep the KB in SQLite', context: '', choice: 'node:sqlite with FTS5, no native deps', alternatives: ['better-sqlite3', 'postgres'], consequences: [], status: 'active', confidence: 0.8 };
  await mergeDrafts(teammate, [draft]);
  const cwdHere = process.cwd().replace(/\/recall$/, '');
  const hits = retrieve(teammate, { intent: 'which database should the knowledge base use', cwd: cwdHere, types: ['decision'] });
  assert.ok(hits.length === 1, 'entity from another machine path matched via repo id');
  assert.equal((hits[0].entity as { title: string }).title, 'Keep the KB in SQLite');
  teammate.close();
});

test('team server merge is idempotent and unions provenance', () => {
  const s = new Store(':memory:');
  const base: Entity = { id: 'e1', type: 'rule', scope: 'project', sensitivity: 'internal', projectPath: '/a', provenance: [{ source: 'pr', prNumber: 1, observedAt: '2026-08-01T00:00:00Z' }],
    validity: { firstSeen: '2026-08-01T00:00:00Z', lastConfirmed: '2026-08-01T00:00:00Z', evidence: 1, confidence: 0.6, decayHalfLifeDays: 180, usefulness: 0 }, paths: ['x.ts'], text: 'never log tokens', ruleText: 'Never log the raw Authorization header', category: 'safety', appliesTo: { paths: ['x.ts'] }, enforcement: 'inform' };
  assert.equal(mergeTeamEntity(s, base, 'alice'), 'inserted');
  assert.equal(mergeTeamEntity(s, base, 'alice'), 'merged');
  const again = { ...base, provenance: [{ source: 'claude-code' as const, sessionId: 's9', observedAt: '2026-08-02T00:00:00Z' }], validity: { ...base.validity, evidence: 2, lastConfirmed: '2026-08-02T00:00:00Z' } };
  assert.equal(mergeTeamEntity(s, again, 'bob'), 'merged');
  const e = s.getEntity('e1')!;
  assert.equal(e.scope, 'team');
  assert.equal(e.provenance.length, 2, 'provenance unioned');
  assert.ok(e.validity.evidence >= 2);
  s.close();
});
