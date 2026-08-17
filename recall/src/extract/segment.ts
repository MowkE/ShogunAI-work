import { createHash } from 'node:crypto';
import type { CanonicalEvent, Segment } from '../core/schema.js';

const CORRECTION_RE = /^(no[,.! ]|nope|don't|do not|stop|wrong|not that|that's (wrong|not)|actually|instead|never|why did you|you should(n't| not)|please don't|undo|revert|that broke|didn't ask|i said|i told you|not what i)/i;
const ACCEPT_RE = /^(thanks|thank you|great|perfect|nice|looks good|lgtm|good|awesome|ok(ay)?[,.! ]|yes[,.! ]|ship it|done)/i;
const TRIVIAL_RE = /^(y|n|yes|no|ok|okay|sure|continue|go|go ahead|proceed|k|thanks|thank you|\d+)[.!]?$/i;

function relPath(p: unknown, cwd?: string): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/** Split a session's events into task segments at substantive user prompts. */
export function segmentSession(sessionId: string, projectPath: string, events: CanonicalEvent[]): Segment[] {
  const meta = events.find((e) => e.t === 'meta') as Extract<CanonicalEvent, { t: 'meta' }> | undefined;
  const cwd = meta?.cwd ?? projectPath;
  const agent = meta?.agent ?? 'unknown';
  const segs: Segment[] = [];
  let cur: Segment | null = null;

  const finish = () => {
    if (!cur) return;
    // outcome heuristics: last user turn in segment / presence of edits
    const users = cur.events.filter((e) => e.t === 'user') as Extract<CanonicalEvent, { t: 'user' }>[];
    const last = users[users.length - 1];
    if (cur.corrections.length && !ACCEPT_RE.test(last?.text ?? '')) cur.outcome = 'partial';
    else if (last && ACCEPT_RE.test(last.text)) cur.outcome = 'accepted';
    else if (cur.filesMutated.length) cur.outcome = 'accepted';
    else cur.outcome = cur.events.length > 4 ? 'partial' : 'unknown';
    cur.filesRead = [...new Set(cur.filesRead)];
    cur.filesMutated = [...new Set(cur.filesMutated)];
    cur.commands = [...new Set(cur.commands)].slice(0, 30);
    if (cur.events.length >= 2) segs.push(cur);
    cur = null;
  };

  let lastAssistantId: string | undefined;
  for (const e of events) {
    if (e.t === 'meta') continue;
    if (e.t === 'user') {
      const trivial = TRIVIAL_RE.test(e.text.trim());
      const isCorrection = !!cur && CORRECTION_RE.test(e.text.trim());
      const isAccept = !!cur && ACCEPT_RE.test(e.text.trim()) && e.text.length < 80;
      // A substantive prompt that is not a correction/acceptance/continuation starts a new segment.
      if (!cur || (!trivial && !isCorrection && !isAccept && e.text.length > 12)) {
        finish();
        cur = {
          id: '', sessionId, projectPath, agent, startedAt: e.ts, events: [], userPrompt: e.text.replace(/\s+/g, ' ').trim(),
          outcome: 'unknown', filesRead: [], filesMutated: [], commands: [], corrections: [],
        };
        cur.id = createHash('sha1').update(`${sessionId}:${e.id}:${e.text.slice(0, 200)}`).digest('hex').slice(0, 16);
      }
      if (cur && isCorrection) cur.corrections.push({ text: e.text.slice(0, 600), afterEventId: lastAssistantId ?? '', ts: e.ts });
      cur!.events.push(e);
      continue;
    }
    if (!cur) continue;
    cur.events.push(e);
    if (e.t === 'assistant') lastAssistantId = e.id;
    if (e.t === 'tool_call') {
      const inp = (e.input ?? {}) as Record<string, unknown>;
      const p = relPath(inp.file_path ?? inp.path ?? inp.notebook_path, cwd);
      switch (e.name) {
        case 'Read': case 'Grep': case 'Glob': case 'NotebookRead':
          if (p) cur.filesRead.push(p); break;
        case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
          if (p) cur.filesMutated.push(p); break;
        case 'Bash': {
          const c = typeof inp.command === 'string' ? inp.command : '';
          if (c) cur.commands.push(c.slice(0, 200));
          break;
        }
        default: break;
      }
    }
  }
  finish();
  return segs;
}

/** Compact textual rendering of a segment for the LLM extractor (already-redacted events expected). */
export function renderSegment(seg: Segment, maxChars = 24000): string {
  const lines: string[] = [];
  lines.push(`# Session ${seg.sessionId.slice(0, 8)} · project ${seg.projectPath} · agent ${seg.agent} · started ${seg.startedAt}`);
  for (const e of seg.events) {
    if (e.t === 'user') lines.push(`\n[USER ${e.id.slice(0, 8)}] ${e.text.slice(0, 2500)}`);
    else if (e.t === 'assistant') {
      if (e.text) lines.push(`[ASSISTANT ${e.id.slice(0, 8)}] ${e.text.slice(0, 1800)}`);
    } else if (e.t === 'tool_call') {
      const inp = (e.input ?? {}) as Record<string, unknown>;
      const brief = e.name === 'Bash' ? String(inp.command ?? '').slice(0, 300)
        : e.name === 'Edit' || e.name === 'MultiEdit' ? `${inp.file_path} (edit)`
        : e.name === 'Write' ? `${inp.file_path} (write ${String(inp.content ?? '').length} chars)`
        : e.name === 'Read' ? `${inp.file_path}`
        : e.name === 'Grep' ? `grep ${inp.pattern} in ${inp.path ?? '.'}`
        : JSON.stringify(inp).slice(0, 200);
      lines.push(`[TOOL ${e.name}] ${brief}`);
    } else if (e.t === 'tool_result') {
      if (e.isError) lines.push(`[TOOL_ERROR] ${e.output.slice(0, 500)}`);
      else if (e.output.length) lines.push(`[TOOL_RESULT] ${e.output.slice(0, 350).replace(/\n+/g, ' ⏎ ')}${e.output.length > 350 ? ' …' : ''}`);
    }
  }
  let s = lines.join('\n');
  if (s.length > maxChars) s = s.slice(0, maxChars) + '\n…[truncated]';
  return s;
}
