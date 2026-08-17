// Recall knowledge schema v2 (see RECALL_IMPLEMENTATION_PLAN.md, page 4)

export type Scope = 'personal' | 'project' | 'team';
export type Sensitivity = 'public' | 'internal' | 'restricted';
export type EntityType = 'subject' | 'pointer' | 'procedure' | 'rule' | 'decision';

export interface Provenance {
  source: 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'aider' | 'opencode' | 'git' | 'pr' | 'ci' | 'doc' | 'user' | 'agent';
  sessionId?: string;
  messageIds?: string[];
  segmentId?: string;
  commit?: string;
  prNumber?: number;
  docPath?: string;
  author?: string;
  observedAt: string; // ISO
  extractor?: 'heuristic' | 'llm';
}

export interface Validity {
  firstSeen: string;
  lastConfirmed: string;
  evidence: number;
  confidence: number; // 0..1
  disputedBy?: string[];
  decayHalfLifeDays: number;
  verify?: { kind: 'path' | 'symbol' | 'command'; target: string };
  /** feedback-derived usefulness in [-1, 1]; 0 = unknown */
  usefulness: number;
}

export interface BaseEntity {
  id: string;
  type: EntityType;
  scope: Scope;
  sensitivity: Sensitivity;
  projectPath: string; // repo/cwd this entity is about ("" = global)
  /** Machine-independent repo identity, e.g. github.com/owner/name (from the git remote). Used for team sync + cross-machine matching. */
  repo?: string;
  provenance: Provenance[];
  validity: Validity;
  /** Paths this entity is anchored to (for the FileIndex). */
  paths: string[];
  /** Compact text used for lexical + vector search. */
  text: string;
  embedding?: number[];
  embeddingModel?: string;
}

export interface Subject extends BaseEntity {
  type: 'subject';
  kind: 'subsystem' | 'module' | 'symbol' | 'config' | 'external' | 'tool';
  path: string;
  symbol?: string;
  summary: string;
  responsibilities: string[];
  constraints: string[];
  interactions: { path: string; text: string }[];
}

export interface Pointer extends BaseEntity {
  type: 'pointer';
  outcomeClass: string;
  signals: string[];
  rootCause?: string;
  resolution?: string;
  targets: { path: string; symbol?: string; reason: string; priority: number }[];
  decoys: { path: string; condition: string; reason: string; caveat: string }[];
}

export interface Procedure extends BaseEntity {
  type: 'procedure';
  goal: string;
  steps: { do: string; rationale?: string; command?: string }[];
  antiPatterns: { desc: string; reason: string }[];
  preconditions: string[];
  coSubjects: string[];
}

export type RuleCategory =
  | 'wrong_pattern' | 'wrong_tool' | 'wrong_file' | 'convention'
  | 'unnecessary_work' | 'missing_context' | 'safety';

export interface Rule extends BaseEntity {
  type: 'rule';
  ruleText: string;
  category: RuleCategory;
  appliesTo: { paths?: string[]; languages?: string[]; agents?: string[] };
  enforcement: 'inform' | 'warn' | 'block';
  example?: { before: string; after: string };
}

export interface Decision extends BaseEntity {
  type: 'decision';
  title: string;
  context: string;
  choice: string;
  alternatives: string[];
  consequences: string[];
  status: 'active' | 'superseded';
  supersededBy?: string;
}

export type Entity = Subject | Pointer | Procedure | Rule | Decision;

/** What an extractor produces before merge assigns ids/validity. */
export type Draft<T extends Entity> = Omit<T, 'id' | 'validity' | 'embedding' | 'text' | 'paths'> & {
  text?: string; paths?: string[]; confidence?: number;
};
export type DraftEntity = Draft<Subject> | Draft<Pointer> | Draft<Procedure> | Draft<Rule> | Draft<Decision>;

export const DECAY_HALF_LIFE_DAYS: Record<EntityType, number> = {
  rule: 180, decision: 365, procedure: 90, pointer: 60, subject: 120,
};

// ---------- canonical events (collector output) ----------

export type CanonicalEvent =
  | { t: 'user'; text: string; ts: string; id: string }
  | { t: 'assistant'; text?: string; thinking?: string; ts: string; id: string }
  | { t: 'tool_call'; name: string; input: unknown; id: string; ts: string; parentId?: string }
  | { t: 'tool_result'; callId: string; output: string; isError: boolean; ts: string; id: string }
  | { t: 'meta'; cwd?: string; branch?: string; model?: string; agent: string; ts: string; id: string };

export interface SourceRef {
  collector: string;
  sessionId: string;
  projectPath: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface Segment {
  id: string;            // hash of session + first event id
  sessionId: string;
  projectPath: string;
  agent: string;
  startedAt: string;
  events: CanonicalEvent[];
  userPrompt: string;    // first user prompt in the segment
  outcome: 'accepted' | 'abandoned' | 'partial' | 'unknown';
  filesRead: string[];
  filesMutated: string[];
  commands: string[];
  corrections: { text: string; afterEventId: string; ts: string }[];
}
