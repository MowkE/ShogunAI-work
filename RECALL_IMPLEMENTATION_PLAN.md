# Recall — Implementation Plan

*Codename "Recall" (placeholder). A local-first knowledge layer for coding agents that supersedes GodHands on every axis that matters. Prepared 2026-08-16. Companion to `GODHANDS_ANALYSIS.md`.*

**Assumptions stated up front:** 2–4 engineers, 12 weeks to a public v1, TypeScript-first, Anthropic models by default (BYO-model supported), open-core license. Nothing here copies GodHands's code — their npm package is UNLICENSED and their extraction runs server-side anyway. We copy the *problem*, not the implementation.

---

## Page 1 — Thesis: what "10× better" means, measured

GodHands's real product (the only thing you can install) is a CLI that mines Claude Code transcripts into a knowledge base of *subjects, outcome→pointers (with decoys), action patterns (with anti-patterns), and rules distilled from user corrections*, then re-injects that context into future sessions through a tmux proxy, a single MCP tool, and a CLAUDE.md nudge. It uploads full transcripts to their server for extraction, only understands Claude Code, ships with an expiry date, and has no feedback loop, no team layer, and no verification that a stored fact is still true.

"10× better" is not a slogan here; it is ten concrete vectors, each with a metric we can measure on day one and again at week 12.

| # | Vector | GodHands today | Recall target (wk 12) | How we measure |
|---|---|---|---|---|
| 1 | **Sources ingested** | Claude Code transcripts only | Claude Code, Cursor, Codex CLI, Gemini CLI, Aider, OpenCode/Windsurf **+ git history + PR review comments + CI failures + repo docs** | # of source adapters shipped; % of a team's coding activity covered |
| 2 | **Injection surfaces** | tmux proxy (fragile), 1 MCP tool, CLAUDE.md text nudge | Claude Code **hooks** (zero-click, automatic), MCP (4 tools), **compiled rules files** for any agent (`.claude/rules`, `.cursor/rules`, `AGENTS.md`), guardrail hook that can *block* known-bad edits | Injection happens with no user action in ≥95% of sessions; works in ≥3 agents |
| 3 | **Privacy** | Full transcripts (code, tool output, cwd, branch) uploaded to their server; contradicts their own "zero retention" claim | **Local-first**: extraction on your machine with your API key or a local model; secrets redacted before any model call; raw transcripts never leave disk unless you opt into Team sync | Bytes leaving the machine per session (target: 0 in Local mode); redaction test suite passes |
| 4 | **Truth maintenance** | Facts never expire or get re-checked | Every entry has provenance, `last_confirmed_at`, decay, and **read-time verification** against git/symbols (a pointer to a deleted file is caveated or dropped); contradictions surfaced, not silently merged | % injected pointers that resolve to a live path/symbol (target ≥ 97%) |
| 5 | **Retrieval quality** | BM25 + pseudo-embedding on client, LLM rerank on server; query = raw prompt | Real local embeddings, hybrid FTS5 + vector + symbol index with RRF, **context-aware query** (cwd, branch, recently touched files, open task), learned reranker from feedback | Replay eval: hit@3 on files the agent eventually edited; precision (injected entry was used) |
| 6 | **Feedback loop** | None (local telemetry only) | Every injection tracked: was it used? did the task succeed? → per-entry usefulness → reranker features and decay; explicit `recall_feedback` tool | Precision trend week-over-week; % entries with ≥1 outcome signal |
| 7 | **Latency** | Unknown; server round-trip on every prompt | Hook path ≤ 300 ms p50 with no LLM call; MCP deep path ≤ 1.5 s p50 | Local timing telemetry |
| 8 | **Team layer** | Admin-only org/key stubs | Personal → project → team KB with a review queue, sync server, RLS, "who knows this" | Design partners running shared KB; promotions/week |
| 9 | **Doc projection** | Landing-page promise, nothing shipped | GitHub App: PR diff → affected symbols → linked KB entries + doc sections → drift findings + suggested doc edits; ADR drafts from Decision entries | Drift precision on a labelled set; PRs with accepted suggestions |
| 10 | **Distribution / DX** | UNLICENSED, obfuscated, hardcoded expiry (already expired), tmux required, macOS/Linux, "book a call" | Apache-2.0 core, signed releases, one-command install, no tmux, macOS/Linux/Windows, offline-capable, self-serve | Installs; time-to-first-injection (target < 3 min) |

**North-star metric:** *re-exploration avoided* — the reduction in read/grep/glob tool calls before the agent's first edit on tasks where the KB fires, plus the reduction in user corrections per session. Everything on pages 2–10 exists to move those two numbers.

---

## Page 2 — Product definition

### Users and jobs

| User | Job to be done | What they feel today |
|---|---|---|
| Individual engineer using Claude Code / Cursor / Codex daily | "Stop making the agent rediscover my repo and re-learn my preferences every session." | Repeats the same corrections; watches the agent grep for ten minutes before editing the file they already knew about |
| Tech lead / staff engineer | "Make the tribal knowledge in my head (and in old PRs) available to every agent on the team." | Reviews the same mistakes from different people's agents |
| Platform / DevEx team | "Give every engineer's agent org context safely, with audit and controls." | Blocked by security from any tool that uploads code |
| Enterprise buyer (later) | "Institutional memory that survives attrition; docs that stay true; auditable AI-assisted change." | Doc drift, onboarding time, compliance questions |

### Wedge

The individual engineer, day one, zero configuration: `npx recall init` builds a KB from transcripts already on disk, registers hooks + MCP, and the very next Claude Code prompt gets context. Team features grow out of individual adoption, not the other way around.

### Principles (each maps to a 10× vector)

1. **Local-first.** The KB is files on your disk (SQLite). Extraction uses *your* model key or a local model. Nothing leaves the machine unless you opt in.
2. **Zero-click.** Injection is automatic (hooks) — no split panes, no approve/skip prompts by default. The user can turn on a preview mode; the default respects flow.
3. **Any agent.** Adapters normalize every agent's transcript format into one canonical schema; outputs are compiled into every agent's native rules format.
4. **Every fact has receipts.** Provenance (session, message, commit, PR), confidence, dates. `recall explain <id>` shows exactly why the agent was told something.
5. **Measured, not vibes.** Replay eval and online metrics from week 1; no feature ships without moving a metric.
6. **Safe by construction.** Redaction before any model call; sensitivity flags; secrets never enter the KB; guardrail hook is *conservative* (block only on high-confidence rules).

### Non-goals for v1 (explicitly deferred)

- Slack / Jira / Notion ingestion (phase 4).
- Hosted multi-tenant SaaS before the local product is excellent.
- A GUI beyond a minimal web dashboard.
- Model fine-tuning.

### Packaging

- **Recall Core** (Apache-2.0): CLI, daemon, adapters, extraction, retrieval, MCP server, hooks, rules compiler, local dashboard.
- **Recall Team** (paid): sync server, shared KB, review queue, roles/RLS, dashboards, doc-projection GitHub App.
- **Recall Enterprise**: on-prem/VPC, SSO, audit export, custom retention.

---

## Page 3 — System architecture

```
                 ┌────────────────────────────── SOURCES ───────────────────────────────┐
                 │ Claude Code JSONL   Cursor DB   Codex/Gemini/Aider/OpenCode logs      │
                 │ git log/blame       GitHub/GitLab PR reviews & comments   CI logs     │
                 │ repo docs (md/ADR)                                                    │
                 └───────────────┬─────────────────────────────────────────────────────┘
                                 ▼
   ┌───────────────┐   ┌──────────────────┐   ┌────────────────┐   ┌───────────────────┐
   │  Collectors    │─▶ │  Normalizer      │─▶ │  Redactor      │─▶ │  Segmenter        │
   │ (per source,   │   │ canonical        │   │ secrets/PII    │   │ task boundaries + │
   │  incremental)  │   │ Session/Event    │   │ before any LLM │   │ outcome inference │
   └───────────────┘   └──────────────────┘   └────────────────┘   └─────────┬─────────┘
                                                                            ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │  Extractor (LLM, structured outputs)  →  Merger (embed · cluster · dedup ·        │
   │  evidence++ · contradiction check · decay)  →  KB Store (SQLite: entities,        │
   │  FTS5, sqlite-vec, file+symbol index, provenance, feedback)                        │
   └───────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
   ┌────────────────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐
   │ Retriever              │◀─▶│ Verifier (git/symbol) │   │ Rules Compiler           │
   │ context-aware query,   │   │ read-time freshness   │   │ .claude/rules · .cursor/ │
   │ hybrid + rerank + gate │   └───────────────────────┘   │ rules · AGENTS.md        │
   └───────────┬────────────┘                               └──────────────────────────┘
               ▼
   ┌──────────────────────────────── SURFACES ─────────────────────────────────────────┐
   │ Claude Code hooks (SessionStart · UserPromptSubmit · PreToolUse · Stop/SessionEnd) │
   │ MCP server (recall_search · recall_explain · recall_remember · recall_feedback)    │
   │ Cursor / VS Code via MCP + rules · CLI (`recall ask`, `recall why`)                │
   └───────────┬───────────────────────────────────────────────────────────────────────┘
               ▼
   ┌──────────────────────────┐        ┌───────────────────────────────────────────────┐
   │ Feedback / Outcomes      │───────▶│ Team Server (optional): sync · review queue · │
   │ used? succeeded? → LTR   │        │ shared KB · RLS · doc-projection GitHub App   │
   └──────────────────────────┘        └───────────────────────────────────────────────┘
```

**Process model**

- `recall` — CLI (init, ingest, search, explain, stats, compile-rules, doctor).
- `recall daemon` — background process: watches transcript directories and git, ingests incrementally, keeps the index warm, serves a local HTTP API on `127.0.0.1` for hooks/MCP so each hook invocation is a cheap request rather than a cold Node start (this is how we hit ≤ 300 ms).
- `recall-mcp` — stdio MCP server (thin; talks to the daemon).
- `recall-hook` — tiny binary/script invoked by Claude Code hooks; reads stdin JSON, calls the daemon, prints JSON.
- **Team Server** — separate deployable (Node/Fastify or Go), Postgres + pgvector, only in Team mode.

**Where computation runs:** collectors, redaction, retrieval, verification, and storage are always local. Extraction runs locally *via your model key* (Anthropic API) or a local model; in Team mode you may route extraction through the Team Server for centralized billing — an explicit choice, never the default.

---

## Page 4 — Knowledge schema v2

Keep GodHands's core insight — knowledge is *not* transcript chunks but typed, mergeable entities — and fix what's missing: provenance, validity, decisions, symbol anchoring, scope, and sensitivity.

```ts
// packages/core/src/schema.ts (abridged)
type Scope = 'personal' | 'project' | 'team';
type Sensitivity = 'public' | 'internal' | 'restricted';

interface Provenance {
  source: 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'aider' | 'opencode' | 'git' | 'pr' | 'ci' | 'doc';
  sessionId?: string; messageIds?: string[];       // point back to local transcript, never copy it
  commit?: string; prNumber?: number; reviewCommentId?: string; docPath?: string;
  author?: string; observedAt: string;              // ISO
}

interface Validity {
  firstSeen: string; lastConfirmed: string; evidence: number;
  confidence: number;            // calibrated 0–1, updated by feedback
  disputedBy?: string[];         // ids of contradicting entries
  decayHalfLifeDays: number;     // per type: rules 180, pointers 60, procedures 90
  verify?: { kind: 'path' | 'symbol' | 'command'; target: string }; // checked at read time
}

interface Base { id: string; scope: Scope; sensitivity: Sensitivity; provenance: Provenance[]; validity: Validity; embedding?: Float32Array; }

interface Subject extends Base {           // a component / module / symbol / config / tool
  kind: 'subsystem' | 'module' | 'symbol' | 'config' | 'external' | 'tool';
  path: string; symbol?: string; summary: string;
  responsibilities: string[]; constraints: string[]; interactions: { path: string; text: string }[];
}
interface Pointer extends Base {           // "for outcome X, look here (and NOT there)"
  outcomeClass: string; signals: string[]; rootCause?: string; resolution?: string;
  targets: { path: string; symbol?: string; reason: string; priority: number }[];
  decoys:  { path: string; condition: string; reason: string; caveat: string }[];
}
interface Procedure extends Base {         // ordered steps that worked
  goal: string; steps: { do: string; rationale?: string; command?: string }[];
  antiPatterns: { desc: string; reason: string }[]; preconditions: string[]; coSubjects: string[];
}
interface Rule extends Base {              // distilled from corrections & PR reviews
  text: string; category: 'wrong_pattern' | 'wrong_tool' | 'wrong_file' | 'convention' | 'unnecessary_work' | 'missing_context' | 'safety';
  appliesTo: { paths?: string[]; languages?: string[]; agents?: string[] };
  enforcement: 'inform' | 'warn' | 'block';   // drives the PreToolUse guardrail
  example?: { before: string; after: string };
}
interface Decision extends Base {          // lightweight ADR
  title: string; context: string; choice: string; alternatives: string[]; consequences: string[];
  status: 'active' | 'superseded'; supersededBy?: string;
}
```

**Indexes:** `FileIndex` (path → entity ids), `SymbolIndex` (tree-sitter: file → symbols with ranges; entity → symbols), FTS5 over textualized entities, `sqlite-vec` over embeddings, and a `feedback` table (`entityId, sessionId, injectedAt, used, outcome`).

**Merge semantics.** New extraction → embed → nearest neighbours of same type above 0.86 cosine → LLM merge decision (`same | refines | contradicts | distinct`). `same/refines`: fold in, `evidence++`, `lastConfirmed = now`, keep the union of provenance. `contradicts`: keep both, link `disputedBy`, prefer newer at retrieval but *inject both with dates* when the gap is small — disagreement is information. Confidence is a logistic combination of evidence, recency, source weight (PR review > user correction > single session), and feedback.

**Read-time verification.** Before injection, every `verify` target is checked: paths via the working tree (`git ls-files` + rename detection with `git log --follow`), symbols via the SymbolIndex, commands via presence in `package.json`/`Makefile`. Failing entries get a caveat ("this pointer referenced `src/auth.ts`, which moved to `src/auth/index.ts` on 2026-07-02") or are dropped below a threshold. This single feature eliminates the most embarrassing failure mode of memory systems: confidently stale advice.

---

## Page 5 — Ingestion and collectors

**Collector contract**

```ts
interface Collector {
  id: string;                                   // 'claude-code'
  discover(): Promise<SourceRef[]>;             // where the raw data lives
  changedSince(cursor: string | null): Promise<SourceRef[]>;
  read(ref: SourceRef): AsyncIterable<CanonicalEvent>;   // normalized stream
}
type CanonicalEvent =
  | { t: 'user'; text: string; ts: string; id: string }
  | { t: 'assistant'; text?: string; thinking?: string; ts: string; id: string }
  | { t: 'tool_call'; name: string; input: unknown; id: string; ts: string }
  | { t: 'tool_result'; callId: string; output: string; isError: boolean; ts: string }
  | { t: 'meta'; cwd?: string; branch?: string; model?: string; agent: string };
```

**Sources and where they live** (verify exact paths during week 1; formats change):

| Source | Location / access | What it gives us | Priority |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` (+ real-time via `SessionEnd`/`Stop` hooks with `transcript_path`); format is internal and can change — adapter is versioned with fixtures | Full agent loop incl. tool calls, corrections, thinking | Week 1 |
| Claude Code auto memory | `~/.claude/projects/<slug>/memory/MEMORY.md` + topic files (or `autoMemoryDirectory`) | Facts Claude already decided to remember — cheap, high-signal | Week 2 |
| Cursor | SQLite `state.vscdb` under the app's `workspaceStorage` (chat/composer tables) | Chat + composer edits | Week 6 |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` (rollout logs) | Full loop | Week 6 |
| Gemini CLI / OpenCode / Windsurf | per-tool session dirs | Full or partial loop | Week 7 |
| Aider | `.aider.chat.history.md` in repo | Chat + applied diffs | Week 7 |
| **git** | `git log -p`, `git blame` | who/when/why (commit messages), what changed together (co-change → Subject.interactions) | Week 6 |
| **PR reviews** (GitHub/GitLab API or `gh`) | review comments, requested changes, suggestions | **the richest source of Rules** — human corrections at scale, already scoped to files/lines | Week 6 |
| CI | failing job logs (GitHub Actions API) | Pointer.signals ↔ rootCause pairs | Week 8 |
| Repo docs | `**/*.md`, `docs/adr/*` | Decisions, Procedures; anchors for doc projection | Week 8 |

**Incremental by construction.** Each source ref carries a content hash; the daemon watches directories (chokidar) and git refs, ingests deltas, and stores a cursor per collector. Full backfill runs through the Message Batches API (50% cheaper, async) with progress in the CLI.

**Redaction runs before anything reaches a model.** A gitleaks-style ruleset (AWS/GCP/Slack/GitHub tokens, JWTs, private keys, high-entropy strings), env-file contents, and configurable PII patterns are replaced with typed placeholders (`<SECRET:aws_key>`). Redaction is tested against a corpus of planted secrets in CI; the KB stores placeholders only. Raw transcripts are never copied into the KB — entities point back to `sessionId/messageId` on local disk.

**Privacy modes** (chosen at `recall init`, changeable):

| Mode | Extraction runs | Data leaving machine |
|---|---|---|
| Local (default) | Anthropic API with *your* key (or Ollama) | Redacted segments only, to the model provider you chose |
| Local + local model | Ollama / llama.cpp | Nothing |
| Team | Your key or Team Server key | Redacted segments + promoted entities to your Team Server |
| Enterprise | On-prem/VPC gateway | Nothing beyond your perimeter |

---

## Page 6 — Extraction pipeline

**Segmentation.** A session becomes task segments using (a) user prompts as boundaries, (b) tool-call clustering (a burst of read/grep followed by edits = one task), (c) explicit markers (`/clear`, "next task"). Outcome per segment (`accepted | abandoned | partial`) is inferred from later user turns ("thanks", a correction, a restart), test results in tool output, and a subsequent commit touching the same files (git collector cross-reference).

**Extraction call.** One request per segment (or per small group of related segments) using **structured outputs** — `output_config.format` with a JSON schema that mirrors the entity types on page 4 — so the output is guaranteed valid and no regex parsing exists anywhere in the pipeline. The system prompt is frozen and cached (`cache_control` on the last system block); the segment is the varying suffix. Instructions, in short: extract only what the transcript evidences; cite message ids for every claim; prefer fewer, higher-confidence entities; produce a `Rule` only when the user corrected the agent or a reviewer requested a change; produce a `Decision` only when a choice between alternatives was made and reasoned about; mark `sensitivity: restricted` if the content looks like credentials/customer data even after redaction.

**Corrections detector (the Rule factory).** A dedicated pass over user turns that follow assistant actions, classifying `negation | redirect | preference | scope` and generalizing to a rule with the narrowest scope that explains the correction (file → language → project → global). Each rule keeps its concrete `example.before/after`. PR review comments go through the same classifier with source weight 1.5×.

**Decisions.** "We chose Valkey over Redis because…" patterns → `Decision` with alternatives and consequences. These feed ADR drafts (page 9).

**Merge (page 4)** runs after each batch. Embeddings: local `bge-small-en-v1.5` (or `nomic-embed-text`) via ONNX/`@huggingface/transformers` so the client never needs a network call to embed a query; server-side embeddings only in Team mode.

**Model choice and cost.** Default `claude-opus-5` for extraction — extraction quality is the whole product and Opus 5 is a drop-in at Opus 4.8 pricing ($5 / $25 per MTok). Backfill through the Batches API (−50%). With a typical segment of ~12k input tokens (after redaction and tool-output truncation) and ~1.5k output tokens, one segment costs about **$0.05 batched / $0.10 live**; a 60-session backfill (~250 segments) is roughly **$12–25**; ongoing daily use is cents. Cache the ~3k-token system prompt (1h TTL) to cut input cost further. The relevance gate on the hot path is a separate, tiny call — evaluate it on `claude-sonnet-5` and `claude-haiku-4-5` for latency and let the eval decide; that is a measured tradeoff, not a default downgrade. Local-model extraction (Ollama) is supported behind the same interface with an explicit quality warning in `recall doctor`.

**Operational properties.** Idempotent (segment hash → skip), resumable (cursor per collector, per-batch checkpoints), observable (progress events to CLI/dashboard, per-segment cost recorded), rate-limit aware (SDK retries + a token bucket), and safe (any refusal → segment marked `skipped`, never retried with altered content).

---

## Page 7 — Retrieval and injection

**Query is assembled, not copied.** The hook input gives us `cwd`, the transcript path (so we can read the last N tool calls and see which files the agent is already touching), and the prompt. We build a structured query: `{ intent: prompt, files: recentlyTouched ∪ mentioned, subjects: symbolsInDiff, branch }`. For the MCP deep path we additionally rewrite the intent with a small model into 2–4 *subject + outcome* sub-queries — GodHands asks the agent to do this by hand in CLAUDE.md; we do it for it.

**Ranking.** For each entity type: FTS5 BM25 score, vector cosine, FileIndex/SymbolIndex boost, then Reciprocal Rank Fusion; priors for evidence, recency (decay), source weight, and calibrated confidence; per-type thresholds; top-K per type (defaults 3 pointers / 3 procedures / 5 rules / 2 decisions / 2 subjects). A learned reranker (LightGBM/logistic over ~20 features, trained on feedback) replaces hand weights once we have ≥ 2k feedback rows.

**Relevance gate and caveats.** Cheap path: score threshold + verifier. Deep path (MCP or when the daemon predicts high value): a single small-model call returns `{relevant, keep: ids[], caveats[]}` in structured output. Injection is *silent* when nothing clears the bar.

**Latency budget.** SessionStart precomputes and caches a *project brief* (top rules, active decisions, hot subjects for this repo). UserPromptSubmit does local hybrid retrieval only (no LLM) → ≤ 300 ms p50. The MCP tool is where the deep, LLM-gated retrieval lives; the agent calls it when it needs more.

**Surfaces**

1. **Claude Code hooks** (the 10× over the tmux proxy). Registered by `recall init` in `~/.claude/settings.json` (user scope) or `.claude/settings.json` (project scope):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "recall-hook session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "recall-hook prompt", "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": "Edit|Write|MultiEdit|Bash", "hooks": [{ "type": "command", "command": "recall-hook guard" }] }],
    "PostToolUse":      [{ "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "recall-hook observe" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "recall-hook stop" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "recall-hook ingest" }] }]
  }
}
```

   - `session-start` → returns `additionalContext` with the project brief.
   - `prompt` → returns `additionalContext` with the `<recall-context>` block (or nothing).
   - `guard` → for `enforcement: 'block'` rules with high confidence, returns a deny decision with the rule text and provenance; for `warn`, allows and adds context. Conservative by default; users can set `guardrail: off | warn | block`.
   - `observe` / `stop` → record which injected entities were acted on (edited a pointer's path? followed a procedure's command?) — the feedback signal.
   - `ingest` → incremental ingest of the just-finished session (real-time learning; no nightly job needed).

   *Exact stdin fields and output shapes are pinned to the Claude Code hooks reference during week 1 (see verification note at the end of this plan); the design does not depend on any single field beyond `transcript_path`, `cwd`, and the `additionalContext` / permission-decision outputs.*

2. **MCP server** (official `@modelcontextprotocol/sdk`, stdio + streamable HTTP): `recall_search(query, files?, types?)`, `recall_explain(id)`, `recall_remember(text, scope?)` (agent- or user-initiated memory with provenance = the current session), `recall_feedback(id, useful, note?)`. Registered via `claude mcp add --transport stdio --scope user recall -- recall-mcp` (and a project-scoped `.mcp.json` with an `mcpServers.recall` entry for teams).

3. **Rules compiler.** `recall compile` renders the top-N high-confidence rules and active decisions into native rule files, each wrapped in `<!-- recall:start/end -->` markers and optionally committed: `.claude/rules/recall-<area>.md` **with YAML `paths:` frontmatter** so a rule scoped to `src/auth/**` only loads when Claude touches those files (Claude Code supports per-path rules natively); `~/.claude/rules/recall-personal.md` for personal-scope rules; `.cursor/rules/recall.mdc`; and an `AGENTS.md` section for Codex/others. This is the zero-runtime path that works in every agent, including ones with no hook or MCP support. It also writes a compact index into Claude Code's **auto-memory directory** (`~/.claude/projects/<project>/memory/`, or `autoMemoryDirectory` if set) so Claude's own memory system points at Recall rather than competing with it — and the auto-memory files are themselves ingested as a source, so anything Claude jots down on its own becomes a provenance-tracked entity.

4. **Injection format.** A compact `<recall-context>` block: entries grouped by type, each with `id`, confidence, dates, one-line provenance ("from 3 sessions + PR #412"), and any caveats from the verifier; ends with one line telling the agent it can call `recall_explain`/`recall_feedback`.

---

## Page 8 — Feedback loop and evaluation

**Outcome tracking (implicit).** For every injected entity we log `(entityId, sessionId, injectedAt)`. Signals: the agent edited/read a pointer target within the next N tool calls (*used*); a procedure's commands appeared in Bash tool calls (*used*); a `warn` rule was followed by an edit that violates it (*ignored*); the user issued a correction after injection (*negative*); tests passed / commit happened on touched files (*task success*). These update per-entity `usefulness` and feed the reranker; entities with sustained negative signal decay faster and drop out of injection.

**Explicit feedback.** `recall_feedback` MCP tool; `recall why` (CLI) shows the last injection with provenance and lets the user mark entries; a "this was wrong" path that also creates a *correction* → new Rule with the fix.

**Evaluation harness (built in week 1, before extraction).**

1. **Replay eval.** Take historical transcripts, split by time. Build the KB from sessions before T; for each session after T with an accepted outcome, run retrieval on its first prompt (+ context) and score: hit@k on the files that session eventually edited (pointer quality); whether any later user correction in that session is predicted by an existing Rule (rule quality); precision of injected set against what the session actually touched. This runs offline on the developers' own transcripts from day one and becomes the regression suite. For end-to-end replays (not just retrieval), drive real sessions headlessly with `claude -p --output-format json` / the Agent SDK against the synthetic repo, with injection on and off.
2. **Synthetic tasks.** A small repo with planted conventions and known pitfalls; scripted sessions; assert injection contents.
3. **Online A/B.** The daemon randomly disables injection for a fraction of sessions (opt-in for the user); compare tool calls to first edit, corrections per session, tokens per task, and time to task completion. Report in `recall stats`.

**Release gates.** No release if replay hit@3 or precision regresses > 2 points; hook p50 > 300 ms; redaction suite fails; or any test session shows an unverified stale pointer.

---

## Page 9 — Team layer, doc projection, security

**Team layer.** Scopes: personal → project → team. Promotion to team is *reviewed*: the daemon proposes promotion when an entity has evidence ≥ 3 across ≥ 2 people (or comes from PR reviews), and a lead approves in a review queue (web dashboard). Team Server: Node/Fastify (or Go) + Postgres + pgvector, per-org RLS, SSO later. Sync protocol is an append-only log of immutable entity versions with tombstones; merge happens server-side with the same merger; clients pull the team KB into local SQLite so retrieval stays local and fast. Extras that fall out cheaply: "who knows this" (route a question to the person whose sessions produced the entity), and org-wide dashboards (top rules, most-corrected areas → onboarding docs).

**Doc projection (the half GodHands never shipped).** SymbolIndex (tree-sitter) + a MarkdownIndex (headings, code fences, symbol mentions) form a symbol→doc-section graph. A GitHub App on `pull_request` events: diff → changed symbols → linked KB entries + doc sections → LLM drift check per (symbol, section) pair → findings posted as review comments with *suggested changes*; gaps ("`webhook_handler.ts` has no doc coverage") as a checklist. Decisions accumulated in the KB become ADR drafts (`docs/adr/NNNN-*.md`) opened as PRs. Precision is measured on a labelled set before we post anything by default; start in "comment only" mode.

**Security and compliance.**

- Threat model: transcript data is the crown jewels; the model provider sees redacted segments only; Team Server sees entities, not transcripts.
- Redaction (page 5) is mandatory and tested; sensitivity flags stop `restricted` entities from being injected into sessions in other repos or promoted to team.
- At-rest: SQLite in the user's home; optional SQLCipher; Team Server encrypted volumes + KMS.
- Anthropic API: use an org configured for zero data retention where required (note: Claude Fable 5 requires 30-day retention; Opus 5 is fine under ZDR).
- Guardrail hook can *only* deny; it never executes anything.
- Supply chain: signed npm releases, SBOM, provenance attestations, no obfuscation, no expiry — the exact opposite of GodHands's current distribution.
- Audit: every injection and promotion is logged locally (and centrally in Team mode) with entity ids and provenance; exportable.
- Roadmap: SOC 2 Type I after Team GA; DPA template; data-deletion command (`recall forget --session/--entity/--all`) that also tombstones synced copies.

---

## Page 10 — Delivery plan

**Team.** Three engineers: (A) pipeline/ML — schema, extraction, merge, eval; (B) integrations — collectors, hooks, MCP, rules compiler, CLI/daemon; (C) backend — Team Server, sync, GitHub App, dashboards. If solo, follow the same order and stretch each phase ×1.6.

**Repo layout (pnpm monorepo, TypeScript, Node ≥ 20)**

```
recall/
  packages/core        schema, store (better-sqlite3 + sqlite-vec + FTS5), merger, verifier, retriever
  packages/collectors  claude-code, cursor, codex, gemini, aider, opencode, git, github, ci, docs
  packages/extract     segmenter, redactor, prompts, structured-output schemas, model adapters (anthropic | ollama)
  packages/cli         `recall` (commander), `recall-hook`, daemon (Fastify on 127.0.0.1)
  packages/mcp         `recall-mcp` (@modelcontextprotocol/sdk)
  packages/eval        replay eval, synthetic repo, metrics, release gates
  apps/team-server     Fastify + Postgres/pgvector, sync API, review queue, RLS
  apps/github-app      doc projection (Probot)
  apps/dashboard       local + team web UI (minimal)
```

**Stack decisions (why).** TypeScript everywhere → same language as MCP SDK, hooks, and the agents' ecosystems. SQLite (+ `sqlite-vec`, FTS5) → single-file, zero-ops, fast, portable to Windows. Local ONNX embeddings → no network on the hot path. Anthropic SDK with structured outputs + Batches + caching → correctness and cost. tree-sitter → symbol anchoring and doc projection. Fastify daemon → warm process for hooks. Probot → GitHub App plumbing.

**12-week roadmap with exit criteria**

| Weeks | Deliverables | Exit criteria |
|---|---|---|
| **1–2 Foundations** | Monorepo; canonical schema + SQLite store; Claude Code collector; redactor v1; **replay eval harness** running on our own transcripts; hooks reference pinned | Eval produces baseline numbers; `recall ingest` builds a KB locally |
| **3–5 Learn & inject** | Segmenter; extraction with structured outputs; merger; local embeddings; hybrid retrieval; verifier; **hooks + MCP + CLI**; daemon; `recall init` one-command setup; daily dogfood | Hook p50 ≤ 300 ms; replay hit@3 beats BM25 baseline by ≥ 30%; 3 internal users report "it fired usefully" daily |
| **6–8 Breadth & learning** | Cursor/Codex/Aider collectors; git + PR-review ingestion (Rule factory); rules compiler; feedback capture; reranker v0; guardrail (warn) ; `recall stats` | ≥ 3 agents supported; PR reviews produce rules on a real repo; precision trend up 2 weeks running |
| **9–10 Team alpha** | Team Server; sync; review queue; scopes/RLS; dashboards; 3–5 design partners | Two teams sharing a KB; promotions flowing; zero transcript bytes on server |
| **11–12 Projection & launch** | GitHub App drift/gap comments; ADR drafts; hardening; docs; signed releases; OSS launch (npm + GitHub + Show HN) | Drift precision ≥ 0.8 on labelled set; install → first injection < 3 min; launch metrics live |

**Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Transcript formats change under us | Adapters are versioned with fixture tests; daemon degrades to "known good" parser and alerts |
| Injected context is noisy → users disable it | Silent by default when below threshold; verifier; feedback-driven decay; A/B mode to prove value |
| Anthropic/Cursor ship native memory (Claude Code auto memory + `.claude/rules` already exist) | Integrate rather than compete: ingest auto memory, compile into per-path rules and the memory index. Our moat is cross-agent, cross-person, PR-review-derived, *verified* and provenance-rich knowledge, the feedback loop, and doc projection; ship the team layer early |
| Extraction cost surprises | Batches for backfill, caching, per-segment cost telemetry, budget caps in `recall init` |
| Privacy objections | Local mode default, redaction suite, published data-flow diagram, deletion command |
| Guardrail false positives annoy | Off/warn/block tiers; block only on evidence ≥ 3 and confidence ≥ 0.9; one-line override |

**KPIs at week 12.** Replay hit@3 ≥ 0.6; injection precision ≥ 0.7; re-exploration reduction ≥ 30% (A/B); corrections/session −25%; hook p50 ≤ 300 ms; ≥ 3 agents; ≥ 2 design-partner teams; 0 transcript bytes off-device in Local mode; install-to-first-injection < 3 min.

**Day-1 checklist.** Create the monorepo; write `schema.ts`; copy your own `~/.claude/projects` into `packages/eval/fixtures` (redacted); implement `claude-code` collector + normalizer; get `recall ingest --dry-run` printing segments; write the replay eval so the first extraction has a scoreboard waiting for it.

---

### Verification note (hooks / MCP facts, checked 2026-08-16)

Confirmed against the current Claude Code docs (`code.claude.com/docs/en/hooks`, `/mcp`, `/memory`, `/sessions`): hook events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `SubagentStop`, `SessionEnd`, `FileChanged`, `PreCompact`, `StopFailure`, `Notification`; hooks receive JSON on stdin (`session_id`, `hook_event_name`, `cwd`, `permission_mode`, plus `tool_name`/`tool_input`/`tool_use_id` on tool events, `transcript_path` for the session file) and inject context by printing JSON with `hookSpecificOutput.additionalContext`; `PreToolUse` can deny via `hookSpecificOutput.permissionDecision` (or exit code 2); hooks live in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, or plugin `hooks/hooks.json`. Transcripts are `~/.claude/projects/<project>/<session-id>.jsonl` (internal format, versioned adapter required). Auto memory lives in `~/.claude/projects/<project>/memory/` (`autoMemoryEnabled`, `autoMemoryDirectory`). Per-path rules: `.claude/rules/*.md` with `paths:` frontmatter; user rules in `~/.claude/rules/`. MCP: `claude mcp add --transport stdio|http [--scope local|project|user] <name> -- <cmd>`, project file `.mcp.json` (`mcpServers`). Headless replay for the eval harness: `claude -p --output-format json`, `--resume <id>`, and the Agent SDK's `getSessionMessages(sessionId)`. Re-pin these in week 1 — the exact `additionalContext` placement has shifted between schema versions.
