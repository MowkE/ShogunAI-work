#!/usr/bin/env node
// recall-hook <event>: Node fallback for Claude Code hooks (the compiled bun shim forwards to the daemon first).
// Reads hook JSON on stdin, prints a JSON response. Never crashes the agent: any failure → exit 0 with no output.
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store, defaultDbPath } from '../core/store.js';
import { hashingEmbedder } from '../core/embed.js';
import { handleHook, type HookInput } from './hook-logic.js';
import { daemonCall, ensureDaemon } from './daemon.js';
import { ingest } from '../extract/ingest.js';

const LOG = join(homedir(), '.recall', 'hook.log');
function log(msg: string) { try { mkdirSync(join(homedir(), '.recall'), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } }

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = ''; process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 1500);
  });
}

async function main() {
  const event = process.argv[2] ?? '';
  const raw = await readStdin();
  let input: HookInput = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const t0 = Date.now();
  // 1) try the daemon (warm store + transformer embeddings)
  try {
    const out = await daemonCall<Record<string, unknown> | null>('/hook', { event, input }, 1500);
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
    log(`${event}: via daemon in ${Date.now() - t0}ms`);
    return;
  } catch { ensureDaemon(); }
  // 2) local fallback (lexical retrieval; heuristic ingest)
  if (!Store.exists(defaultDbPath()) && event !== 'ingest') return;
  const store = new Store();
  try {
    const out = await handleHook(store, hashingEmbedder, event, input, { onIngest: (paths) => { void ingest(store, { paths, llm: null, embedder: hashingEmbedder }).then((r) => log(`ingest(local): ${JSON.stringify(r)}`)); } });
    if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
    log(`${event}: local fallback in ${Date.now() - t0}ms`);
  } catch (e) { log(`error in ${event}: ${(e as Error).stack ?? e}`); }
  finally { if (event !== 'ingest') store.close(); }
}

main().then(() => { if (process.argv[2] !== 'ingest') process.exit(0); }).catch(() => process.exit(0));
