import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../core/redact.js';
import { HashingEmbedder, cosine } from '../core/embed.js';
import { Store } from '../core/store.js';
import { mergeDrafts } from '../core/merge.js';
import { retrieve, formatContext } from '../core/retrieve.js';
import { segmentSession } from '../extract/segment.js';
import { heuristicExtract } from '../extract/heuristic.js';
import type { CanonicalEvent, DraftEntity } from '../core/schema.js';

test('redaction replaces common secrets and keeps code paths', () => {
  const s = 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and AWS AKIAIOSFODNN7EXAMPLE and ghp_' + 'a'.repeat(40) + ' path src/auth/index.ts sha 3b1f2c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c';
  const r = redact(s);
  assert.ok(!r.text.includes('sk-ant-api03'), 'anthropic key removed');
  assert.ok(!r.text.includes('AKIAIOSFODNN7EXAMPLE'), 'aws key removed');
  assert.ok(!r.text.includes('ghp_aaaa'), 'github token removed');
  assert.ok(r.text.includes('src/auth/index.ts'), 'paths kept');
  assert.ok(r.text.includes('3b1f2c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c'), 'git sha kept');
  assert.ok(r.report.total >= 3);
});

test('hashing embedder is deterministic and similarity is sane', () => {
  const e = new HashingEmbedder(256);
  const a = e.embedSync('auth middleware rejects valid session token');
  const b = e.embedSync('session token rejected by the auth middleware');
  const c = e.embedSync('css grid layout for the pricing page');
  assert.ok(cosine(a, b) > cosine(a, c));
  assert.deepEqual(a, e.embedSync('auth middleware rejects valid session token'));
});

function fakeSession(): CanonicalEvent[] {
  const ts = '2026-08-01T10:00:00Z';
  return [
    { t: 'meta', cwd: '/repo', agent: 'claude-code', ts, id: 'meta' },
    { t: 'user', text: 'Fix the auth middleware: valid sessions get rejected after refresh', ts, id: 'u1' },
    { t: 'assistant', text: 'Looking', ts, id: 'a1' },
    { t: 'tool_call', name: 'Read', input: { file_path: '/repo/src/routes/login.ts' }, id: 'c1', ts },
    { t: 'tool_result', callId: 'c1', output: '...', isError: false, ts, id: 'r1' },
    { t: 'tool_call', name: 'Edit', input: { file_path: '/repo/src/middleware/auth.ts', old_string: 'a', new_string: 'b' }, id: 'c2', ts },
    { t: 'tool_result', callId: 'c2', output: 'ok', isError: false, ts, id: 'r2' },
    { t: 'user', text: "No, don't touch the routes file — the bug is only in the middleware", ts, id: 'u2' },
    { t: 'assistant', text: 'Reverted', ts, id: 'a2' },
    { t: 'tool_call', name: 'Bash', input: { command: 'npm test' }, id: 'c3', ts },
    { t: 'tool_result', callId: 'c3', output: 'passed', isError: false, ts, id: 'r3' },
    { t: 'user', text: 'thanks, looks good', ts, id: 'u3' },
    { t: 'user', text: 'Now add a dark mode toggle to the settings page', ts, id: 'u4' },
    { t: 'tool_call', name: 'Write', input: { file_path: '/repo/src/ui/settings.tsx', content: 'x' }, id: 'c4', ts },
    { t: 'tool_result', callId: 'c4', output: 'ok', isError: false, ts, id: 'r4' },
  ];
}

test('segmenter splits at substantive prompts, keeps corrections attached, infers outcome', () => {
  const segs = segmentSession('sess1', '/repo', fakeSession());
  assert.equal(segs.length, 2);
  assert.equal(segs[0].filesMutated[0], 'src/middleware/auth.ts');
  assert.deepEqual(segs[0].filesRead, ['src/routes/login.ts']);
  assert.equal(segs[0].corrections.length, 1);
  assert.equal(segs[0].outcome, 'accepted');
  assert.equal(segs[1].userPrompt.startsWith('Now add a dark mode'), true);
});

test('heuristic extraction → merge → retrieve → format, with dedup on re-ingest', async () => {
  const store = new Store(':memory:');
  const segs = segmentSession('sess1', '/repo', fakeSession());
  const drafts: DraftEntity[] = segs.flatMap(heuristicExtract);
  const r1 = await mergeDrafts(store, drafts);
  assert.ok(r1.inserted >= 3, 'pointer + subject + rule inserted');
  const r2 = await mergeDrafts(store, segs.flatMap(heuristicExtract));
  assert.equal(r2.inserted, 0, 're-ingest merges rather than duplicating');
  const hits = retrieve(store, { intent: 'sessions rejected by auth middleware after refresh', cwd: '/repo' });
  assert.ok(hits.length > 0);
  const top = hits[0].entity;
  assert.ok(['pointer', 'subject', 'rule'].includes(top.type));
  const ctx = formatContext(hits);
  assert.ok(ctx.startsWith('<recall-context'));
  assert.ok(ctx.includes('src/middleware/auth.ts'));
  // verifier flags a path that does not exist on this machine
  assert.ok(hits.some((h) => h.verified === false));
  // feedback moves usefulness
  store.recordFeedback(top.id, 'useful');
  assert.ok(store.getEntity(top.id)!.validity.usefulness > 0);
  store.close();
});
