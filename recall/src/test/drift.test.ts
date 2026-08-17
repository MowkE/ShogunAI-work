import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { analyzeDrift, changedFromGit, extractSymbols, indexDocs } from '../drift/index.js';

function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); }

test('symbol extraction covers TS/Python/Go basics', () => {
  const ts = extractSymbols('a.ts', 'export function fooBar() {}\nclass Baz {}\nexport const handleIt = async (x) => x;\nexport interface Opts {}\n');
  assert.deepEqual(ts.map((s) => `${s.name}:${s.kind}:${s.exported}`), ['fooBar:function:true', 'Baz:class:false', 'Opts:type:true', 'handleIt:function:true']);
  const py = extractSymbols('b.py', 'def compute_total(x):\n  pass\nclass Cart:\n  pass\ndef _private():\n  pass\n');
  assert.deepEqual(py.map((s) => s.name), ['compute_total', '_private', 'Cart']);
  const go = extractSymbols('c.go', 'func Exported() {}\nfunc hidden() {}\ntype Thing struct{}\n');
  assert.deepEqual(go.filter((s) => s.exported).map((s) => s.name), ['Exported', 'Thing']);
});

test('drift: renamed function → stale symbol + review section; deleted path → stale path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-drift-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function validateSession(t: string) { return t.length > 3; }\nexport function helperThing() {}\n');
  writeFileSync(join(root, 'src', 'legacy.ts'), 'export function oldEntry() {}\n');
  writeFileSync(join(root, 'docs', 'auth.md'), '# Auth\n\nCall `validateSession()` from `src/auth.ts` before every request. See also `src/legacy.ts` for the old entry point.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  // rename the function, delete legacy file, docs untouched
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function verifySession(t: string) { return t.length > 3; }\nexport function helperThing() {}\nexport function brandNewExport() {}\n');
  execFileSync('rm', [join(root, 'src', 'legacy.ts')]);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'rename + delete');
  const changed = changedFromGit(root, { base: 'HEAD~1' });
  assert.ok(changed.some((c) => c.file === 'src/auth.ts'));
  assert.ok(changed.some((c) => c.file === 'src/legacy.ts' && c.status === 'D'));
  const r = await analyzeDrift(root, changed, { model: null });
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('stale_symbol'), 'validateSession no longer exists but is documented');
  assert.ok(kinds.includes('stale_path'), 'src/legacy.ts deleted but documented');
  assert.ok(kinds.includes('review_section'), 'auth.md mentions changed src/auth.ts');
  assert.ok(r.findings.some((f) => f.kind === 'undocumented_symbol' && f.code?.symbol === 'brandNewExport'));
  const docs = indexDocs(root, new Set(['verifySession', 'helperThing']), new Set(['src/auth.ts']));
  assert.equal(docs.length, 1);
});
