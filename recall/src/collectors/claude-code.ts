// Collector for Claude Code transcripts: ~/.claude/projects/<slug>/<session>.jsonl(.gz)
// The JSONL format is internal to Claude Code and may change; this adapter is defensive and versioned.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { CanonicalEvent, SourceRef } from '../core/schema.js';

export const CLAUDE_CODE_ADAPTER_VERSION = '2026-08-16';

export function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

/** Claude Code encodes the cwd as a slug with non-alphanumerics -> '-'. We recover the best guess. */
export function slugToPath(slug: string): string {
  return slug.replace(/^-/, '/').replace(/-/g, '/');
}

export function discover(dir = claudeProjectsDir()): SourceRef[] {
  if (!existsSync(dir)) return [];
  const out: SourceRef[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const pdir = join(dir, d.name);
    let files: string[] = [];
    try { files = readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!(f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))) continue;
      const p = join(pdir, f);
      let st; try { st = statSync(p); } catch { continue; }
      out.push({
        collector: 'claude-code',
        sessionId: basename(f).replace(/\.jsonl(\.gz)?$/, ''),
        projectPath: slugToPath(d.name),
        path: p,
        mtimeMs: st.mtimeMs,
        sizeBytes: st.size,
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

interface RawLine {
  type?: string; uuid?: string; parentUuid?: string | null; timestamp?: string; sessionId?: string;
  isSidechain?: boolean; isMeta?: boolean; cwd?: string; gitBranch?: string; subtype?: string;
  message?: { role?: string; model?: string; content?: string | RawBlock[] };
}
type RawBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | { type: string; text?: string }[]; is_error?: boolean };

const STRIP_TAGS = /<(command-name|command-message|command-args|local-command-caveat|local-command-stdout|system-reminder|ide_opened_file|ide_selection|ide_diagnostics|task-notification|antml:function_calls|antml:invoke)>[\s\S]*?<\/\1>/g;

export function readSession(ref: SourceRef): { events: CanonicalEvent[]; cwd?: string; branch?: string; model?: string } {
  const raw = ref.path.endsWith('.gz') ? gunzipSync(readFileSync(ref.path)).toString('utf-8') : readFileSync(ref.path, 'utf-8');
  const events: CanonicalEvent[] = [];
  let cwd: string | undefined, branch: string | undefined, model: string | undefined;
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: RawLine; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue; // subagent traffic; ingest later as its own source
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.gitBranch && !branch) branch = o.gitBranch;
    const ts = o.timestamp ?? '';
    const id = o.uuid ?? `l${n++}`;
    if (o.type === 'user') {
      const c = o.message?.content;
      if (typeof c === 'string') {
        const text = c.replace(STRIP_TAGS, '').trim();
        if (text && !o.isMeta) events.push({ t: 'user', text, ts, id });
      } else if (Array.isArray(c)) {
        const texts: string[] = [];
        for (const b of c) {
          if (b.type === 'tool_result') {
            const out = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n');
            events.push({ t: 'tool_result', callId: b.tool_use_id, output: out.slice(0, 20000), isError: !!b.is_error, ts, id: id + ':r' });
          } else if (b.type === 'text') texts.push(b.text);
        }
        const text = texts.join('\n').replace(STRIP_TAGS, '').trim();
        if (text && !o.isMeta) events.push({ t: 'user', text, ts, id });
      }
    } else if (o.type === 'assistant') {
      if (o.message?.model && !model) model = o.message.model;
      const c = o.message?.content;
      const blocks: RawBlock[] = typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? []);
      const texts: string[] = []; const thinks: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'thinking') thinks.push(b.thinking);
        else if (b.type === 'tool_use') events.push({ t: 'tool_call', name: b.name, input: b.input, id: b.id, ts, parentId: id });
      }
      if (texts.length || thinks.length) events.push({ t: 'assistant', text: texts.join('\n') || undefined, thinking: thinks.join('\n') || undefined, ts, id });
    }
  }
  if (events.length) events.unshift({ t: 'meta', cwd, branch, model, agent: 'claude-code', ts: events[0].ts, id: 'meta' });
  return { events, cwd, branch, model };
}
