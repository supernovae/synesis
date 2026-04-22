# Token Optimization Architecture

Yarn is a proxy between developer tools (Cursor, Claude Code, Roo, Zed, etc.) and
LLM providers (Anthropic, OpenRouter, vLLM, DashScope, etc.). Every token sent
upstream costs GPU time. CPU-side optimization in the proxy is orders of magnitude
cheaper than the GPU compute it displaces. This document describes the full
optimization pipeline — what each stage does, why it exists, and how it interacts
with upstream provider caching (prefix/KV).

## Design principles

1. **Fail-safe to pass-through.** Every optimization has a bypass that sends the
   unmodified request on error. A developer's workflow never blocks because an
   optimization threw. Bypass events are logged for audit.

2. **Provider-agnostic.** Optimizations happen before the AI SDK call. They work
   identically whether upstream is Anthropic (prefix caching), OpenRouter (no
   caching), or a local vLLM (PagedAttention KV). Provider-specific cache markers
   are a separate, additive layer.

3. **Observable.** Every optimization emits a structured telemetry event with
   tokens-before/after, hit/miss, and latency. The `OptimizationLedger` aggregates
   these per-request for Prometheus and training data.

4. **Deterministic where possible.** Content-hash keyed lookups over time-based or
   heuristic invalidation. Deterministic systems are testable and cache-friendly.

5. **Never break developer expectations.** The proxy is transparent to tool
   protocols. Tool calls execute faithfully, responses are complete, streaming
   works, and errors surface with full detail. Savings come from *how* we
   represent the conversation to the model, not from withholding information.

---

## Pipeline overview

Request flow for `/v1/chat/completions` (OpenAI path; Claude path converges
after message conversion):

```
Client messages
  │
  ▼
┌─────────────────────────────────────┐
│ 1. Tool Result Reduction            │  60+ output-family classifiers
│    (reducers, guided trim, task     │  compress test/lint/build/git output
│     pruning, JSON compaction)       │  to structured summaries
├─────────────────────────────────────┤
│ 2. Validation Normalization         │  Normalize lint/test output format;
│    (+ optional Tier C LLM fallback) │  optional sidecar LLM for edge cases
├─────────────────────────────────────┤
│ 3. Transcript Pruning              │  Budget-based eviction of stale turns:
│    - duplicate command dedup        │  command dedup, file-read dedup,
│    - duplicate file-read dedup      │  stale tool-result eviction,
│    - stale tool-result eviction     │  assistant condensation,
│    - old assistant condensation     │  near-duplicate output collapse
│    - near-duplicate output collapse │
├─────────────────────────────────────┤
│ 4. Read Snapshot Normalization      │  File snapshot registry tracks content
│                                     │  hashes; "unchanged" hints → stubs or
│                                     │  replays from registry instead of
│                                     │  resending full file content
├─────────────────────────────────────┤
│ 5. Content-Addressed Dedup          │  Per-session file-read dedup by
│    + Response Dedup                 │  content hash; repeated identical reads
│                                     │  → compact stub with snapshot ref.
│                                     │  ResponseDedupe: identical tool+args
│                                     │  with same result hash → cached stub
├─────────────────────────────────────┤
│ 6. Historical Normalization         │  Old tool results (outside keep window):
│    - timestamp replacement          │  replace volatile content with stable
│    - path normalization             │  placeholders for prefix cache
│    - tool-call ID stabilization     │  friendliness
├─────────────────────────────────────┤
│ 7. Jitter Buffer                    │  Strip timestamps, cwd, session IDs,
│    (system + user messages)         │  branch names, PIDs from messages;
│                                     │  collect in trailing ENVIRONMENT block
├─────────────────────────────────────┤
│ 8. System Enrichment                │  Build prompt from PromptFrame:
│    (enrichWithFrameAndManifest)     │  stable prefix (instructions + admin
│    + BlockStore normalization       │  profiles + adapter), project context,
│                                     │  ChatState + FileState semantic channels,
│                                     │  structural index, verification plan,
│                                     │  response style, governance blocks.
│                                     │  Each block stored in BlockStore by
│                                     │  content hash — guarantees byte-stable
│                                     │  output for identical logical content.
├─────────────────────────────────────┤
│ 9. Attention Positioning            │  Reorder system blocks: high-priority
│                                     │  at beginning/end, low-priority in
│                                     │  middle (lost-in-the-middle mitigation)
├─────────────────────────────────────┤
│ 10. Prefix Optimizer                │  Reorder for KV-cache stability:
│     - tool canonicalization         │  stable system blocks first, then
│     - request rebuild               │  conversation history, then volatile
│     - cache marker placement        │  task frame and live context last.
│                                     │  Tool schemas sorted by name, keys
│                                     │  sorted recursively, dynamic content
│                                     │  stripped from descriptions.
├─────────────────────────────────────┤
│ 11. Trust Pipeline                  │  Injection scan, sanitization,
│                                     │  trust packet wrapping
├─────────────────────────────────────┤
│ 12. Context Admission               │  Final size check before sending:
│     + Optimization Ledger           │  warn/reject on oversized payloads.
│                                     │  Ledger records tokens saved at
│                                     │  each stage for observability.
└─────────────────────────────────────┘
  │
  ▼
AI SDK call (generateText / streamText)
  │
  ▼
Provider (Anthropic / OpenRouter / vLLM / DashScope)
```

---

## Stage details

### 1. Tool Result Reduction

**Module:** `src/reduction/tool-result-reducer.ts`, `src/reduction/registry.ts`

Reduces raw tool output (test logs, build output, linter errors, git diffs, etc.)
to structured summaries. Sixty reducer families classify output by shape:
pytest, tsc, jest, cargo, go-build, npm-install, kubectl, terraform, etc.

Sub-stages (in order):
- **Read cache stub remediation** — client "unchanged since last read" stubs get a
  model-facing guardrail telling it to re-read
- **Empty result remediation** — empty search/list JSON → short guardrail
- **Guided output trimming** — listed tool names + size thresholds → truncated with
  guardrail XML envelope
- **Task-conditioned pruning** — keep only lines matching task-relevant tokens or
  error signals; full raw stored as artifact
- **Reducer pipeline** — classify → reduce → optional JSON compaction
- **Content dispatch** — fallback for unclassified output
- **Recall routing** — language-pack enrichment for verification tool results

**Config:**
- `SYNESIS_YARN_REDUCERS_ENABLED` (default: `true`)
- `SYNESIS_YARN_TOOL_OUTPUT_TRIM_GUIDED_ENABLED` (default: `true`)
- `SYNESIS_YARN_TASK_PRUNING_ENABLED` (default: `true`)
- `SYNESIS_YARN_REDUCER_PROFILE` — `balanced` | `aggressive` | `ultra`

### 2. Validation Normalization

**Module:** `src/validation/service.ts`

Normalizes test/lint output format. Optional Tier C LLM fallback for ambiguous
output using a separate cheap model tier (`synesis-compaction`).

### 3. Transcript Pruning

**Module:** `src/reduction/transcript-pruning.ts`

Budget-based eviction. Only fires when total content exceeds `budgetChars`.
The "keep window" protects the last N user turns or last N tool results.

Strategies (applied in order):
1. **Duplicate command dedup** — shell commands before keep window: keep latest
   occurrence, replace older with `<DUPLICATE_CMD_SUPERSEDED/>`
2. **Duplicate file-read dedup** — keep latest read per path; supersede older reads
3. **Stale tool-result eviction** — old large tool results → stub with preview
4. **Old assistant condensation** — large early assistant messages → head-truncated
5. **Near-duplicate output collapse** — content fingerprinting to collapse outputs
   with identical normalized content

**Config:**
- `SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED` (default: `true`)
- `SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS` (default: `60000`)
- `SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS` (default: `5`)

### 4. Read Snapshot Normalization

**Module:** `src/reduction/read-snapshot-normalizer.ts`, `src/reduction/file-snapshot-registry.ts`

Maintains a per-session registry of file content hashes. When a client sends an
"unchanged since last read" hint, the normalizer either:
- Returns a compact `ok/unchanged_snapshot_still_visible` stub (if the snapshot
  is still in the model's active context)
- Replays the full content from the registry (if needed for a line-range read)
- Falls back to a guarded disk read (if the snapshot was evicted by compaction)

This avoids resending megabytes of file content that the model has already seen.

### 5. Content-Addressed Dedup + Response Dedup

**Modules:** `src/reduction/content-addressed-dedup.ts`, `src/dedupe/ResponseDedupe.ts`

**Content-addressed dedup:** Per-session `fileMap` tracks `path → {hash, turnIndex}`.
When the same file is read with identical content, subsequent reads get a compact
stub: `status: "ok/unchanged_snapshot_still_visible"` with `content_hash` and
`snapshot_id`. After 3+ unchanged reads of the same file, escalates to
`needs_targeted_read` to break the loop.

Uses a fast non-cryptographic hash (`fastHash` — two 32-bit accumulators with
`Math.imul`, base36 output) for content comparison. Staleness margin prevents
stale "unchanged" stubs after sawtooth compaction.

**Response dedup:** For tool calls where the same tool+args produced the same
result hash before, returns a compact cached stub instead of the full result.
Hashes: SHA-256 of result text (24 hex chars) + SHA-256 of normalized
tool name + stable JSON args (32 hex chars). Applied to `read_file`, `search`,
`list_files`, `glob`, and other idempotent tool families.

### 6. Historical Normalization

**Module:** `src/reduction/historical-normalizer.ts`

For messages *outside* the recent keep window (already subject to pruning anyway),
replaces volatile content that breaks upstream KV-cache prefix matching:

- **Timestamps:** ISO-format timestamps → `[TIMESTAMP]`
- **Absolute paths:** Home-directory paths → `~` prefix
- **Blank lines:** Consecutive blank lines → single blank
- **Tool-call IDs:** Provider-generated IDs (`toolu_01ABC...`, `call_xyz123`) →
  deterministic `tc_{turnIndex}_{callIndex}` (both assistant `tool_calls[].id`
  and matching tool `tool_call_id` rewritten together)

This is explicitly lossy for old context but preserves exact content for recent
turns. The model has already processed these old messages — the only consumer
of the exact bytes is the upstream KV cache, which benefits from stability.

**Config:**
- `SYNESIS_YARN_HISTORICAL_CONTENT_NORMALIZE_ENABLED` (default: `true`)

### 7. Jitter Buffer

**Module:** `src/compat/jitter-buffer.ts`

Strips volatile metadata from system and user messages to prevent it from
breaking the stable prefix region. Extracted content is collected into a single
`<ENVIRONMENT_CONTEXT>` block appended to the last user message.

Volatile patterns detected and extracted:
- ISO timestamps and date strings
- `cwd=...` / `cwd: ...` paths
- `session_id` / `conversation_id` values
- Git branch names
- PIDs, ephemeral ports
- Temp directory paths
- "Today's date: ..." lines

Handles both string content and array content blocks (multimodal messages).

**Config:**
- `SYNESIS_YARN_JITTER_BUFFER_ENABLED` (default: `true`)

### 8. System Enrichment + BlockStore

**Module:** `src/index.ts` (`enrichWithFrameAndManifest`), `src/store/block-store.ts`

Builds the system prompt from a typed `PromptFrame` where each component is
stored in a content-addressed `BlockStore`:

- **Stable prefix** — base instructions + admin prompt profiles + adapter
- **Project context** — project root + manifest
- **Structural index** — symbol map built from file reads
- **Verification plan** — from detected languages
- **Response style** — markdown guidance
- **Governance blocks** — task intake, plan progress, memory guidance
- **Volatile adapter** — git/runtime metadata (changes per turn)
- **Task frame** — current objective + active files (semi-stable)

The `BlockStore` is an in-process content-addressed LRU. Each block is stored by
`SHA-256(NFC-normalized content)`. When the same logical content is assembled on
consecutive turns, `BlockStore.get()` returns the **exact same string reference**,
guaranteeing byte-identical output. This maximizes upstream KV-cache prefix hits
without any provider-specific logic.

**Volatile hash memoization:** The concatenation of all volatile system blocks is
hashed per-turn. If unchanged from the previous turn, the prior string is reused
(avoids even the string allocation).

### 9. Attention Positioning

**Module:** `src/context/attention-positioning.ts`

Reorders system blocks to mitigate the "lost in the middle" problem:
- **High-priority begin blocks** (architectural state, session continuity) → front
- **Medium-priority blocks** → middle
- **Low-priority blocks** (project manifest) → anywhere
- **Conversation messages** → chronological order preserved
- **End blocks** → after conversation

### 10. Prefix Optimizer

**Module:** `src/providers/prefix-optimizer/`

The final reordering pass, optimized for upstream KV-cache behavior:

1. **Tool canonicalization** — sort tools by `function.name`, sort all JSON schema
   keys recursively, normalize descriptions (strip dynamic paths, collapse
   whitespace), compute `toolsetHash`
2. **Request rebuild** — canonical message order:
   - `core_instructions` (system)
   - `project_guidance` (system)
   - Prior conversation messages (original index order)
   - Latest user message
   - `live_context` (system)
   - `task_frame` (system, semi-stable, highest churn)
3. **Cache marker placement** — for Anthropic/DashScope, place a single cache
   marker at the boundary between leading stable system messages and conversation.
   Minimum 1024 estimated tokens for the stable block.
4. **Diagnostics** — compare segment hashes to previous turn; report cache miss
   reasons (core/project/tools/frame change)

### 11. Trust Pipeline

**Module:** `src/security/transcript-trust.ts`

Injection scanning, content sanitization, and trust packet wrapping. Runs after
all optimization (untrusted content should be scanned in its optimized form).

### 12. Context Admission + Optimization Ledger

**Modules:** `src/index.ts` (`evaluateContextAdmission`), `src/telemetry/optimization-ledger.ts`

**Context admission:** Final gate before the upstream call. Estimates token count
as `ceil(totalChars / 4)` and compares against warn/hard thresholds.

**Optimization ledger:** Per-request record of tokens saved at each pipeline stage:

| Field | Source |
|-------|--------|
| `inputTokensOriginal` | Raw client payload |
| `inputTokensAfterReduction` | After tool result reduction |
| `inputTokensAfterPruning` | After transcript pruning |
| `inputTokensAfterDedup` | After content-addressed + response dedup |
| `inputTokensFinal` | After all optimization |
| `toolResultsOriginalChars` | Sum of raw tool result lengths |
| `toolResultsReducedChars` | Sum after reduction |
| `responseDedupHits` | Count of response dedup cache hits |
| `blockStoreHits` | Count of BlockStore cache hits |
| `prefixStableBytes` | Bytes unchanged from previous request |
| `upstreamCachedTokens` | From provider usage response |

Emitted as structured log `optimization_ledger` on every request. Fed into
Prometheus histograms for alerting and dashboarding.

---

## State locations

| Data | Location | Lifetime |
|------|----------|----------|
| Conversation history + compaction | In-memory `sessions` Map | Process lifetime |
| Session aggregates + plan graph | Redis `yarn-ts:session:*` | Session TTL (4h default) |
| Session checkpoint (post-compaction) | Redis `yarn-ts:checkpoint:*` | Session TTL |
| User continuity (cross-session) | Redis `yarn-ts:continuity:*` | Session TTL |
| File summaries | Redis `yarn-ts:summary:*` | 4h TTL |
| Per-request usage | Postgres `yarn_usage_log` | Permanent |
| Session events | Postgres `yarn_session_events` | Permanent |
| Observations (memory tools) | Redis lists + local LRU | 4h TTL |
| Structural index + content dedup | In-memory per session | Process lifetime |
| BlockStore (prompt blocks) | In-memory LRU (global) | Process lifetime |
| Artifacts | In-memory global (TTL 1h) | 1h max |

---

## Interaction with upstream KV caching

Different providers expose KV-cache behavior differently:

| Provider | Cache mechanism | What Yarn does |
|----------|----------------|----------------|
| **Anthropic** | Prefix caching (automatic + explicit markers) | Stable prefix ordering + optional cache marker at stable/volatile boundary |
| **vLLM** | PagedAttention automatic KV reuse | Byte-stable prefixes via BlockStore + tool canonicalization |
| **DashScope** | Explicit cache markers (min 1024 tokens) | Same marker policy as Anthropic; marker only placed if stable block >= 1024 tokens |
| **OpenRouter** | Varies by underlying provider | Byte-stable prefixes (helps when routed to prefix-cache providers) |
| **Local vLLM** | PagedAttention | Byte-stable prefixes; highest ROI since all KV-cache savings are local cost savings |

The key insight: **Yarn's optimizations are provider-agnostic prefix stability**.
The BlockStore, jitter buffer, tool canonicalization, and historical normalization
all work to produce byte-identical token sequences across turns. This benefits
*any* provider with KV caching, whether explicit (Anthropic markers) or implicit
(vLLM PagedAttention).

---

## Sawtooth compaction

Long sessions accumulate O(n) context per turn. Sawtooth compaction periodically
summarizes the conversation history into a compact `<ARCHITECTURAL_STATE>` block:

1. **Checkpoint trigger:** Every N tool calls (default 12) or when history
   exceeds 60 messages
2. **Compaction:** LLM-backed (using `synesis-compaction` tier) or heuristic
   fallback (last 20 masked lines, or tail truncation)
3. **Result:** History replaced by single system message with architectural
   summary (files touched, decisions made, errors encountered, current state)
4. **Checkpoint persistence:** Serialized to Redis for session resume on
   process restart

The "sawtooth" pattern: context grows linearly, then drops sharply at each
checkpoint. The summary preserves enough for the model to continue coherently.

---

## Feature flags

All optimization features are independently toggleable. Critical flags and their
defaults:

| Flag | Default | Category |
|------|---------|----------|
| `SYNESIS_YARN_REDUCERS_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED` | `true` | Pruning |
| `SYNESIS_YARN_DEDUPE_ENABLED` | `true` | Dedup |
| `SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED` | `true` | Caching |
| `SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_STABLE_PREFIX_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_JITTER_BUFFER_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_SORTED_TOOLS_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_JSON_COMPACTION_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED` | `true` | Quality |
| `SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED` | `true` | Context |
| `SYNESIS_YARN_CONTENT_DISPATCH_ENABLED` | `true` | Reduction |
| `SYNESIS_YARN_HISTORICAL_CONTENT_NORMALIZE_ENABLED` | `true` | KV stability |
| `SYNESIS_YARN_RESPONSE_DEDUPE_BROAD_ENABLED` | `false` | Dedup |
| `SYNESIS_YARN_TOOL_COLLAPSE_ENABLED` | `false` | Batching |
| `SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED` | `false` | Memory |

---

## File map

| File | Role |
|------|------|
| `src/reduction/tool-result-reducer.ts` | Tool output reduction pipeline |
| `src/reduction/registry.ts` | 60+ reducer family classifiers |
| `src/reduction/transcript-pruning.ts` | Budget-based transcript eviction |
| `src/reduction/content-addressed-dedup.ts` | Per-session file-read dedup |
| `src/reduction/read-snapshot-normalizer.ts` | File snapshot replay |
| `src/reduction/file-snapshot-registry.ts` | File content hash registry |
| `src/reduction/historical-normalizer.ts` | Volatile content stabilization |
| `src/dedupe/DedupeLayer.ts` | Tool call dedup pipeline |
| `src/dedupe/ResponseDedupe.ts` | Tool result response caching |
| `src/dedupe/DedupeCache.ts` | LRU cache for dedup |
| `src/dedupe/ToolCallDedupe.ts` | Exact consecutive tool call dedup |
| `src/store/block-store.ts` | Content-addressed prompt block cache |
| `src/context/stable-prefix.ts` | Stable prompt prefix assembly |
| `src/context/sawtooth-manager.ts` | Periodic conversation compaction |
| `src/context/attention-positioning.ts` | System block reordering |
| `src/context/prompt-frame.ts` | Typed prompt structure |
| `src/providers/prefix-optimizer/` | KV-cache-friendly message reordering |
| `src/providers/synesis-provider.ts` | Tier-based provider resolution |
| `src/providers/usage-telemetry-fetch.ts` | Upstream usage extraction |
| `src/compat/jitter-buffer.ts` | Volatile metadata extraction |
| `src/compat/sorted-tools.ts` | Deterministic tool schema serialization |
| `src/tool-prefix-cache/ToolPrefixCache.ts` | Tool execution result cache |
| `src/memory/summary-store.ts` | Hierarchical file/dir/project summaries |
| `src/memory/incremental-index.ts` | Structural symbol index |
| `src/state/artifact-store.ts` | Large payload offload store |
| `src/state/session-store.ts` | Redis session persistence |
| `src/telemetry/optimization-ledger.ts` | Per-request savings tracking |
| `src/telemetry/request-forensics.ts` | Payload size / prefix stability |
| `src/policy/deterministic-policy-engine.ts` | Budget enforcement |
