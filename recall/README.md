# Recall

**Local-first knowledge layer for coding agents.** Recall learns from the agent sessions you already have on disk, turns them into verified, provenance-tracked knowledge (where to look, rules from your corrections, procedures that worked, decisions in force), and injects the right slice back into future sessions — automatically, through Claude Code hooks, an MCP server, and compiled rules files.

Status: **v0.1 vertical slice** (built 2026-08-16). Works end-to-end on real Claude Code transcripts. See `../RECALL_IMPLEMENTATION_PLAN.md` for the full 12-week plan and `../GODHANDS_ANALYSIS.md` for the competitive analysis it grew out of.

## What it does today

```
~/.claude/projects/**/*.jsonl ──► collector ──► redactor ──► segmenter ──► extractors ──► merger ──► SQLite KB
                                                                     (heuristic + LLM)              │
   Claude Code hooks (SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · SessionEnd) ◄─────┤
   MCP server (recall_search · recall_explain · recall_remember · recall_feedback)               ◄─────┤
   Compiled rules (.claude/rules/recall.md · .cursor/rules/recall.mdc · AGENTS.md)               ◄─────┘
```

- **Zero-click injection**: `UserPromptSubmit` hook retrieves in ~250 ms (no LLM on the hot path) and returns a `<recall-context>` block; `SessionStart` injects a project brief; `PreToolUse` can warn/deny on high-confidence rules; `PostToolUse` records which injected entries the agent actually acted on; `SessionEnd` ingests the finished session (real-time learning).
- **Local-first**: the KB is a SQLite file (`~/.recall/recall.db`, `node:sqlite` — no native builds). Raw transcripts are never copied into it; entities point back to session/message ids. Secrets are redacted before any model call.
- **Two model adapters** behind one interface: `claude -p` (uses your Claude Code login; default when no key) and the Anthropic SDK with structured outputs (`ANTHROPIC_API_KEY` or `ant auth login`; default model `claude-opus-5`).
- **Truth maintenance**: every entity has provenance, evidence count, confidence, decay half-life and — for path-anchored entities — a read-time check against the working tree; stale pointers are caveated and down-ranked.
- **Feedback loop**: `used`/`useful`/`wrong` signals move a per-entity usefulness score that feeds ranking and compile selection.
- **Warm daemon** (`recall daemon start`): keeps SQLite + a local transformer embedder (`Xenova/bge-small-en-v1.5`, 384-d, ~3 ms/embed) hot on `127.0.0.1:47821`, watches `~/.claude/projects` and ingests new sessions ~15 s after they stop writing. Hooks call it (≈100 ms retrieval) and fall back to in-process lexical retrieval if it is down (auto-restarting it).
- **Agent collectors:** Claude Code, **Codex CLI/Desktop** (`~/.codex/sessions` rollouts) and **Cursor** (globalStorage composers) — all normalized to one canonical event stream, so extraction/eval are agent-agnostic. `recall doctor` shows what it found.
- **Git + GitHub PR collectors** (`recall ingest-repo`): commit history → pointers/decision candidates/co-change subjects; PR review comments (via your `gh` auth) → correction-shaped **rules** scoped to the commented file; PRs → pointers.
- **Compiled hook shim** (`hookbin/recall-hook`, built with `bun build --compile` when bun is present): forwards hook stdin to the daemon — **≈40 ms end-to-end**; execs the Node hook (and restarts the daemon) if the daemon is down.
- **Team sync (alpha):** `recall team-server` (SQLite-backed, bearer-key auth) + `recall team login|suggest|promote|push|pull`. Entities carry a machine-independent `repo` id (`github.com/owner/name`), so a teammate on a different path retrieves the same repo's knowledge. Restricted-sensitivity entities never leave the machine.
- **Eval**: `npm run eval` replays historical segments (leakage-controlled) and reports hit@1/3, precision, and a BM25-only baseline. **Measured 2026-08-16 on 622 real sessions + git history of 10 repos:** hit@1 35%, hit@3 52%, precision 0.31, vs. BM25-only hit@3 18%; transformer embeddings lifted hit@3 from 40% (lexical-only) to 52%. Hook end-to-end ≈ 340 ms (Node start dominates; retrieval ≈ 100 ms via daemon).

## Quick start

```bash
cd recall && npm install && npm run build

# build the KB from your transcripts + install hooks/MCP for the current project (project scope)
node dist/cli/index.js init --project /path/to/your/repo         # add --user to install globally
#   --no-llm            heuristic extraction only (free, seconds)
#   --llm-segments 15   how many segments to refine with the LLM in this run
#   --max-cost 5        LLM spend cap (USD, estimated)

node dist/cli/index.js search "auth middleware — why valid sessions get rejected" --cwd /path/to/repo
node dist/cli/index.js stats
node dist/cli/index.js why                  # what was injected last, and why
node dist/cli/index.js explain <id-prefix>  # provenance for an entity
node dist/cli/index.js compile              # write .claude/rules/recall.md, .cursor/rules/recall.mdc, AGENTS.md
node dist/cli/index.js inspect <session-prefix> --render   # what the segmenter/LLM sees
npm run eval                                # replay eval
```

Model selection: `RECALL_MODEL_ADAPTER=anthropic|claude-cli|none` (default `auto`: Anthropic SDK if credentials exist, else `claude -p`); `RECALL_MODEL=claude-opus-5` for the SDK adapter. `RECALL_DB` overrides the database path.

## Files

```
src/core        schema · store (SQLite/FTS5) · embed (hashing vectors; swappable) · merge · retrieve · redact · compile
src/collectors  index (registry) · claude-code · codex · cursor · git · github
src/team        server (team KB API) · client (login/promote/push/pull)
hookbin         recall-hook.ts → compiled shim (bun)
src/extract     segment · heuristic · llm (structured-output extraction) · model (adapters) · ingest (orchestrator)
src/cli         index (recall) · hook (recall-hook) · daemon (warm store + embedder + watcher)
src/mcp         server (recall-mcp)
src/eval        replay
src/test        unit tests (node:test)
```

## Design notes / known limits (v0.1)

- Collectors: Claude Code, Codex, Cursor transcripts; git; GitHub PRs. Gemini CLI / Aider / OpenCode next (none present on the dev machine to verify against).
- Embeddings: local transformer by default (`RECALL_EMBEDDER=hashing` for the zero-dependency fallback); `recall reindex` after switching.
- Heuristic entities are deliberately conservative (pointers/subjects from edits, rules from detected corrections, procedures from successful command runs); the LLM pass generalizes rules, adds decisions, root causes and decoys.
- The `PreToolUse` guard only denies for rules with `enforcement: 'block'`, confidence ≥ 0.8 and evidence ≥ 2 — none are produced automatically yet; the surface exists so promoted/team rules can use it.
- Team server is single-node SQLite with bearer keys — the API is the contract; Postgres/pgvector, RLS, and a review UI are the next steps.

License: Apache-2.0.
