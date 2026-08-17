import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as codex from '../collectors/codex.js';
import * as cursor from '../collectors/cursor.js';
import { segmentSession } from '../extract/segment.js';

test('codex rollout → canonical events (exec_command→Bash, apply_patch→Edit/Write per file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-codex-'));
  const p = join(dir, 'rollout-2026-08-01T10-00-00-019d5128-3e51-7c33-92fa-10520a2e8086.jsonl');
  const L = (o: unknown) => JSON.stringify(o);
  writeFileSync(p, [
    L({ timestamp: 't0', type: 'session_meta', payload: { id: 'x', cwd: '/repo', originator: 'Codex CLI' } }),
    L({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] } }),
    L({ timestamp: 't2', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the shooter RPM calc, it overshoots at long range' } }),
    L({ timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg RPM src', workdir: '/repo' }), call_id: 'c1' } }),
    L({ timestamp: 't4', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nsrc/Shooter.java:12' } }),
    L({ timestamp: 't5', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: /repo/src/Shooter.java\n@@\n-a\n+b\n*** Add File: /repo/src/Table.java\n+x\n*** End Patch' } }),
    L({ timestamp: 't6', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM src/Shooter.java\nA src/Table.java' } }),
    L({ timestamp: 't7', type: 'event_msg', payload: { type: 'agent_message', message: 'Done — RPM now interpolates from a distance table.' } }),
    L({ timestamp: 't8', type: 'event_msg', payload: { type: 'user_message', message: 'thanks, works' } }),
  ].join('\n'));
  const ref = { collector: 'codex', sessionId: '019d5128-3e51-7c33-92fa-10520a2e8086', projectPath: '', path: p, mtimeMs: 0, sizeBytes: 1 };
  const s = codex.readSession(ref);
  assert.equal(s.cwd, '/repo');
  const names = s.events.filter((e) => e.t === 'tool_call').map((e) => (e as { name: string }).name);
  assert.deepEqual(names, ['Bash', 'Edit', 'Write']);
  const segs = segmentSession(ref.sessionId, '/repo', s.events);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].filesMutated.sort(), ['src/Shooter.java', 'src/Table.java']);
  assert.equal(segs[0].outcome, 'accepted');
  assert.equal(segs[0].agent, 'codex');
});

test('cursor globalStorage → canonical events, cwd inferred from absolute paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-cursor-'));
  const dbp = join(dir, 'state.vscdb'); mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbp);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)');
  const cid = 'comp-1';
  ins.run(`composerData:${cid}`, JSON.stringify({ composerId: cid, createdAt: 1749661953697, name: 'Improve buttons',
    fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }, { bubbleId: 'b4', type: 2 }],
    context: { fileSelections: [{ uri: { path: '/Users/me/proj/chemistry/index.html' } }] } }));
  ins.run(`bubbleId:${cid}:b1`, JSON.stringify({ type: 1, text: 'the buttons look bad, make them blend into the background' }));
  ins.run(`bubbleId:${cid}:b2`, JSON.stringify({ type: 2, toolFormerData: { name: 'read_file', rawArgs: JSON.stringify({ target_file: 'chemistry/css/style.css' }), result: '{"contents":"..."}', status: 'completed', toolCallId: 't1' } }));
  ins.run(`bubbleId:${cid}:b3`, JSON.stringify({ type: 2, toolFormerData: { name: 'edit_file', rawArgs: JSON.stringify({ target_file: 'chemistry/css/style.css', instructions: 'restyle' }), result: '{"diff":"..."}', status: 'completed', toolCallId: 't2' } }));
  ins.run(`bubbleId:${cid}:b4`, JSON.stringify({ type: 2, text: 'Updated the button styles.' }));
  db.close();
  process.env.CURSOR_STATE_DB = dbp;
  const refs = cursor.discover();
  assert.equal(refs.length, 1);
  const s = cursor.readSession(refs[0]);
  assert.equal(s.cwd, '/Users/me/proj');
  const names = s.events.filter((e) => e.t === 'tool_call').map((e) => (e as { name: string }).name);
  assert.deepEqual(names, ['Read', 'Edit']);
  const segs = segmentSession(cid, s.cwd!, s.events);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].filesMutated, ['chemistry/css/style.css']);
  delete process.env.CURSOR_STATE_DB;
});
