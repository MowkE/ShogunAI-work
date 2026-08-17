// Collector for OpenAI Codex CLI / Codex Desktop rollouts: ~/.codex/sessions/**/rollout-*.jsonl (+ archived_sessions/)
// Format (observed 2026-08): lines {timestamp, type: session_meta|turn_context|event_msg|response_item|..., payload}
//   event_msg/user_message {message}, event_msg/agent_message {message}
//   response_item/function_call {name, arguments(json), call_id}, function_call_output {call_id, output}
//   response_item/custom_tool_call {name: apply_patch, input, call_id}, custom_tool_call_output {call_id, output}
// Tool calls are normalized to canonical names (Bash/Read/Edit/Write/Grep) so downstream code is agent-agnostic.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { CanonicalEvent, SourceRef } from '../core/schema.js';

export const CODEX_ADAPTER_VERSION = '2026-08-16';

export function codexDirs(): string[] {
  const root = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return [join(root, 'sessions'), join(root, 'archived_sessions')].filter(existsSync);
}

function walk(dir: string, out: string[]) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.jsonl') && d.name.startsWith('rollout-')) out.push(p);
  }
}

export function discover(): SourceRef[] {
  const out: SourceRef[] = [];
  for (const dir of codexDirs()) {
    const files: string[] = []; try { walk(dir, files); } catch { continue; }
    for (const p of files) {
      let st; try { st = statSync(p); } catch { continue; }
      // session id: uuid at the end of the filename
      const m = basename(p).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      const sessionId = m ? m[1] : basename(p, '.jsonl');
      out.push({ collector: 'codex', sessionId, projectPath: '', path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

interface Line { timestamp?: string; type?: string; payload?: Record<string, unknown> }

function safeJson(s: unknown): Record<string, unknown> { if (typeof s !== 'string') return (s ?? {}) as Record<string, unknown>; try { return JSON.parse(s); } catch { return {}; } }

const PATCH_FILE_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;

export function readSession(ref: SourceRef): { events: CanonicalEvent[]; cwd?: string; branch?: string; model?: string } {
  const raw = readFileSync(ref.path, 'utf-8');
  const events: CanonicalEvent[] = [];
  let cwd: string | undefined; let model: string | undefined; let n = 0;
  const seenUser = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: Line; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {}; const ts = o.timestamp ?? ''; const id = `c${n++}`;
    if (o.type === 'session_meta') { if (typeof p.cwd === 'string' && !cwd) cwd = p.cwd; continue; }
    if (o.type === 'turn_context') { if (typeof p.cwd === 'string' && !cwd) cwd = p.cwd; if (typeof p.model === 'string' && !model) model = p.model; continue; }
    if (o.type === 'event_msg') {
      const t = p.type;
      if (t === 'user_message' && typeof p.message === 'string') { const text = p.message.trim(); if (text) { seenUser.add(text.slice(0, 200)); events.push({ t: 'user', text, ts, id }); } }
      else if (t === 'agent_message' && typeof p.message === 'string' && p.message.trim()) events.push({ t: 'assistant', text: p.message, ts, id });
      continue;
    }
    if (o.type === 'response_item') {
      const t = p.type;
      if (t === 'message') {
        const role = p.role; const content = Array.isArray(p.content) ? (p.content as { type: string; text?: string }[]) : [];
        const text = content.map((c) => c.text ?? '').join('\n').trim();
        if (role === 'user' && text && !seenUser.has(text.slice(0, 200)) && !/^<(permissions|environment_context|user_instructions)/.test(text)) events.push({ t: 'user', text, ts, id });
        // developer/system messages and assistant duplicates of agent_message are skipped
      } else if (t === 'function_call') {
        const name = String(p.name ?? ''); const args = safeJson(p.arguments); const callId = String(p.call_id ?? id);
        if (name === 'exec_command' || name === 'shell' || name === 'shell_command') {
          const cmd = typeof args.cmd === 'string' ? args.cmd : Array.isArray(args.command) ? (args.command as string[]).join(' ') : String(args.command ?? '');
          events.push({ t: 'tool_call', name: 'Bash', input: { command: cmd, workdir: args.workdir }, id: callId, ts });
        } else if (name === 'read_file' || name === 'view_file') {
          events.push({ t: 'tool_call', name: 'Read', input: { file_path: args.path ?? args.file_path }, id: callId, ts });
        } else if (name === 'grep' || name === 'search' || name === 'rg') {
          events.push({ t: 'tool_call', name: 'Grep', input: { pattern: args.pattern ?? args.query, path: args.path }, id: callId, ts });
        } else {
          events.push({ t: 'tool_call', name: name || 'Tool', input: args, id: callId, ts });
        }
      } else if (t === 'function_call_output') {
        events.push({ t: 'tool_result', callId: String(p.call_id ?? ''), output: String(p.output ?? '').slice(0, 20000), isError: /exited with code [1-9]|error/i.test(String(p.output ?? '').slice(0, 300)), ts, id });
      } else if (t === 'custom_tool_call') {
        const name = String(p.name ?? ''); const callId = String(p.call_id ?? id);
        if (name === 'apply_patch' && typeof p.input === 'string') {
          const files: { op: string; path: string }[] = [];
          for (const m of p.input.matchAll(PATCH_FILE_RE)) files.push({ op: m[1], path: m[2].trim() });
          if (!files.length) events.push({ t: 'tool_call', name: 'Edit', input: { patch: p.input.slice(0, 500) }, id: callId, ts });
          files.forEach((f, i) => events.push({ t: 'tool_call', name: f.op === 'Add' ? 'Write' : 'Edit', input: { file_path: f.path }, id: files.length > 1 ? `${callId}:${i}` : callId, ts }));
        } else events.push({ t: 'tool_call', name: name || 'Tool', input: { input: String(p.input ?? '').slice(0, 500) }, id: callId, ts });
      } else if (t === 'custom_tool_call_output') {
        events.push({ t: 'tool_result', callId: String(p.call_id ?? ''), output: String(p.output ?? '').slice(0, 20000), isError: /failed|error/i.test(String(p.output ?? '').slice(0, 200)), ts, id });
      }
    }
  }
  if (events.length) events.unshift({ t: 'meta', cwd, model, agent: 'codex', ts: events[0].ts, id: 'meta' });
  return { events, cwd, model };
}
