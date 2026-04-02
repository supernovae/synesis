# Optional second-stage prompt-injection scorer (design)

This document describes a **future, optional** layer for planner-ts — not implemented on the request hot path by default. It complements regex scanning in `@synesis/context-trust` while keeping heavy ML out of planner/yarn images: implement inference only in a dedicated microservice or offline batch job (same idea as the repository’s ML service boundary for app images).

## Goals

- Improve **precision** on borderline user text (e.g. academic discussion vs. real override attempts) where Tier-1 patterns alone false-positive or false-negative.
- **Zero added latency** for default deployments: scoring runs asynchronously, in batch, or only when an env-gated “strict” mode is enabled with explicit SLO buy-in.

## Non-goals

- Replacing regex scanning as the first line of defense (deterministic, fast, auditable).
- Loading `transformers` / `torch` inside planner-ts or yarn-ts.

## Proposed architecture

1. **Inputs:** `ScanResult` (or compact JSON: `patterns_found`, `event_type`, `confidence`, `source`, excerpt), message metadata (tenant, channel), optional hash of normalized text.
2. **Service:** Small HTTP service under `base/rag/` or `base/security/` (CPU or GPU optional) exposing e.g. `POST /v1/prompt-injection/score` → `{ score: number, label?: string }`. Implementation options: lightweight classifier ONNX, distilled model behind TEI-style boundary, or calls to an external API — chosen in a spike.
3. **Consumers:**
   - **Async path:** After `scanUserInput` returns `detected`, enqueue a job (or fire-and-forget with timeout) to the scorer; persist result for admin / security UI only.
   - **Strict mode (opt-in):** `SYNESIS_INJECTION_STRICT_SCORER=true` + scorer URL: block or reduce only when `regex.detected && scorer.score >= threshold`. Requires timeout budget (e.g. 50–150 ms) and fallback to regex-only if scorer unavailable.

## Rollout

1. Spike: offline evaluation on `scanner_vectors.json` + red-team sets; measure precision/recall vs. regex-only and vs. dual-signal.
2. Ship scorer service + admin visibility before any default blocking coupling.
3. Document operator knobs next to `SYNESIS_INJECTION_ACTION` and `SYNESIS_INJECTION_REQUIRE_DUAL_SIGNAL` in [SECURITY.md](./SECURITY.md).

## References

- OWASP LLM01 (prompt injection) — vocabulary for threats and mitigations.
- Literature on classifier-based PI detection (precision/recall vs. paraphrase attacks) — informs threshold choice, not a promise of completeness.
