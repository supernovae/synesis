# Planner prefix / KV cache and clarification resume

## Why this doc exists

On **clarification resume**, every chat turn still runs the full **`entry_pipeline`** (classifier, advisor, frame extractor when applicable) and then the **planner**. We also **reuse the draft `execution_plan`** from conversation memory inside the planner (proceed waiver or minimal-revision prompt) to avoid useless full replans.

A separate optimization would be **skipping or shortening entry** when `pending_question_continue` + `planner_clarification` is set. That saves app-side work but adds branching, staleness risk if the user’s reply should re-classify the task, and more tests.

**Pragmatic default:** Rely on **inference-side prefix / KV cache** (when the deployment supports it) so repeated **static prompt prefixes** stay cheap and fast, instead of adding that skip-entry complexity—unless profiling shows entry dominates cost.

---

## What the codebase already does (cache-friendly shape)

The knowledge planner is intentionally shaped so **long, identical rules live in the system message**, and **per-request variability** (task text, evidence block, taxonomy append, clarification resume JSON, gate feedback) lands in the **user message** where possible. That maximizes the chance that the model server can reuse a cached prefix across requests.

- Static planner rules + trust policy: `_PLANNER_SYSTEM_STATIC` in `base/planner/app/nodes/planner_node.py`
- `_build_knowledge_planner_prompt()` documents intent: *“Static rules (identical across requests) form the prefix for vLLM KV-cache reuse.”*
- Comment at the user-message build: *“preserve the static system prefix for vLLM KV-cache reuse.”*

Entry nodes (classifier, advisor, frame) have their own prompt shapes; whether they cache as well depends on how static each system prompt is and on the provider.

---

## What to validate in your environment (recommended tests)

Cache behavior is **provider- and deployment-specific** (vLLM, OpenShift AI, OpenRouter, xAI, etc.). Treat the items below as a checklist when tuning or choosing to defer skip-entry work.

1. **Prefill vs cached tokens**  
   If your stack exposes **cached / prefix-hit token counts** or **cache hit rate**, compare a **normal** planning request vs a **clarification resume** turn (same model, similar difficulty). You want to see a meaningful fraction of prompt tokens served from cache on the second turn when the system prefix is stable.

2. **Latency**  
   Wall-clock time for planner (and entry) on resume vs first pass; cache hits usually show up as lower time-to-first-token on the model side (not always visible end-to-end if other work dominates).

3. **Billing**  
   Some hosts bill cached prefill at a lower rate than uncached; confirm in your dashboard so “cheap planning” is real, not assumed.

4. **When cache won’t help much**  
   Huge per-request-only prefixes (e.g. very long dynamic system injections), frequent model/version changes, or providers that don’t implement prefix caching will limit wins. In those cases, profiling entry vs planner cost decides whether skip-entry is worth the complexity.

---

## Provider usage vs Synesis traces

Providers that support prompt caching often report **`prompt_tokens_details.cached_tokens`**
(OpenAI-style) or analogous fields. Use the provider dashboard, model-server metrics, or
raw response usage payloads to measure cache hit rates and discounted input tokens.

**Synesis** does **not** currently copy cached-token breakdowns into Postgres `traces`:
each `LLMCallRecord` stores aggregate `prompt_tokens` / `completion_tokens` / `total_tokens`
(see `base/planner/app/synesis_tracer.py`). Extending the tracer to persist
`usage.prompt_tokens_details` (or provider equivalents) would be the path to **admin-native**
cache dashboards. Until then, rely on provider dashboards or **model-server metrics** for
cache verification.

See [WORKFLOW_PLANNER.MD](./WORKFLOW_PLANNER.MD) for planner graph flow and routing details.

## References

- Planner prompt layout: `base/planner/app/nodes/planner_node.py` — `_build_knowledge_planner_prompt`, task/user message assembly
- Graph entry point (entry always runs first): `base/planner/app/graph.py` — `set_entry_point("entry_pipeline")`
- Clarification pending context + plan reuse: `base/planner/app/graph.py` (`store_pending_question`), `base/planner/app/main.py` (pending restore), `base/planner/app/clarification_helpers.py`
- High-level pipeline, routing, retries: `docs/chat/WORKFLOW_PLANNER.MD` — graph flow and routing tables
- Tracer schema: `base/planner/app/synesis_tracer.py` — `LLMCallRecord`
