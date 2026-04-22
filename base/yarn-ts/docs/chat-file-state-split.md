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

## 7) Objective epoch fence + relevancy gate

To reduce "entire session" bleed-through into current decisions, the runtime now
applies an objective-scoped context pass:

- `objective_epoch_*` metadata tracks the active objective epoch and anchor user turn
- prompt/governor context is fenced to the active objective boundary ("now -> forward")
- pre-boundary history is not replayed wholesale; instead a bounded
  `<SYNESIS_RELEVANT_EVIDENCE>` block carries only top-scoring, objective-relevant
  evidence (path/objective-token aligned)
- scope decisions are emitted as `objective_scope_applied` session telemetry events

This keeps context forward-looking and state-led while preserving deterministic,
cache-safe behavior.

## 8) State confidence + deterministic re-grounding

The runtime now computes per-turn state confidence from both channels:

- `chat_confidence` (objective/directive/focus clarity)
- `file_confidence` (snapshot quality: available vs stale/partial/evicted)
- `overall_confidence` (weighted aggregate)

When confidence is low in action phases (`edit`/`verify`/`recover`/`finalize`), Yarn
triggers a deterministic re-grounding contract:

- policy narrows to exactly one `Read` tool call
- expected read path is pinned from focus/stale file state
- a `SYNESIS_STATE_CONFIDENCE` guidance block is injected
- telemetry records `state_confidence_reground_required`

This prevents low-confidence autonomous continuation from drifting on stale context
and keeps the next step "refresh first, then continue."

## 9) State transition ledger (training-grade)

Yarn now emits a structured transition ledger per request:

- `from_state` (previous compact state snapshot)
- `to_state` (current compact state snapshot)
- `event` (tool sequence, governor rules/pause, evidence delta, outcome)
- `delta` (objective epoch movement, confidence changes, stale/partial/evicted file deltas,
  changed fields)

This is emitted as `state_transition_v1` session telemetry and also summarized in
request trajectory + trace context. The result is explicit supervision data for
"state moved in the right direction" rather than inferring transitions from raw transcript text.

## 10) Transition quality labeler + materializer

Each `state_transition_v1` record now carries a deterministic quality assessment:

- `quality.label`: `forward_progress` | `stalled` | `regressed` | `reground_required`
- `quality.score`: bounded `[-1, 1]` scalar for reward/ranking pipelines
- `quality.reasons`: explicit reason codes (confidence trend, stale-file deltas, evidence delta, governor pauses)
- `quality.recommended_action`: `continue` | `recover` | `reground`

A compact `state_transition_training_v1` row is materialized from every transition record and
attached to the transition event metadata. `request_trajectory_v1.training_signals` also includes
`state_transition_quality_*` fields so supervised and reward datasets can consume labels directly
without replaying raw transcripts.

## 11) Online quality calibration pass

Quality thresholds are now calibrated from recent observed transitions instead of staying fixed:

- Session metadata stores a rolling sample window (`state_transition_quality_samples`)
- A deterministic calibrator computes updated `forward_progress_min` and `regressed_max`
  from positive/negative score distributions (with smoothing + minimum sample guards)
- Calibrated thresholds are persisted in metadata (`state_transition_quality_thresholds`)
  and reused for subsequent transition labeling
- When thresholds move meaningfully, Yarn emits `state_transition_quality_calibration_v1`
  so threshold drift is traceable and auditable

This keeps the quality labeling policy adaptive while remaining deterministic and replay-safe.

## 12) Cross-session global calibrator

In addition to per-session calibration, Yarn now maintains an in-process global
calibration registry with two scopes:

- `org_model` (organization + model)
- `model` (model-wide fallback across organizations)

Each request contributes a calibration sample to both scopes. Global thresholds are
resolved and blended with session thresholds before quality labeling, then refreshed
after observation. This lets new sessions start from previously learned quality
boundaries rather than cold defaults, while preserving deterministic scoring rules.

When global thresholds shift materially, Yarn emits
`state_transition_quality_global_calibration_v1` for auditability.

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
