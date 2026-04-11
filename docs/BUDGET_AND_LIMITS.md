# Budget, Limits & Temperature Reference

Single-source reference for all token budgets, context limits, and temperature
settings across the Synesis pipeline. Use this when tuning throughput, diagnosing
truncation, or auditing model behavior.

Last updated: 2026-03-28

---

## Token Budget Scaling

Budgets scale with **difficulty** (0.0–1.0, set by the entry classifier). The
formula is always `base + difficulty × (max − base)` unless noted.

### Writer (synthesis / final answer)

| Setting | Value | File |
|---|---|---|
| `trivial_writer_budget` | 768 | `config.py` |
| `writer_budget_base` | 2,048 | `config.py` |
| `writer_budget_max` | 32,768 | `config.py` |

- **Trivial** (difficulty < 0.15): 768 tokens via direct-stream fast-path
- **Easy** (difficulty 0.0): 2,048 tokens
- **Hard** (difficulty 1.0): 32,768 tokens

Scaling: `scaled_writer_budget(d) = 2048 + d × (32768 − 2048)`

### planner-ts (`base/planner-ts`)

Pure scaling lives in [`base/planner-ts/src/budgets.ts`](../base/planner-ts/src/budgets.ts); defaults are loaded via [`loadConfig`](../base/planner-ts/src/config.ts) (`SYNESIS_PLANNER_TS_*`). The entry classifier applies **tier ceilings** from [`model-tiers.ts`](../base/planner-ts/src/model-tiers.ts): `min(scaled_budget, tier.writerMaxTokens)` (and likewise for critic) so named tiers can cap output below the global curve.

| Setting (env) | Default | Notes |
|---|---|---|
| `SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET` | 768 | Trivial fast-path writer |
| `SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE` | 2,048 | Scaled writer at difficulty 0 |
| `SYNESIS_PLANNER_TS_WRITER_BUDGET_MAX` | 32,768 | Scaled writer at difficulty 1 (before tier clamp) |
| `SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE` | 800 | Critic linear scale |
| `SYNESIS_PLANNER_TS_CRITIC_BUDGET_MAX` | 4,000 | Critic scale endpoint before global clamp |
| `SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS` | 4,096 | Hard ceiling on critic `max_tokens` |
| `SYNESIS_PLANNER_TS_PLANNER_MAX_TOKENS` | 2,000 | LLM JSON plan output (base; adaptive scaling may raise) |
| `SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS` | 300,000 | LLM HTTP timeout (ms) |

### Adaptive planner budget

The planner's `max_tokens` scales adaptively based on task signals to prevent
JSON truncation on complex prompts while keeping simple tasks efficient.

| Condition | Budget boost | Cumulative example |
|---|---|---|
| Base | 2,000 | 2,000 |
| `difficulty >= 0.7` | +800 | 2,800 |
| `cynefin_domain` ∈ {complex, chaotic} | +800 | 3,600 |
| `difficulty >= 0.85` | +400 | 4,000 |
| **Hard ceiling** | **4,096** | — |

Implemented in `computeAdaptivePlannerCap()` in
[`llm-planner.ts`](../base/planner-ts/src/nodes/llm-planner.ts). The effective
cap (not the static env default) is reported in planner span `budgetSpanMetadata`
so traces accurately reflect what was sent to the LLM.

**Why:** A complex architecture prompt classified as `chaotic` with difficulty
0.92 previously hit 98.9% budget utilization at 1,200 tokens, truncating JSON
mid-object. The adaptive cap gives it 4,000 tokens — same model, valid output.

**Trace metadata** (see [`pipeline.ts`](../base/planner-ts/src/pipeline.ts), [`budgets.ts`](../base/planner-ts/src/budgets.ts) `budgetSpanMetadata`):

Every LLM-calling span (`writer`, `critic`, `planner`) emits a uniform set of budget fields via `budgetSpanMetadata(maxOutputTokens, usage)`:

| Field | Type | Description |
|---|---|---|
| `max_output_tokens` | `number` | Generation cap sent to the LLM for this span |
| `prompt_tokens` | `number` | Prompt tokens consumed (from usage) |
| `completion_tokens` | `number` | Completion tokens generated |
| `total_tokens` | `number` | Total tokens (prompt + completion) |
| `budget_utilization` | `number?` | `completion_tokens / max_output_tokens` (omitted when cap is 0) |

Additionally, `entry_pipeline` records `writer_max_tokens`, `critic_max_tokens`, `difficulty`, `task_is_trivial`, and `model_tier` so resolved caps are visible immediately after classification.

Use `budget_utilization` to detect under-use (wasted headroom) or near-saturation (possible truncation). Filter spans with `jq '.metadata.budget_utilization > 0.9'` to find truncation-risk calls.

**LiteLLM:** Each request’s effective generation limit is the minimum of the **LiteLLM route** `max_tokens` (from admin Model Registry / static gateway config) and the **provider** limit. Planner-ts still sends `max_tokens` on each node; the gateway may clamp further.

**`base/planner/`:** YAML ontology and taxonomy assets for **chat** (planner-ts), not a separate Python API runtime. This doc’s *intent* and formulas align with planner-ts behavior; some historical file references below may still cite old filenames — prefer `base/planner-ts/src/` when in doubt.


### Executor (text-mode responses)

| Setting | Value | File |
|---|---|---|
| `_MIN_BUDGET` | 1,024 | `writer.py` (hardcoded) |
| `_MAX_BUDGET` | 16,384 | `writer.py` (hardcoded) |
| Plan-required floor (difficulty ≥ 0.6) | 8,192 | `writer.py` |
| Plan-required floor (difficulty < 0.6) | 4,096 | `writer.py` |
| Default floor (no plan) | 1,536 | `writer.py` |
| Brevity cap (low difficulty) | 1,536 | `writer.py` |
| Social acknowledgment | 256 | `writer.py` |

Scaling: `token_budget = 1024 + (16384 − 1024) × difficulty^1.5`

The exponent (1.5) keeps moderate prompts lean — the headroom primarily
benefits prompts above ~0.6 difficulty.

### Section Workers

| Setting | Value | File |
|---|---|---|
| `section_budget_base` | 1,024 | `config.py` |
| `section_budget_max` | 8,192 | `config.py` |

### Evidence

| Setting | Value | File |
|---|---|---|
| `evidence_budget_chars` | 24,000 chars | `config.py` |
| `evidence_budget_chars_max` | 60,000 chars | `config.py` |

Evidence is measured in characters (not tokens). The writer applies a safety
guard: `max_evidence = (compiler_model_context × 4) − (writer_budget_max × 4) − 8000`
to prevent evidence from starving the output budget.

---

## Context Window Limits

| Setting | Value | File | Notes |
|---|---|---|---|
| `compiler_model_context` | 131,072 | `config.py` | Safe for OpenRouter and Qwen3 (128K native) |
| `curator_max_total_tokens` | 8,192 | `config.py` | Hard cap on Worker prompt context |

---

## LiteLLM Gateway — max_tokens

These cap the output tokens LiteLLM will request from the backend model.
If the planner requests more, LiteLLM silently clamps.

### Base config (`base/gateway/litellm-config.yaml`)

| Model | max_tokens | Role |
|---|---|---|
| `synesis-agent` | 32,768 | Pipeline entry (Open WebUI → planner) |
| `synesis-router` | 4,096 | Classification, planning, advisor |
| `synesis-critic` | 4,096 | Evaluation, scoring |
| `synesis-general` | 32,768 | Writer, synthesis |
| `synesis-coder` | 16,384 | IDE direct (agentic coding) |
| `synesis-thinking` | 16,384 | R1 thinking model (Open WebUI) |

### OpenRouter overlay (`overlays/openrouter/litellm-config-openrouter.yaml`)

| Model | max_tokens | OpenRouter Model |
|---|---|---|
| `synesis-agent` | 32,768 | (planner, not via OpenRouter) |
| `synesis-router` | 4,096 | `x-ai/grok-4-fast` |
| `synesis-general` | 32,768 | `deepseek/deepseek-v3.2` |
| `synesis-critic` | 4,096 | `deepseek/deepseek-r1-distill-qwen-32b` |
| `synesis-coder` | 16,384 | `qwen/qwen-2.5-coder-32b-instruct` |
| `synesis-thinking` | 16,384 | `deepseek/deepseek-r1-distill-qwen-32b` |
| `synesis-summarizer` | 2,048 | `x-ai/grok-4-fast` |

---

## Temperature Settings

Temperatures are set at **two levels**: the LiteLLM gateway config (default for
direct API calls) and the planner code (overrides the gateway for pipeline calls).

### Planner code — per-node temperatures

| Node / Context | Model Role | Temperature | Rationale |
|---|---|---|---|
| `router.py` — routing & classification | Router | 0.0 | Deterministic routing decisions |
| `router.py` — evidence summarization | Router | 0.0 | Faithful compression |
| `frame_extractor.py` — structured extraction | Router | 0.1 | Structured JSON output |
| `cohesion.py` — cohesion checks | Router | 0.0 | Binary coherence decisions |
| `strategic_advisor.py` — proceed/skip | Router | 0.0 | Binary yes/no |
| `planner_node.py` — plan decomposition | Router | 0.1 | Plans need reproducibility |
| `critic.py` — evaluation & scoring | Critic | 0.1 | Consistent quality assessments |
| `writer.py` — default LLM init | General | 0.2 | Safe default for varied tasks |
| `writer.py` — thinking mode (complex) | General | 0.6 | Qwen3 recommended for thinking |
| `writer.py` — direct stream (no plan) | General | 0.2 | Straightforward answers |
| `writer.py` — direct stream (planned) | General | 0.3 | Planned synthesis |
| `writer.py` — trivial fast-stream | General | 0.4 | Casual, conversational |
| `writer.py` — writer synthesis | General | 0.3 | Balanced fluency + grounding |
| `graph.py` — _writer_pass | General | 0.3 | Pre-writer formatting |
| `final_answer_compiler.py` — compile | General | 0.3 | Section synthesis |
| `history_summarizer.py` | Summarizer | 0.1 | Faithful compression |

### LiteLLM gateway — default temperatures

These apply when clients call models directly (not through the planner pipeline).

| Model | Temperature | Role | Notes |
|---|---|---|---|
| `synesis-agent` | 0.2 | Pipeline entry | Planner manages internal temps |
| `synesis-router` | 0.1 | Classification | Low for deterministic routing |
| `synesis-critic` | 0.1 | Evaluation | Consistent scoring |
| `synesis-general` | 0.3 | Writer | Balanced for synthesis |
| `synesis-coder` | 0.2 | Code generation | Precision for code |
| `synesis-thinking` | 0.2 | R1 thinking | R1-Distill's CoT adds its own diversity |
| `synesis-summarizer` | 0.1 | Compression | Faithful to source |

### Temperature guidelines by role

| Role | Range | Why |
|---|---|---|
| Routing / classification | 0.0–0.1 | JSON schema adherence, deterministic decisions |
| Plan decomposition | 0.0–0.1 | Reproducible task breakdowns |
| Evaluation / critic | 0.0–0.1 | Consistent quality scores |
| Summarization | 0.0–0.1 | Faithful compression, no hallucination |
| Code generation | 0.0–0.2 | Syntactic precision |
| Writer synthesis | 0.3–0.5 | Fluent prose while grounded in evidence |
| Thinking mode (Qwen3) | 0.6 | Per Qwen3 official recommendation for reasoning |
| Casual / trivial | 0.3–0.5 | Natural conversational tone |

---

## Other Pipeline Limits

| Setting | Value | File | Notes |
|---|---|---|---|
| `max_tokens_per_request` | 100,000 | `config.py` | Global hard ceiling |
| `max_executor_tokens` | 0 (disabled) | `config.py` | Per-node override (0 = use global) |
| `max_iterations` | 3 | `config.py` | Retry loop ceiling |
| `node_timeout_seconds` | 180 | `config.py` | Per-node LLM call timeout |
| `critic_max_tokens` | 4,096 | `config.py` | CriticOut budget |
| `frame_repair_max_tokens` | 1,024 | `config.py` | Frame extractor LLM repair |
| `router_max_summary_tokens` | 2,000 | `config.py` | Evidence packet summaries |
| `depth_mode_max_parallel` | 12 | `config.py` | Concurrent section workers |
| `crag_max_web_queries` | 8 | `config.py` | Web search ceiling per run |
| `max_cited_sources` | 5 | `config.py` | Sources shown in response |

---

## Inference Mode (Full vs Selective)

The `inference_mode` setting (`SYNESIS_INFERENCE_MODE` env var) controls how
aggressively the pipeline gates safeguards. Can also be overridden per-request
via the `X-Synesis-Inference-Mode` HTTP header.

| Threshold | Full | Selective | Effect |
|---|---|---|---|
| RAG disable below | 0.3 | 0.5 | More prompts skip retrieval |
| Frame repair above | 0.4 | 0.6 | Fewer LLM repair calls |
| Entry fast-path below | 0.3 | 0.5 | More prompts skip advisor + frame |
| Critic skip below | 0.15 | 0.3 | More prompts skip critic entirely |
| Critic lenient below | 0.4 | 0.6 | More prompts get fast lenient critic |
| Multi-query above | 0.3 | 0.5 | Fewer multi-query fan-outs |
| HyDE above | 0.5 | 0.7 | Fewer HyDE variant generations |

See `evals/README.md` for the A/B evaluation framework and acceptance gates.

---

## Where Limits Are Set

Quick lookup for where to change each type of limit:

| What to change | Primary file | Secondary file |
|---|---|---|
| Writer/evidence/section budgets | `base/planner/app/config.py` | — |
| Writer / critic / planner budgets (TS) | `base/planner-ts/src/config.ts` | `base/planner-ts/src/budgets.ts`, `model-tiers.ts` |
| Executor token budget curve | `base/planner/app/nodes/writer.py` | — |
| LiteLLM max_tokens (self-hosted) | `base/gateway/litellm-config.yaml` | — |
| LiteLLM max_tokens (OpenRouter) | `overlays/openrouter/litellm-config-openrouter.yaml` | — |
| Temperature (pipeline nodes) | Each node file in `base/planner/app/nodes/` | `base/planner/app/graph.py` |
| Temperature (gateway default) | `base/gateway/litellm-config.yaml` | `overlays/openrouter/litellm-config-openrouter.yaml` |
| Context window | `base/planner/app/config.py` (`compiler_model_context`) | — |
| HTTP timeouts | `base/planner/app/config.py` | — |

---

## Yarn (fabric)

Yarn's token and tool budgets follow a similar philosophy to the planner — scale
with context, enforce via ledger — but substitute **interaction mode + client
preset** for task difficulty. See
[docs/development/CLIENT_ADAPTER_PACKS_M7.md](development/CLIENT_ADAPTER_PACKS_M7.md) for the full
architecture: session ledger, per-turn caps, tool-output budgets, JSON presets,
and compatibility negotiation.

### Session budget & safety limits

| Setting | Default | Env var | Notes |
|---|---|---|---|
| Session max input tokens | 2,000,000 | `SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS` | Cumulative input tokens per session key |
| Consecutive tool calls (hard) | 15 | `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT` | Circuit breaker — rejects request |
| Consecutive tool calls (pivot) | 10 | `SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT` | Soft pivot — injects "stop and explain" prompt |
| Hard reject after N repeats | 6 | `SYNESIS_YARN_POLICY_HARD_REJECT_AFTER` | Identical-action dedup |
| Inactivity rotation threshold | 30 min | `SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS` | Auto-rotates session key when idle (see below) |

### Session lifecycle & inactivity rotation

Sessions are keyed as `synesis:{userId}:{clientKind}:{conversationId}`. Clients
that provide an explicit `conversation_id` (via body field, `metadata.session_id`,
or `x-synesis-conversation-id` / `x-claude-session-id` headers) get one session
per conversation.

**Problem:** Claude Code does not send a conversation ID. All requests from a
single user collapse into `synesis:{uid}:claude-code:_`, accumulating tokens
across logically unrelated conversations.

**Fix (shipped):** When no explicit conversation ID is present and the existing
session has been idle longer than `SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS`
(default 30 min), yarn-ts generates a fresh session key with a rotation suffix
(`...:_:r{timestamp}`). The old session remains in Redis/Postgres for audit but
stops accumulating. Active conversations within the idle window continue normally.

Session records are stored in Redis (4-hour TTL, refreshed on each request) and
persisted to Postgres via the usage writer for the admin session viewer.

### TODO: Context-aware session pivot (future)

The inactivity rotation handles the time-based case (user comes back after a
break), but misses the **context-shift** case — e.g., back-to-back projects in
the same sitting where the cached prefix from a Terraform session is dead weight
for a new Go project.

**Proposed approach:**

1. **Project manifest fingerprint** — the `ProjectManifestService` already
   detects project type (Go mod, package.json, Cargo.toml, etc.) per request.
   Hash the detected language, project root, and key files at session start.
2. **Divergence check** — on each request, recompute and compare. If the
   fingerprint diverges beyond a threshold, trigger a `session_context_pivot`
   rotation (same mechanism as inactivity rotation, different trigger).
3. **Signals available today:**
   - Working frame file extensions (`.tf` → `.go`)
   - Project manifest detected project type
   - Tool result file paths (language/framework indicators)
   - First user message ("new project", radically different domain)
4. **Cache-efficiency benefit** — rotating on context shift avoids paying
   full-price input tokens for a stale prefix that yields zero cache hits
   upstream. The new session starts with a clean prefix that the provider can
   cache effectively.

**Cost of the check:** Near-zero — manifest and working frame services already
run per-request. The fingerprint hash + comparison is O(1).

**Blocked on:** Nothing technical; this is a prioritization/scheduling item. The
rotation infrastructure (`getSessionKey` → `buildSessionKey` + async rotation
logic) is in place and extensible.
