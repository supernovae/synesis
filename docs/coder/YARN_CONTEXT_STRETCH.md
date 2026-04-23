# Yarn Context Stretch Architecture

How Yarn makes a 100k token window behave like a much larger one, and what
happens when context pressure grows.

## Problem

Large-repository coding sessions routinely generate far more context than any
single prompt window can hold.  A naïve approach simply truncates old messages,
losing file contents, verification results, and plan state.  The agent then
re-reads files it already saw, re-runs tests it already passed, and loses track
of multi-step plans — all of which burn tokens and erode session quality.

## Seven Layers of Context Preservation

Yarn applies a layered pipeline.  Each layer preserves information that would
otherwise be evicted, keeping it either **on-prompt** (inside the token window)
or **off-prompt** (recoverable on demand).

| Layer | Where | What It Preserves |
|-------|-------|-------------------|
| **1 — Content-Addressed Dedup** | On-prompt | Replaces repeated identical file reads with a `<read_cache_stub>` or `<replay_envelope>` referencing the first read.  Saves thousands of tokens per duplicate. |
| **2 — Transcript Pruning** | On-prompt + ArtifactStore | Collapses large tool results into `<TOOL_RESULT_PRUNED>` stubs with preview + `artifact_handle`.  Full payload persists in the ArtifactStore for recovery via `synesis_artifact_retrieve`. |
| **3 — Objective Scope** | On-prompt | Identifies the current objective's anchor message and slices the prompt to that boundary, keeping the working tail.  Pre-boundary messages are scored for relevance; the top-N are summarised in a `<SYNESIS_RELEVANT_EVIDENCE>` system block. |
| **4 — Context Budget Manager** | On-prompt + ArtifactStore | Tiered compaction triggered by token thresholds (soft → heavy → emergency).  Soft compaction collapses stale file reads, folds passing verifications, condenses narration.  Heavy compaction drops low-retention messages entirely and injects a `<CONTEXT_CHECKPOINT>`.  All collapsed/dropped content is persisted to the ArtifactStore. |
| **5 — FileSnapshotRegistry** | Off-prompt | In-memory registry of file content keyed by path + content hash.  When a file read would be deduplicated, the registry already holds the canonical content. |
| **6 — ArtifactStore** | Off-prompt | In-memory (+ optional Redis replica) key-value store of pruned tool result payloads.  Any `artifact_handle` embedded in a stub can be resolved back to the original content.  TTL 1 hour, max 500 records, 1 MB per payload. |
| **7 — Sawtooth Compression** | Off-prompt | Periodically compresses `session.history` into a running summary.  Cross-session recall allows limited long-term memory to survive session restarts. |

## What Is Preserved vs. Lost

| Category | Preserved | At Risk |
|----------|-----------|---------|
| Latest user directive | Always in working window | Never lost |
| Active plan state | Plan shadow in metadata + latest plan read in context | Superseded plan reads are folded |
| Current file focus | Focus paths drive retention scoring | Old file reads outside scope boundary are replaced with stubs |
| Verification outcomes | Latest per-command kept; earlier passes folded | Intermediate passing results condensed |
| Exploration output | Preview + artifact handle survive | Full grep/search output only via artifact recovery |
| Assistant narration | Recent narration kept | Historical narration condensed to 80-char preview |

## Improvements Shipped (Apr 2026)

### 1. Artifact Bridge Across Objective Scope

**Gap**: When objective scope dropped pre-boundary messages, any `artifact_handle`
values embedded in those messages were lost — the agent could no longer request
recovery of those payloads.

**Fix**: `applyObjectiveScope` now scans all dropped messages for `artifact_handle`
references and emits a `<SYNESIS_AVAILABLE_ARTIFACTS>` system block listing
recoverable handles.  This block is injected alongside `<SYNESIS_RELEVANT_EVIDENCE>`.

**File**: `governance/objective-scope.ts` — `extractArtifactHandles()`, `artifactBridgeBlock`

### 2. ArtifactStore Integration in Budget Compaction

**Gap**: The Context Budget Manager's soft and heavy compaction replaced content
with stubs but did not persist the original payload.  Unlike transcript pruning,
these compaction paths had no ArtifactStore integration.

**Fix**: `evaluateContextBudget` now accepts an optional `artifactStore`.  Soft
compaction writes `artifact_handle` attributes into `<FILE_SHADOW>` and
`<STALE_EXPLORATION>` stubs.  Heavy compaction persists dropped tool results
before eviction.

**Files**: `governance/context-budget-manager.ts` — `retainToArtifact()`,
updated `applySoftCompaction`, `applyHeavyCompaction`, `evaluateContextBudget`

### 3. Capped `guardedFallbackRead`

**Gap**: `guardedFallbackRead` read entire files regardless of size.  A single
2 MB minified bundle could consume most of the context budget.

**Fix**: Reads are now capped at 200 KB (`FALLBACK_READ_MAX_BYTES`).  Files
exceeding this cap are truncated and returned with `completeness: "partial"`.

**File**: `reduction/file-snapshot-registry.ts`

### 4. Plan Path Retention in Budget Decisions

**Gap**: `buildRetentionContext` was called with an empty `planFilePaths` array,
meaning plan-related messages received no retention boost during budget compaction.

**Fix**: Both OAI and Claude budget paths now extract the session's
`plan_file_path` from metadata and pass it to `buildRetentionContext`.  Messages
referencing plan files receive an `artifact_shadow` tier classification, making
them resistant to compaction.

**File**: `index.ts` — `oaiPlanPaths` / `claudePlanPaths`

### 5. Scaled Evidence Window

**Gap**: `maxRelevantEvidence` was fixed at 6, regardless of session length.
Long sessions (200+ messages) have more pre-boundary history worth summarising.

**Fix**: Evidence count now scales with message count:
- ≤100 messages → 6 evidence items
- 101–200 messages → 9 evidence items
- >200 messages → 12 evidence items

**File**: `index.ts` — `scaledEvidence` in `applyObjectiveScopeAndPersist`

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS` | `100000` | Hard prompt token ceiling (request rejected above this) |
| `SYNESIS_YARN_CONTEXT_BUDGET_ENABLED` | `true` | Enable tiered budget compaction |
| `SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS` | `0` (uses hard limit) | Override ceiling per deployment |
| `SYNESIS_YARN_TRANSCRIPT_PRUNE_ARTIFACT_RETENTION_ENABLED` | `true` | Enable ArtifactStore writes during pruning |
| `SYNESIS_YARN_ARTIFACT_MAX_COUNT` | `500` | Max artifact records in memory |
| `SYNESIS_YARN_ARTIFACT_TTL_MS` | `3600000` | Artifact expiry (1 hour) |

## How Recovery Works

When the agent encounters a stub like:

```xml
<TOOL_RESULT_PRUNED tool="bash" chars="45231" artifact_handle="art_abc123" recovery="synesis_artifact_retrieve">
first 120 chars of output...
Recover full output via synesis_artifact_retrieve with artifact_handle when present.
</TOOL_RESULT_PRUNED>
```

It can call the `synesis_artifact_retrieve` tool with `artifact_handle="art_abc123"`
to get the full payload back into context, on demand.

## See Also

- [Transcript Pruning](TRANSCRIPT_PRUNE_SAFE_CONTEXT.md)
- [Sawtooth Architecture](YARN_TS_SAWTOOTH_ARCHITECTURE.md)
- [Context and Recall Architecture](context-and-recall-architecture.md)
- [Safety and Reliability](safety-reliability-and-fail-safe.md)
