// Team sync client: promote local entities to team scope, push them, pull the team KB into the local store.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store } from '../core/store.js';
import type { Entity } from '../core/schema.js';
import { type Embedder } from '../core/embed.js';
import { repoIdFor } from '../collectors/git.js';

const CFG = join(homedir(), '.recall', 'config.json');
export interface RecallConfig { team?: { url: string; key: string; author?: string; lastPull?: string } }

export function loadConfig(): RecallConfig { try { return JSON.parse(readFileSync(CFG, 'utf-8')); } catch { return {}; } }
export function saveConfig(c: RecallConfig) { mkdirSync(join(homedir(), '.recall'), { recursive: true }); writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n'); }

async function api<T>(cfg: RecallConfig, method: string, path: string, body?: unknown): Promise<T> {
  if (!cfg.team) throw new Error('not logged in: run `recall team login <url> <key>`');
  const res = await fetch(cfg.team.url.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.team.key}` }, body: body ? JSON.stringify(body) : undefined });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

/** Candidates worth promoting: strong evidence, PR-derived, or LLM-extracted rules/decisions. */
export function suggestPromotions(store: Store, projectPath?: string): Entity[] {
  const all = projectPath ? store.allEntities({ projectPath, repo: repoIdFor(projectPath) }) : store.allEntities();
  return all.filter((e) => e.scope !== 'team' && e.sensitivity !== 'restricted' && (
    e.validity.evidence >= 3 || e.provenance.some((p) => p.source === 'pr') ||
    ((e.type === 'rule' || e.type === 'decision') && e.validity.confidence >= 0.6) || e.validity.usefulness > 0.3))
    .sort((a, b) => (b.validity.evidence + b.validity.usefulness * 3) - (a.validity.evidence + a.validity.usefulness * 3));
}

export function promote(store: Store, idPrefix: string): Entity | null {
  const e = store.allEntities().find((x) => x.id.startsWith(idPrefix));
  if (!e) return null;
  e.scope = 'team'; store.upsertEntity(e); return e;
}

export async function push(store: Store, ids?: string[]): Promise<{ pushed: number; inserted: number; merged: number }> {
  const cfg = loadConfig();
  let ents = store.allEntities({ scope: 'team' });
  if (ids?.length) ents = ents.filter((e) => ids.some((p) => e.id.startsWith(p)));
  ents = ents.filter((e) => e.sensitivity !== 'restricted');
  if (!ents.length) return { pushed: 0, inserted: 0, merged: 0 };
  const r = await api<{ inserted: number; merged: number }>(cfg, 'POST', '/v1/push', { entities: ents.map((e) => ({ ...e, embedding: undefined })), author: cfg.team?.author });
  return { pushed: ents.length, ...r };
}

export async function pull(store: Store, embedder: Embedder, opts: { repo?: string; full?: boolean } = {}): Promise<{ received: number; inserted: number; updated: number }> {
  const cfg = loadConfig();
  const since = opts.full ? undefined : cfg.team?.lastPull;
  const q = new URLSearchParams(); if (since) q.set('since', since); if (opts.repo) q.set('repo', opts.repo);
  const r = await api<{ entities: Entity[]; serverTime: string }>(cfg, 'GET', `/v1/pull?${q}`);
  let inserted = 0, updated = 0;
  const texts = r.entities.map((e) => e.text);
  const vecs = texts.length ? await embedder.embedMany(texts) : [];
  r.entities.forEach((e, i) => {
    const local = store.getEntity(e.id);
    const merged: Entity = { ...e, scope: 'team', embedding: vecs[i], embeddingModel: embedder.name };
    if (local) { merged.validity.usefulness = local.validity.usefulness; updated++; } else inserted++;
    store.upsertEntity(merged);
  });
  if (cfg.team) { cfg.team.lastPull = r.serverTime; saveConfig(cfg); }
  return { received: r.entities.length, inserted, updated };
}
