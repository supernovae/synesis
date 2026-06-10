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

## Validation normalization

Validation output is normalized before it reaches the model. The runtime tries
deterministic parsers first, enriches findings with root-cause/action hints,
and falls back safely when output is unknown:

1. Structured parsers: SARIF, JUnit XML, Checkstyle XML, and common JSON
   diagnostics.
2. Line parsers: TypeScript, Ruff, ESLint, pytest, mypy, Terraform, and similar
   validator text.
3. Tier C fallback: optional admin-configured `coder-normalizer` role for messy
   output that deterministic parsers cannot classify.
4. Generic fallback: compact first-signal summary plus artifact retention.

Current Tier C controls are defined in `base/yarn-ts/src/config.ts`:

| Env var | Default | Purpose |
|---------|---------|---------|
| `SYNESIS_YARN_VALIDATION_TIER_C_ENABLED` | `false` | Enable LLM fallback for unclassified validation output. |
| `SYNESIS_YARN_VALIDATION_TIER_C_ROLE` | `coder-normalizer` | Admin role used for fallback inference. |
| `SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS` | `1500` | Timeout budget for fallback inference. |
| `SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS` | `24000` | Raw-output slice passed to fallback inference. |
| `SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS` | `8` | Maximum fallback findings returned to the model. |

Relevant code: [`../validation/normalizer.ts`](../validation/normalizer.ts),
[`../validation/parsers/`](../validation/parsers/), and
[`enrich-bridge.ts`](enrich-bridge.ts).

## Reducer registry

Command-aware reducers compact common tool output families before prompt
admission. Classification uses command/tool hints first, then content
fingerprints for generic shell output. Reducers must return `null` when they
cannot safely parse a payload; the caller then falls back to an artifact
summary instead of blocking the request.

Runtime controls:

| Env var | Default | Purpose |
|---------|---------|---------|
| `SYNESIS_YARN_REDUCERS_ENABLED` | `true` | Master reducer kill switch. |
| `SYNESIS_YARN_REDUCER_DISABLED_FAMILIES` | empty | Comma-separated reducer families to disable. |
| `SYNESIS_YARN_REDUCER_MIN_CONFIDENCE` | `0.6` | Minimum classifier confidence for reducer output. |
| `SYNESIS_YARN_REDUCER_PROFILE` | `balanced` | Reduction profile: `balanced`, `aggressive`, or `ultra`. |

Development commands:

```bash
cd base/yarn-ts
npm run bench:reducers
npm run verify:live
npm run verify:ab
npm run scaffold:reducer -- <family-name>
```

Live verification uses fixtures in `tests/fixtures/reducers/` and
`tests/fixtures/live/`, exercises deployed Yarn routes, and checks telemetry
counter movement. See [`../../../docs/development/TESTING.md`](../../../docs/development/TESTING.md#10-yarn-ts-live-verification-reducers).

## Related code

- [`transcript-pruning.ts`](transcript-pruning.ts) — transcript budget pruning; stubs may include `artifact_handle`.
- [`tool-result-reducer.ts`](tool-result-reducer.ts) — guided trim and reducers; trim paths attach handles when retention is on.
- [`classifier.ts`](classifier.ts) and [`registry.ts`](registry.ts) — family classification and reducer dispatch.
- [`ingress-cap.ts`](ingress-cap.ts) — optional max size per tool message on ingest.
- [`../state/artifact-store.ts`](../state/artifact-store.ts) — in-process LRU storage for retrieval tool.
- [`../state/tool-blob-tier.ts`](../state/tool-blob-tier.ts) — optional interface for a future **replica-safe** blob tier (Redis/S3); not wired by default.
