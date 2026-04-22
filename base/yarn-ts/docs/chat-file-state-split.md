# ChatState + FileState Split (State-Led Runtime)

This note documents the incremental refactor that makes Yarn prompt/governor context
state-led instead of transcript-led.

## Why this change

Historically, normalized transcript flow was still the dominant semantic substrate.
That allowed client/tool affordance residue (for example `unchanged since last read`)
and repeated assistant narration loops to leak into model reasoning as if they were
current objective truth.

The runtime already had strong file-memory primitives (`FileSnapshotRegistry`,
`ArtifactReadShadow`), but no peer first-class `ChatState` channel.

## Before

- **Session state:** persisted + in-memory flags in `index.ts`, but no dedicated
  semantic chat state object.
- **File state:** snapshot registry and artifact shadows existed, but model-facing
  file memory was implicit in reduced transcript/tool payloads.
- **Prompt assembly:** stable prefix + volatile context + transcript; no explicit
  ChatState/FileState channels.
- **Governor inputs:** mostly normalized message history + artifact shadows.

## After (incremental, no full rewrite)

## 1) First-class ChatState

`src/governance/chat-state.ts` introduces:

- `activeObjective`
- `phase`
- `unresolvedCorrections` / `resolvedCorrections`
- `lastAttemptSummary`
- `lastVerificationOutcome`
- `blockers`
- `currentFocusPaths`
- `transcriptSummary`
- `narrationResidueSummary`
- `pendingUserDirective`
- `completionStatus`

This state is derived conservatively from normalized messages. The transcript is still
an input signal, but semantic state is now explicitly materialized.

## 2) Model-facing FileState adapter

`src/governance/file-state.ts` introduces a canonical adapter over:

- `FileSnapshotRegistry` (path/hash/content/range/visibility truth)
- `ArtifactReadShadow` (stale/read-returned-content semantics)
- normalized `synesis_file_read` envelopes (affordance interpretation)

Per-path `FileStateEntry` captures:

- status (`available`, `partial`, `unchanged`, `stale`, `evicted`, `missing`)
- full-content availability
- last hash/read/edit turns
- stale-after-edit and read-returned-content
- source semantics (`full_content`, `meta_hint_replay`, `targeted_read_required`, etc.)

This keeps synthetic affordance text out of file truth.

## 3) Prompt assembly now carries explicit state channels

`PromptFrame` now includes:

- `chatState`
- `fileState`

The volatile block includes these channels before `WORKING_FRAME` and transcript tail
context, making state the primary semantic scaffold in prompt assembly.

## 4) Governor can consume state adapters

`ExecutionGovernorOptions` now accepts:

- `chatState` (objective cue override)
- `fileState` (guard fallback view)

Governor logic still remains backward-compatible with transcript-only behavior, but
can prioritize explicit state objective cues over stale transcript residue.
Initial rule migration now also consumes structured chat predicates for:

- completion-claim handling (`completionStatus`)
- repeated narration pressure (`narrationResidueSummary`)
- failure awareness (`lastVerificationOutcome`)

## 5) Stale-after-edit wiring completed

All `governToolCall(...)` paths now pass:

- `artifactShadows`
- `currentTurnIndex`
- `onEditTurn`

This closes the stale-after-edit loop by actually updating `artifactEditTurns` during
streaming and non-streaming tool call handling.

## 6) Cross-turn state continuity + first-class tracing

Follow-up hardening adds:

- compact `ChatStateSnapshot` and `FileStateSnapshot` persisted in session metadata
  (`chat_state_snapshot`, `file_state_snapshot`)
- `deriveChatState(..., { previousSnapshot })` fallback so compacted transcript windows
  retain the active objective/phase continuity signal
- governor pause envelopes enriched with:
  - `chat_state_summary`
  - `file_state_summary`
  - `evidence_delta`
  - `active_guards`
  - `artifact_context`
- request trajectory / trace context telemetry that now carries compact chat/file state
  summaries as structured fields

This makes debugging and training-data extraction state-native instead of requiring
fragile reconstruction from raw transcript residue.

## Weird UX/client affordance handling improvements

This split improves resilience in exactly the failure cases we observed:

- `unchanged since last read` is treated as file-memory semantics (replay/evicted/needs read),
  not as repository content.
- resolved corrections move to historical state and stop dominating active objective.
- repeated assistant “still fixing / still verifying” narration is compacted into
  residue summary instead of replayed as primary task context.
- active objective and phase are explicit fields, not only inferred from trailing prose.

## Prefix-cache safety

The refactor is intentionally incremental and cache-safe:

- stable prefix ordering is unchanged.
- Chat/File state channels are deterministic volatile blocks with bounded formatting.
- existing prefix optimizer behavior is preserved; no cache marker strategy changes.

This preserves efficiency while improving semantic grounding.
