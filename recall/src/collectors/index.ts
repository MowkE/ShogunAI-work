// Collector registry: every transcript source implements discover() + readSession(); ingest is agent-agnostic.
import type { CanonicalEvent, SourceRef } from '../core/schema.js';
import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';
import * as cursor from './cursor.js';

export interface TranscriptCollector {
  id: string;
  discover(): SourceRef[];
  readSession(ref: SourceRef): { events: CanonicalEvent[]; cwd?: string; branch?: string; model?: string };
}

export const COLLECTORS: Record<string, TranscriptCollector> = {
  'claude-code': { id: 'claude-code', discover: () => claudeCode.discover(), readSession: claudeCode.readSession },
  codex: { id: 'codex', discover: codex.discover, readSession: codex.readSession },
  cursor: { id: 'cursor', discover: cursor.discover, readSession: cursor.readSession },
};

export function discoverAll(only?: string[]): SourceRef[] {
  const out: SourceRef[] = [];
  for (const [id, c] of Object.entries(COLLECTORS)) {
    if (only && !only.includes(id)) continue;
    try { out.push(...c.discover()); } catch { /* collector unavailable on this machine */ }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function readAny(ref: SourceRef) {
  const c = COLLECTORS[ref.collector];
  if (!c) throw new Error(`unknown collector ${ref.collector}`);
  return c.readSession(ref);
}
