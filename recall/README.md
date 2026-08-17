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
- **Eval**: `npm run eval` replays historical segments (leakage-controlled) and reports hit@1/3, precision, and a BM25-only baseline. **Measured 2026-08-16 on 622 real sessions (939 segments, mostly heuristic-extracted, 5 LLM-refined):** hit@1 32.0%, hit@3 41.6%, precision 0.34, vs. BM25-only hit@3 18.8%; ~40 ms per query. Hook end-to-end (Node start + retrieve) ≈ 250 ms.

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
src/collectors  claude-code (transcript discovery + JSONL → canonical events)
src/extract     segment · heuristic · llm (structured-output extraction) · model (adapters) · ingest (orchestrator)
src/cli         index (recall) · hook (recall-hook)
src/mcp         server (recall-mcp)
src/eval        replay
src/test        unit tests (node:test)
```

## Design notes / known limits (v0.1)

- Only the Claude Code collector is implemented; Cursor/Codex/Aider/git/PR collectors are next (see plan, page 5).
- Embeddings are feature-hashed (lexical) by default; a local transformer embedder plugs into `Embedder` without touching callers.
- Heuristic entities are deliberately conservative (pointers/subjects from edits, rules from detected corrections, procedures from successful command runs); the LLM pass generalizes rules, adds decisions, root causes and decoys.
- The `PreToolUse` guard only denies for rules with `enforcement: 'block'`, confidence ≥ 0.8 and evidence ≥ 2 — none are produced automatically yet; the surface exists so promoted/team rules can use it.
- No daemon yet: each hook is a fresh Node process (~200 ms). A warm local daemon is planned for sub-100 ms.

License: Apache-2.0.
