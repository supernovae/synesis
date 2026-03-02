# Planned Refinements (Progressive Disclosure & Latency)

Future optimizations to make the graph feel smoother and more resilient.

---

## 1. Parallel Triage (Supervisor + Planner Fan-Out)

**Idea:** When EntryClassifier says `task_size=complex`, run Supervisor and Planner **in parallel** instead of serial. Supervisor allocates tools; Planner decomposes. Merge when both complete.

**Benefit:** Shave 5–10s perceived wait — Planner is "already thinking" while Supervisor does its passthrough.

**Implementation:** LangGraph supports fan-out via conditional edges returning a list of nodes. Requires a `state_merger` node to join before Respond. Non-trivial graph restructure.

**Status:** Deferred. Current Supervisor passthrough (~1ms) already avoids the 90s timeout; parallelization is a further optimization.

---

## 2. Thin State (Context Budgeting)

**Idea:** Supervisor prompt is bloated with full RAG + history. For routing decisions, it only needs User Query + EntryClassifier Envelope.

**Benefit:** Keeps prompt under vLLM prefix cache limit → sub-second TTFT.

**Implementation:** When Supervisor *does* run (small/ambiguous), truncate `rag_context` and `conversation_history` in the prompt. Pass only `task_description`, `target_language`, `task_size`, and a short summary.

**Status:** Deferred. Passthrough for complex already skips Supervisor LLM; thin state helps when Supervisor runs for small tasks.

---

## 3. Step-Wise RAG Pivot

**Idea:** Context Curator fetches RAG only for the **active step**. If Worker is on Step 1 (WebFinger), exclude docs about HTTP Signatures or Step 3 topics.

**Benefit:** Reduces noise in Worker prompt; faster generation, more accurate code.

**Implementation:** `execution_plan` has `steps`; add `current_step` to state. Context Curator filters retrieval query by step `action` or `description` keywords. May require step→collection mapping in RAG metadata.

**Status:** Deferred. Worker already receives `execution_plan`; step-scoped RAG needs Curator changes.

---

## 4. Open WebUI Phases (Implemented)

- **Route:** `haproxy.router.openshift.io/disable_buffer: "true"` to reduce proxy buffering
- **Entry classifier:** Sets `current_node` so first status event fires
- **Context-aware status:** When `task_size=complex`, emit "Complex task detected. Building execution plan…" immediately
- **SSE format:** `event: status` + `data: {"type":"status","data":{"description":"...","done":false}}`

See [OPENWEBUI_PHASES.md](OPENWEBUI_PHASES.md) and [STREAMING_BUFFERING.md](STREAMING_BUFFERING.md).
