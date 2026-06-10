# Yarn performance review (cluster + repo)

This note records a **2026-04** pass over live `synesis-yarn` logs in `synesis-yarn`, manifest review, and scripted probes. Use it to separate **upstream LLM time**, **Yarn middleware**, and **tool/sandbox** work.

## 1. Sample session correlation (request IDs)

From `oc logs deployment/synesis-yarn -n synesis-yarn` (recent window), a **Claude Code** session used:

- **Conversation**: `sessionKey` containing `claude-code`, `conversationId` `b6e1841b-467e-4ce6-b9d4-e142cb75464b`
- **Representative internal request IDs**: `req-0265f011-1614-413e-8238-3ec34af26876`, `req-f361f7f9-81a1-4419-aea9-e78f64a57ca8`, `req-1749c68f-44f0-49ad-a66e-d1bc3d379bb9`
- **Model label**: `synesis-core` on `/v1/messages?beta=true` (`debug_protocol` lines)
- **Per-request HTTP `responseTime`** (Fastify, end-to-end for one streamed turn): about **7–13 s** on sampled lines (e.g. ~9992 ms, ~9271 ms, ~13426 ms, ~11065 ms). These are **one turn** each, not full multi-minute jobs.

**Token pressure (dominant cost driver)**  
`raw_usage_from_sdk` on the same lines shows **~63k–70k input tokens** per turn with **no cache read** (`cacheReadTokens: 0`). That volume dominates prefill latency and cost versus Synesis prefetch (below).

**Evidence prefetch (small)**  
`evidence_prefetch_result_claude` for pattern `golangci_lint` reported **~22–36 ms** latency — not the bottleneck.

## 2. Tools vs LLM (dominant bucket)

| Observation | Interpretation |
|-------------|----------------|
| `responseTime` 7–13 s with **no Bash** in the same slice | Mostly **upstream generation + large context** (tens of thousands of input tokens), plus Yarn orchestration on the same request. |
| Turn with **Bash** `golangci-lint run ./...` immediately before a **~13.4 s** `responseTime` | Wall clock includes **local tool runtime** (golangci-lint) inside the agent loop; the next model turn still pays **prefill on huge history**. |
| No `mcp_tool_call` lines in the sampled tail | This session was **Claude Code / `/v1/messages`**, not the Yarn MCP HTTP tool path. For MCP, grep `mcp_tool_call` and use `elapsed_ms` when present. |

**Conclusion:** For this workload, **end-to-end slowness is primarily (a) very large prompts / history and (b) upstream inference time per turn**, not evidence prefetch. **Local tools** (e.g. golangci-lint, `make`) add **minutes** when invoked repeatedly in the loop, which matches “8 minutes for a few fixes” when the agent runs linters and full builds.

## 3. Qwen / vLLM tool-call parser alignment

- Yarn’s own diagnostics recommend verifying vLLM uses **`--tool-call-parser=qwen3_coder`** when repeated tool-arg repairs appear (`base/yarn-ts/src/index.ts`, messages around `qwen3_parser_mismatch_suspected`).
- The checked-in **self-hosted coder** manifest [`base/model-serving/deployment-vllm-coder.yaml`](../../base/model-serving/deployment-vllm-coder.yaml) currently sets **`--tool-call-parser=hermes`**.

**Action for operators:** If the served weights are **Qwen3-Coder** family, confirm against [vLLM recipes](../VLLM_RECIPES.md) and align the parser with the model; mismatch can cause **extra repair rounds** (higher latency and tokens). If the cluster actually serves a Hermes-named model, the manifest may be intentional — **match parser to the deployed checkpoint**.

## 4. OpenTelemetry (optional finer split)

Live deployment had **`SYNESIS_YARN_OTEL_ENABLED=false`** (OTLP endpoint not wired). Middleware spans such as `yarn.enrichment` are available in code (`base/yarn-ts/src/telemetry/otel.ts`) but **no-op** until OTel is enabled.

**When logs are not enough:** set `SYNESIS_YARN_OTEL_ENABLED=true` and a valid `OTEL_EXPORTER_OTLP_ENDPOINT`, redeploy, and compare span durations for enrichment vs persistence.

## 5. Tier compare / A/B

- Script: [`base/yarn-ts/scripts/tier-compare.ts`](../../base/yarn-ts/scripts/tier-compare.ts) — requires `SYNESIS_YARN_URL` (or `SYNESIS_YARN_EVAL_URL`) and a PAT (`SYNESIS_TEST_PAT_TOKEN` / `SYNESIS_TEST_AUTH` / `SYNESIS_TEST_TOKEN`). It runs **synthetic** `/v1/chat/completions` loads across tiers and prints avg/p95 latency plus Tier C / pruning counters.
- **Smoke run** with a dummy URL completes and prints zeros for failed requests; **meaningful numbers** need a reachable Yarn URL and auth.
- For qualitative A/B vs bare upstream, follow [`docs/clients/CANARY_PROMPT_PACK.md`](../clients/CANARY_PROMPT_PACK.md).

## 6. Concrete recommendations

1. **Context:** Reduce **turn size** (compaction, fewer tool outputs in history, session reset) so input tokens stay well **below ~65k** when possible — largest lever on prefill latency.
2. **Tools:** Prefer **narrow** lint/test commands and **cache** results in the workspace; avoid repeated full `golangci-lint ./...` / `make` when a scoped path suffices.
3. **Inference:** Validate **GPU sizing, queueing, and `max-model-len`** on the actual **synesis-core** backend; watch vLLM and provider logs for queue delays.
4. **Parser:** Reconcile **`tool-call-parser`** with the **exact** Qwen3-Coder checkpoint on self-hosted coder to avoid repair loops.
5. **Tracing:** Enable **OTel** temporarily if you need span-level proof of enrichment vs upstream time.

## 7. Admin traces

With `SYNESIS_YARN_PERSIST_USAGE_TO_DB=true`, completion records flow through the telemetry pipeline; use the **Admin** UI/API trace views (see `TraceRecord` in `packages/synesis-telemetry`) keyed by `trace_id` / `request_id` from logs for **latency_ms** and token fields aligned with this review.
