# Recall — handoff notes (2026-08-16)

For whoever picks this up next (e.g. to test with a real Anthropic API key).

## What exists and works right now

- `recall/` — TypeScript, Node ≥ 22.5, zero native deps (`node:sqlite` with FTS5). Build: `cd recall && npm install && npm run build`. Tests: `node --no-warnings --test dist/test/*.test.js` (4/4 pass).
- End-to-end on real data: 622 Claude Code sessions → 939 task segments → ~575 knowledge entities (pointers with decoys, subjects, procedures, rules from corrections, decisions), 300 secrets redacted before any model saw anything.
- Injection surfaces, all exercised: Claude Code hooks (`SessionStart` brief, `UserPromptSubmit` context, `PreToolUse` guard, `PostToolUse` feedback, `SessionEnd` real-time ingest), MCP server with 4 tools, `recall compile` for `.claude/rules` / `.cursor/rules` / `AGENTS.md`.
- Hooks are installed **project-scope** in `godhandsclone/.claude/settings.json` and `godhandsclone/.mcp.json` only. Nothing was written to `~/.claude/settings.json`. `recall uninstall` removes them; `recall init --user` promotes to user scope.
- Replay eval (leakage-controlled): hit@1 35%, hit@3 52%, precision 0.31, vs. BM25-only 18% hit@3 (transformer embeddings + git history; was 41.6% at the first checkpoint).

## Running with an API key (the path not yet exercised)

The Anthropic SDK adapter (`src/extract/model.ts` → `AnthropicModel`) is implemented against the current SDK surface — `messages.create` with `output_config.format` (JSON-schema structured outputs), `cache_control` on the system block (1 h TTL), default model `claude-opus-5` — **but has not been executed against a live key in this session** (none was available). Expect at most small shape fixes on first run. Steps:

```bash
export ANTHROPIC_API_KEY=...            # or: ant auth login
cd recall && npm run build
node dist/cli/index.js doctor           # anthropicCreds should now be true
node dist/cli/index.js ingest --llm --since 30 --llm-segments 5 --max-cost 1   # smoke test
node dist/cli/index.js ingest --llm --llm-segments 400 --max-cost 40            # backfill (all projects)
node dist/cli/index.js stats && npm run eval
```

Cost model with the SDK: a segment is ≤ 14 k chars (~4 k tokens) + a ~1.5 k-token cached system prompt; at Opus 5 pricing that is roughly $0.03–0.06 per segment live (half that via Batches, which is not wired yet). The `claude -p` adapter used tonight costs ~$0.5–1.0 per segment because it carries Claude Code's own system prompt — fine for a smoke test, wrong for a backfill. `--max-cost` is enforced before each LLM call and works (stopped at $3.15 tonight after 5 segments).

## What the LLM pass adds over heuristics

Look at `node dist/cli/index.js search "onshape callouts recalibrate" --cwd ~/step0` — the LLM-refined pointer has a real outcome class, ranked targets with reasons, a decoy (`dist/content.js` is generated), the fix procedure, and the verifier flags that the path lives in a sibling repo. Heuristic entities only know "these files were edited for a prompt that looked like this".

## Known gaps (v0.1) and where they are in the plan

| Gap | Where it lives | Plan ref |
|---|---|---|
| Cursor/Codex/Aider transcript collectors | `src/collectors/` | Page 5 — git + GitHub PR collectors are done (`recall ingest-repo`); PR→rule path is fixture-tested (this machine's repos are solo, so no live review comments yet) |
| ~~Hashing embeddings~~ done: local `bge-small` via transformers.js, warm in the daemon; weights retuned (hit@3 40% → 52%) | `src/core/embed.ts` | — |
| ~~No warm daemon~~ done: `recall daemon start|stop|status`, auto-started by hooks, watches transcripts | `src/cli/daemon.ts` | Node startup (~200 ms) is now the floor; a compiled hook binary is the next step |
| Guard never denies yet | `src/cli/hook.ts` `guard` | needs rules with `enforcement: 'block'` (team/promoted rules) |
| Batches API for backfill | `src/extract/model.ts` | Page 6 |
| Team server / sync / review queue / GitHub App | not started | Pages 9–10 |
| Correction detector is regex-based | `src/extract/segment.ts` `CORRECTION_RE` | LLM pass generalizes; a dedicated classifier is planned |

## Decisions made tonight (and why)

- Single package instead of the planned monorepo split — faster to ship the vertical slice; the folder layout mirrors the planned packages so splitting later is mechanical.
- `node:sqlite` instead of better-sqlite3/sqlite-vec — no native builds on Node 25, FTS5 present; vector search is in-process cosine over stored Float32 blobs (fine at this scale).
- Hooks are project-scoped by request; the DB is per-user (`~/.recall/recall.db`) and cross-project retrieval is allowed for pointers/procedures/subjects at a penalty, never for rules/decisions unless personal-scope.
- Ranking weights were set from the replay eval, not by hand: `W_LEX 0.65 / W_VEC 0.25 / MIN 0.12`. The sweep table is in the session log; hit@3 vs precision trades off cleanly with `MIN_SCORE`.
