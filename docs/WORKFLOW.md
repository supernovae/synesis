# Synesis Workflow

This document describes the LangGraph orchestration flow, routing logic, and key design invariants.

## Overview

Synesis implements a **Joint Cognitive System (JCS)** with distinct roles: Entry Classifier, Domain Aligner (Strategic Advisor), Supervisor, Planner, Worker (Executor), Patch Integrity Gate, Sandbox, LSP Analyzer, and Critic. Each node has a narrow scope; the mantra is **Routing, not Reasoning** for the Supervisor and **Atomic Decomposition** for the Planner.

## Graph Flow

```
                                    ┌──────────────────┐
                                    │  entry_classifier │  ← entry point (deterministic)
                                    └────────┬─────────┘
                                             │
                                             v
                                    ┌──────────────────┐
                                    │ strategic_advisor │  Domain classification (LLM or passthrough)
                                    └────────┬─────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
              v                              v                              v
    ┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
    │ context_curator │            │   supervisor    │            │    planner      │
    │ (trivial path)  │            │ (small path)    │            │ (complex path)  │
    └────────┬────────┘            └────────┬────────┘            └────────┬────────┘
             │                              │                              │
             │                    ┌─────────┴─────────┐                    │
             │                    v                   v                    │
             │            context_curator       planner                   │
             │                    │                   │                    │
             └───────────────────┼───────────────────┘                    │
                                 v                                        │
                        ┌─────────────────┐                               │
                        │ context_curator │  RAG, context pack             │
                        └────────┬────────┘                               │
                                 │                                         │
                                 v                                         │
                        ┌─────────────────┐                               │
                        │     worker      │  Executor LLM                  │
                        └────────┬────────┘                               │
                                 │                                         │
                                 v                                         │
                        ┌─────────────────┐                               │
                        │patch_integrity_ │  Lint, security, scope        │
                        │     gate        │                               │
                        └────────┬────────┘                               │
                                 │                                         │
                    ┌────────────┴────────────┐                            │
                    v                         v                            │
             ┌─────────────┐           ┌─────────────┐                      │
             │ lsp_analyzer│           │   sandbox   │                      │
             │ (optional)  │           │ (execute)   │                      │
             └──────┬──────┘           └──────┬──────┘                      │
                    │                         │                             │
                    └────────────┬────────────┘                             │
                                 v                                         │
                        ┌─────────────────┐                               │
                        │     critic       │  Evidence-gated review        │
                        └────────┬────────┘                               │
                                 │                                         │
                    ┌────────────┴────────────┐                            │
                    v                         v                            │
             ┌─────────────┐           ┌─────────────┐                      │
             │   respond   │           │  supervisor │  (revision loop)     │
             │     END     │           └──────┬──────┘                      │
             └─────────────┘                  │                             │
                                             └─────────────────────────────┘
```

## Routing Logic

### After Entry Classifier + Strategic Advisor

| Condition | Next Node |
|-----------|-----------|
| `pending_question_continue` | `context_curator` (if source=worker/planner) or source |
| `message_origin == "ui_helper"` | `respond` |
| `task_size == "trivial"` and `bypass_supervisor` | `context_curator` |
| `task_size == "complex"` and `plan_required` | `planner` (bypass Supervisor) |
| **Taxonomy:** `output_type=document` + `plan_required=true` (when domain in `deep_dive_domains`, complexity > 0.6) → `planner` for structured bullets; then context_curator → worker. |
| **Taxonomy:** `output_type=document` + `plan_required=false` → Supervisor passthrough → Worker explain_only (no Planner). Planner is for code decomposition and document deep-dive. |
| else | `supervisor` |

### After Supervisor

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `next_node == "planner"` | `planner` |
| `next_node == "worker"` | `context_curator` |
| else | `respond` |

**Taxonomy-driven passthrough:** When `output_type=document` (from intent_classes[].document_domains in taxonomy), Supervisor skips LLM and routes to worker with `deliverable_type=explain_only`. No lifestyle-specific bias — config-driven.

### After Planner

| Condition | Next Node |
|-----------|-----------|
| `plan_pending_approval` | `respond` (surface plan; user replies to proceed) |
| else | `context_curator` → worker (plan auto-proceeds) |

**Invariant:** Planner never ends the graph. Plans auto-proceed unless user explicitly requested a planning session.

| Condition | Behavior |
|-----------|----------|
| `@plan`, `/plan`, "lets plan", "plan first", "I need a plan" | **Planning session**: show plan, ask to proceed (user replies to continue) |
| Normal complex/small + `require_plan_approval=False` (default) | Auto-proceed to executor |
| `require_plan_approval=True` | Always ask for approval before execution |

### After Worker

| Condition | Next Node |
|-----------|-----------|
| `needs_input_question` | `respond` |
| `stop_reason == "needs_scope_expansion"` | `supervisor` |
| `stop_reason` (other) | `respond` |
| else | `patch_integrity_gate` |

### After Patch Integrity Gate

| Condition | Next Node |
|-----------|-----------|
| `integrity_passed == false` | `context_curator` |
| `deliverable_type == "explain_only"` | `respond` (bypass sandbox — text/plan output) |
| else | `sandbox` (or `lsp_analyzer` if LSP mode=always) |

### After Sandbox

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `next_node == "critic"` | `critic` |
| `exit_code == 0` or `None` | `critic` |
| `iteration >= max_iterations` | `critic` |
| `task_size == "trivial"` and `iteration >= 1` | `critic` |
| LSP eligible (lsp_mode=on_failure) | `lsp_analyzer` |
| else | `context_curator` (retry Worker) |

### After Critic

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `critic_approved` and `!need_more_evidence` | `respond` |
| `iteration >= max_iterations` | `respond` |
| `need_more_evidence` | `supervisor` |
| `!approved` and `should_continue` | `supervisor` |
| `continue_reason` in (blocked_external, needs_input) | `supervisor` |
| else | `respond` |

## Key Invariants

1. **Anemic Supervisor**: Routing only. No architecture reasoning. Sub-500ms target. Passthrough for complex (EntryClassifier), small+teach, and **output_type=document** (taxonomy-driven explain_only).
2. **Taxonomy-Driven Routing**: Entry Classifier outputs `intent_class`, `output_type`, `active_domain_refs`, `taxonomy_metadata`. `output_type` from intent_classes[].document_domains. **Document deep-dive:** when domain in `deep_dive_domains` (e.g. physics, astronomy) and `complexity > 0.6`, `plan_required=true` → Planner produces structured bullets; Worker receives taxonomy depth block. Simple document → `plan_required=false` → Supervisor passthrough → Worker explain_only.
3. **Atomic Planner**: Each step max 3 files. Every step must have `verification_command`. Protocol tasks (Fediverse, ActivityPub): first step = discovery/WebFinger only.
4. **Evidence-Gated Critic**: `approved=false` requires at least one `blocking_issue` with sandbox/lsp `evidence_refs`. No blocking on speculation.
5. **Progressive Worker Prompts**: trivial (minimal), small (defensive), full (JCS). EntryClassifier sets `worker_persona` (Minimalist | Senior | Architect) and `worker_prompt_tier`.
5. **Monotonic Retry** (`state.retry`): failures, decisions, diversification_history only append; never lose prior state. At `max_iterations`, force PASS and emit `dark_debt_signal`.
6. **Approach + Dark Debt** (`approach_dark_debt_config.yaml`): Taxonomy-aware "what we chose" (Approach) and "what we're carrying" (Dark Debt). Surfaced in Respond as **How I got here** (Architect) and **What I'm carrying** (any persona when relevant).

## Adaptive Rigor (Persona Tier System)

Rigor scales with `task_size`. Decouples "general utility" from "engineering rigor."

| Tier | Worker Persona | Critic Mode | Respond Output | RAG | Status Message (Worker) |
|------|----------------|-------------|-----------------|-----|-------------------------|
| **Trivial** | Minimalist | Advisory (no LLM) | Code + one line | disabled | "Generating your code…" |
| **Small** | Senior | Advisory (no LLM) | Code + explanation | light (generic/python_web) | "Generating code…" |
| **Complex** | Architect | Full JCS Critic | Decision Summary, Strategy Bullets, Learner's Corner | normal | "Architecting solution…" |

- **Advisory Mode** (Minimalist/Senior): Critic skips LLM. `approved=true` if code compiles/runs. No What-If analysis. Fast, low-friction path.
- **Full Critic** (Architect only): Full JCS analysis with What-Ifs. Evidence-gated blocking.
- **Strategic Advisor**: When domain is `generic` or `python_web`, set `rag_gravity=light`. Skip Strategic Pivot (entity extraction RAG on retries). No heavy RAG for common knowledge.
- **Status Events**: EntryClassifier, Supervisor, Planner, Worker emit tier-matched `type: "status"` SSE events for Open WebUI.

## Planner: When, Why, and Performance

**When Planner runs:** (1) Code: `task_size=complex` + `plan_required` (multi-step, protocol-heavy). (2) Document deep-dive: `output_type=document` + domain in `deep_dive_domains` + `complexity > 0.6` → `plan_required=true` → Planner with `required_elements` and `depth_instructions` from `taxonomy_prompt_config.yaml`. Simple document → `plan_required=false` → Supervisor passthrough → Worker explain_only.

**Why Planner can feel slow:**
- Uses same model as Supervisor (Qwen3-8B AWQ). Each Planner call is a full LLM inference.
- Prompt: system (atomic rules) + task + assumptions + RAG context (up to 5 chunks) + domain decomposition rules from `vertical_prompts.yaml`.
- Output: JSON plan with steps, touched_files, reasoning. `max_tokens=1024` (sufficient for 1–5 steps).

**Taxonomy shaping:** `vertical_prompts.yaml` injects `planner_decomposition_rules` per vertical. For lifestyle: "Standard atomic steps. No vertical-specific mandates." For medical/fintech/industrial: Step 1 audit/safety rules. Planner prompt is built in `planner_node.py` via `get_planner_decomposition_rules(active_vertical)`.

**Performance levers:**
1. **Routing:** Taxonomy sets `output_type=document` for (intent, domain) → `plan_required=false`; document tasks never hit Planner.
2. **max_tokens:** 1024 vs 2048 reduces generation time.
3. **Dedicated smaller model:** If available, a 3B/7B model for Planner could cut latency (atomic decomposition is simpler than code generation).

## Debug Chatter (Development)

When `SYNESIS_STREAM_DEBUG_CHATTER=true`, the streaming SSE pipeline emits `event: debug_chatter` blocks with labeled outputs from Router (Entry Classifier, Strategic Advisor, Supervisor), Planner, Executor (Worker), and Critic. Open WebUI (or any client) can render these as distinct blocks (e.g., italic/gray with node label) to surface internal reasoning during development.

| Event   | Label                 | Content                                           |
|---------|-----------------------|---------------------------------------------------|
| Router  | Entry Classifier      | task_size, intent, output_type, plan_required     |
| Router  | Strategic Advisor     | platform, domains                                 |
| Router  | Supervisor            | next_node, routing reasoning                     |
| Planner | Execution Plan       | Step list                                        |
| Worker  | Executor             | Explanation + code snippet                       |
| Critic  | Critic               | approved, feedback, what-if count                 |

## Performance and State Payload Optimization

- **Prefix caching**: Supervisor and Critic share synesis-supervisor-critic runtime with `--enable-prefix-caching`. Static system prompts maximize cache hit.
- **Guided JSON**: `SupervisorOut`, `PlannerOut`, `CriticOut`, `ExecutorOut` via LangChain `with_structured_output`.
- **State refs**: RAG/failure context passed as refs+cache where possible to reduce payload size between nodes.
- **Streaming**: `astream_events(version="v2")` with token-level SSE and `event: status` for Open WebUI. Unbuffered headers (`X-Accel-Buffering: no`). Explain-only mode streams direct markdown; code mode uses `StreamingCodeExtractor` for JSON field extraction. Reasoning content (`<think>` tags from R1-Distill) surfaces as "Thinking..." status.

## See Also

- [nodes.md](nodes.md) — Node flow with full prompts per role
- [TAXONOMY.md](TAXONOMY.md) — Intent taxonomy, approach/dark debt, critic policy
- [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) — Taxonomy metadata, Planner deep-dive, depth block injection
- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) — Critic policy engine spec
- [approach_dark_debt_config.yaml](../base/planner/approach_dark_debt_config.yaml) — Approach + dark debt mappings
- [intent_weights.yaml](../base/planner/intent_weights.yaml) — EntryClassifier complexity/risk weights
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) — Industry plugin format
