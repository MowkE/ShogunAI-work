// Collector for Cursor (Composer/Agent chats). Data lives in the app's globalStorage SQLite:
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb  (table cursorDiskKV)
//   composerData:<composerId>  → { fullConversationHeadersOnly: [{bubbleId, type}], createdAt, name, context, ... }
//   bubbleId:<composerId>:<bubbleId> → { type: 1 user | 2 assistant, text, toolFormerData{name, rawArgs, result, status}, ... }
// Opened read-only; the DB is a WAL database that Cursor keeps open, which is fine for readers.
// Each composer becomes one "session"; the SourceRef.path encodes db path + composerId.

import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalEvent, SourceRef } from '../core/schema.js';

export const CURSOR_ADAPTER_VERSION = '2026-08-16';

export function cursorGlobalDb(): string | null {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const home = homedir();
  const cands = platform() === 'darwin' ? [join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
    : platform() === 'win32' ? [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
    : [join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
  return cands.find(existsSync) ?? null;
}

interface Header { bubbleId: string; type: number }
interface Composer { composerId: string; createdAt?: number; lastUpdatedAt?: number; name?: string; fullConversationHeadersOnly?: Header[]; context?: { fileSelections?: { uri?: { path?: string } }[] } }
interface Bubble { type: number; text?: string; toolFormerData?: { name?: string; rawArgs?: string; params?: string; result?: string; status?: string; toolCallId?: string }; relevantFiles?: string[]; createdAt?: string }

export function discover(): SourceRef[] {
  const dbPath = cursorGlobalDb();
  if (!dbPath) return [];
  let db: DatabaseSync; try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return []; }
  const out: SourceRef[] = [];
  try {
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as { key: string; value: string | null }[];
    const st = statSync(dbPath);
    for (const r of rows) {
      if (!r.value) continue;
      let c: Composer; try { c = JSON.parse(r.value); } catch { continue; }
      const n = c.fullConversationHeadersOnly?.length ?? 0;
      if (n < 3) continue;
      const updated = c.lastUpdatedAt ?? c.createdAt ?? st.mtimeMs;
      out.push({ collector: 'cursor', sessionId: c.composerId, projectPath: '', path: `${dbPath}#${c.composerId}`, mtimeMs: updated, sizeBytes: n });
    }
  } catch { /* table missing */ } finally { db.close(); }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function argsOf(tf: NonNullable<Bubble['toolFormerData']>): Record<string, unknown> {
  for (const s of [tf.rawArgs, tf.params]) { if (typeof s === 'string') { try { return JSON.parse(s); } catch { /* next */ } } }
  return {};
}

/** Infer the workspace root: an absolute path that contains a known relative path's first segment pins the root exactly. */
function inferRoot(absPaths: string[], relPaths: string[]): string | undefined {
  const votes = new Map<string, number>();
  for (const r of relPaths) {
    const seg = r.split('/')[0]; if (!seg || r.startsWith('/')) continue;
    for (const a of absPaths) { const i = a.indexOf(`/${seg}/`); if (i > 0) { const root = a.slice(0, i); votes.set(root, (votes.get(root) ?? 0) + 1); } }
  }
  const best = [...votes.entries()].sort((x, y) => y[1] - x[1])[0];
  return best?.[0] ?? commonDir(absPaths);
}

function commonDir(paths: string[]): string | undefined {
  const abs = paths.filter((p) => p.startsWith('/')).map((p) => dirname(p).split('/'));
  if (!abs.length) return undefined;
  let pref = abs[0];
  for (const p of abs.slice(1)) { let i = 0; while (i < pref.length && i < p.length && pref[i] === p[i]) i++; pref = pref.slice(0, i); }
  const d = pref.join('/');
  return d.length > 1 ? d : undefined;
}

export function readSession(ref: SourceRef): { events: CanonicalEvent[]; cwd?: string; branch?: string; model?: string } {
  const [dbPath, composerId] = ref.path.split('#');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const events: CanonicalEvent[] = [];
  const absPaths: string[] = []; const relPaths: string[] = [];
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`) as { value: string } | undefined;
    if (!row?.value) return { events };
    const c = JSON.parse(row.value) as Composer;
    for (const f of c.context?.fileSelections ?? []) if (f.uri?.path) absPaths.push(f.uri.path);
    const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    let n = 0;
    const baseTs = c.createdAt ? new Date(c.createdAt).toISOString() : '';
    for (const h of c.fullConversationHeadersOnly ?? []) {
      const b = get.get(`bubbleId:${composerId}:${h.bubbleId}`) as { value: string | null } | undefined;
      if (!b?.value) continue;
      let bub: Bubble; try { bub = JSON.parse(b.value); } catch { continue; }
      const ts = bub.createdAt ?? baseTs; const id = h.bubbleId || `b${n}`; n++;
      if (bub.type === 1) {
        const text = (bub.text ?? '').trim(); if (text) events.push({ t: 'user', text, ts, id });
        continue;
      }
      if (bub.type !== 2) continue;
      if (bub.text && bub.text.trim()) events.push({ t: 'assistant', text: bub.text, ts, id });
      const tf = bub.toolFormerData;
      if (tf?.name) {
        const a = argsOf(tf); const callId = tf.toolCallId ?? id + ':t';
        const target = (a.target_file ?? a.relativeWorkspacePath ?? a.relative_workspace_path ?? a.file_path ?? a.path) as string | undefined;
        if (typeof target === 'string') (target.startsWith('/') ? absPaths : relPaths).push(target);
        const name = tf.name;
        let ev: CanonicalEvent;
        if (name === 'read_file' || name === 'read_file_v2') ev = { t: 'tool_call', name: 'Read', input: { file_path: target }, id: callId, ts };
        else if (name === 'edit_file' || name === 'search_replace' || name === 'write' || name === 'delete_file' || name === 'reapply') ev = { t: 'tool_call', name: name === 'write' ? 'Write' : 'Edit', input: { file_path: target }, id: callId, ts };
        else if (name === 'run_terminal_cmd' || name === 'run_terminal_command') ev = { t: 'tool_call', name: 'Bash', input: { command: a.command }, id: callId, ts };
        else if (name === 'grep_search' || name === 'codebase_search' || name === 'file_search' || name === 'ripgrep_raw_search') ev = { t: 'tool_call', name: 'Grep', input: { pattern: a.query ?? a.pattern, path: a.target_directories }, id: callId, ts };
        else if (name === 'list_dir') ev = { t: 'tool_call', name: 'Glob', input: { path: a.relative_workspace_path ?? a.path }, id: callId, ts };
        else ev = { t: 'tool_call', name, input: a, id: callId, ts };
        events.push(ev);
        if (typeof tf.result === 'string' && tf.result) {
          // pull absolute uris out of results for cwd inference
          for (const m of tf.result.matchAll(/"uri":"(\/[^"]+)"/g)) absPaths.push(m[1]);
          events.push({ t: 'tool_result', callId, output: tf.result.slice(0, 20000), isError: tf.status === 'error', ts, id: id + ':r' });
        }
      }
    }
  } finally { db.close(); }
  const cwd = inferRoot(absPaths, relPaths);
  if (events.length) events.unshift({ t: 'meta', cwd, agent: 'cursor', ts: events[0].ts, id: 'meta' });
  return { events, cwd };
}
