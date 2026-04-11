# Context Optimization Enhancements (M10)

Milestone 10 adds 8 context optimization capabilities to the Yarn-ts pipeline, improving token efficiency, cache utilization, session intelligence, and compression observability.

## Architecture

The optimized request pipeline:

```
auth → policy → content-type dispatch → tool result reduction (55 families + JSON compaction)
     → validation normalization → stable prefix partitioning → working frame + manifest
     → attention-aware positioning → session context injection → artifact tool injection
     → provider call → history tracking → sawtooth checkpoint → session continuity save
```

## Enhancements

### E1: Sawtooth Checkpoint Fix (P0)

**Problem:** `toolCallsSinceCheckpoint` was never incremented, streaming paths didn't append to history, and compacted state was never injected into subsequent requests.

**Fix:**
- Increment counter for every tool-result message in both OpenAI and Claude paths
- Append user and assistant messages to `session.history` in all paths (streaming + non-streaming)
- Inject compacted `<ARCHITECTURAL_STATE>` as the first system message on subsequent requests
- Telemetry: `sawtoothContext` in `/health/telemetry` (active sessions, checkpointed sessions, history depth)

**Files:** `src/index.ts`

### E2: Stable Prefix Partitioning

**Concept:** Provider KV caches (Anthropic 90% read discount, OpenAI automatic prefix caching) require byte-identical message prefixes. Previously, all system content was merged into one message that changed every request.

**Implementation:**
- `StablePrefixService` splits system content into an immutable prefix (base instructions + client adapter) and volatile suffix (working frame, manifest)
- Prefix is always the first system message, byte-identical across requests for the same session
- Tracks `prefixHash`, `prefixCacheHits`, `uniquePrefixHashes` in telemetry
- Session eviction cleans up prefix cache

**Files:** `src/context/stable-prefix.ts`, `src/index.ts`

### E3: Structured JSON Compaction

**Concept:** Many tool outputs are JSON arrays (API responses, DB queries) that family reducers don't handle. Generic JSON compaction picks these up.

**Implementation:**
- Detects valid JSON arrays with 3+ homogeneous items
- Crushability gate: checks structural similarity and signal field presence
- Elbow budget: `sqrt(N)*2` capped at 20 for large arrays
- Selection: boundary items (first 2, last 2) + anomaly items (error/fail keywords) + evenly-sampled middle
- Output: `<JSON_COMPACTED>` block with artifact handle for full retrieval
- Sits between family reducer (miss) and artifact-only fallback

**Files:** `src/reduction/json-compactor.ts`, `src/reduction/tool-result-reducer.ts`

### E4: Attention-Aware Context Positioning

**Based on:** Liu et al. 2023 "Lost in the Middle" — [AWESOME_PAPERS.MD](AWESOME_PAPERS.MD#context-attention-and-long-prompts)

**Concept:** LLMs attend strongly to beginning and end of context (U-curve), poorly to the middle. System blocks are now positioned accordingly.

**Placement rules:**
- **Begin (high attention):** `<ARCHITECTURAL_STATE>`, `<SESSION_CONTINUITY>`, `<CLIENT_ADAPTER>`, stable prefix
- **Middle (low attention):** `<PROJECT_MANIFEST>`, conversation history
- **End (high attention):** `<WORKING_FRAME>` (goals, active files, pending checks)

**Files:** `src/context/attention-positioning.ts`, `src/index.ts`

### E5: Reversible Artifact Retrieval

**Concept:** The artifact store saves full raw output, but the model couldn't access it. Now `synesis_artifact_retrieve` is injected as a tool when artifacts exist.

**Implementation:**
- `ArtifactRetrievalService` manages tool injection (OpenAI + Claude format) and retrieval with optional keyword query
- Non-streaming paths auto-resolve artifact tool calls (up to 3 rounds) transparently
- Makes lossy compression effectively lossless: the model can always retrieve full content
- Telemetry: `artifactRetrieval` with `retrievalCount`, `missCount`, `queryFilterCount`

**Files:** `src/state/artifact-retrieval.ts`, `src/state/artifact-store.ts`, `src/index.ts`

### E6: Session Continuity

**Concept:** New sessions lose all context from previous sessions. Now semantic state is persisted in Redis and injected into the next session.

**Implementation:**
- `SessionContinuityService` extracts `currentTask`, `keyFindings`, `decisions`, `recentFiles` from conversation history using heuristic phrase matching
- Continuity is saved to Redis per-user on session save
- On new session for the same user, previous continuity is loaded and injected as `<SESSION_CONTINUITY>` system block
- Positioned in the begin zone (high attention) per E4

**Files:** `src/context/session-continuity.ts`, `src/state/session-store.ts`, `src/index.ts`

### E7: Compression Efficiency Index

**Concept:** Single composite metric tracking overall context optimization effectiveness.

**Formula:**
```
score = reducerHitRate * 0.30 + artifactOffloadRate * 0.15 + tokenSavingsRate * 0.45 + jsonCompactionRate * 0.10
```

- `reducerHitRate`: % of tool results matched a family reducer
- `artifactOffloadRate`: % of results offloaded to artifact store
- `tokenSavingsRate`: `(rawChars - reducedChars) / rawChars`
- `jsonCompactionRate`: % of results handled by JSON compactor

Exposed in `/health/telemetry` as `compressionEfficiencyIndex`.

**Files:** `src/index.ts`

### E8: Content-Type Dispatch

**Concept:** Pre-filter tool output by content type before the family classifier runs. Routes to specialized handlers.

**Detection:**
- `json-array`: valid JSON array with 3+ items → handled by JSON compactor (E3)
- `json-object`: valid JSON object → key summary with truncated deep values
- `log-stream`: 40%+ lines match timestamp/level patterns → head/tail with error preservation
- `text`: everything else → pass to family classifier

**Files:** `src/reduction/content-dispatch.ts`, `src/reduction/tool-result-reducer.ts`

## Telemetry

`GET /health/telemetry` now includes:

```json
{
  "sawtoothContext": { "activeSessionCount", "checkpointedSessions", "totalHistoryEntries" },
  "stablePrefix": { "partitionsBuilt", "prefixCacheHits", "uniquePrefixHashes" },
  "artifactRetrieval": { "retrievalCount", "missCount", "queryFilterCount" },
  "attentionPositioning": { "positionedCount", "beginBlocksPlaced", "endBlocksPlaced" },
  "sessionContinuity": { "extractionCount", "continuityBlocksEmitted", "avgFindingsPerSession" },
  "compressionEfficiencyIndex": { "score", "reducerHitRate", "tokenSavingsRate", "..." },
  "toolResultReduction": { "...", "jsonCompactionCount", "contentDispatchCount", "contentDispatch": { "byType": {...} } }
}
```

## Test Coverage

All enhancements include dedicated test suites:
- `tests/stable-prefix.test.ts` (5 tests)
- `tests/artifact-retrieval.test.ts` (10 tests)
- `tests/json-compactor.test.ts` (10 tests)
- `tests/attention-positioning.test.ts` (7 tests)
- `tests/session-continuity.test.ts` (7 tests)
- `tests/content-dispatch.test.ts` (14 tests)

Total: **306 tests passing** (up from 249 pre-M10).
