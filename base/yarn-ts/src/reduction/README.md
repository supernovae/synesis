# Reduction layer: model-safe harness invariants

Optimizations that remove or compress bytes from the model-visible transcript must follow these invariants so agents do not loop on “missing” context.

## H1 — No silent loss

If content is dropped or replaced, the stub or guardrail must state **what** was removed (tool name, character count, reason code). The model must not see an unchanged-looking payload that is actually truncated.

## H2 — Recoverable

Whenever Yarn stores the original bytes (e.g. `ArtifactStore.putToolResult`), the model-facing text must include a stable **`artifact_handle`** and point to recovery via **`synesis_artifact_retrieve`** (optional `query` for line filtering). If nothing was stored, the stub must prescribe a single concrete action (e.g. re-read, narrow grep).

## H3 — Bounded memory

Yarn must not rely on unbounded single strings for tool output. Ingress caps, artifact **max payload** limits, and streaming/rejection paths prevent OOM from huge logs.

## H4 — Governor / intervention non-contradiction

At most one primary “steering” intervention should dominate adapter-specific pivots when **policy precheck**, **edit-miss recovery**, or **governor soft-fail pause** already applies. Skipped interventions are logged under `synesis_intervention` / `adapter_pivot_skipped`.

## Related code

- [`transcript-pruning.ts`](transcript-pruning.ts) — transcript budget pruning; stubs may include `artifact_handle`.
- [`tool-result-reducer.ts`](tool-result-reducer.ts) — guided trim and reducers; trim paths attach handles when retention is on.
- [`ingress-cap.ts`](ingress-cap.ts) — optional max size per tool message on ingest.
- [`../state/artifact-store.ts`](../state/artifact-store.ts) — in-process LRU storage for retrieval tool.
- [`../state/tool-blob-tier.ts`](../state/tool-blob-tier.ts) — optional interface for a future **replica-safe** blob tier (Redis/S3); not wired by default.
