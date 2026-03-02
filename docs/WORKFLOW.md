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
| else | `supervisor` |

### After Supervisor

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `next_node == "planner"` | `planner` |
| `next_node == "worker"` | `context_curator` |
| else | `respond` |

### After Planner

| Condition | Next Node |
|-----------|-----------|
| `plan_pending_approval` | `respond` |
| else | `context_curator` |

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

1. **Anemic Supervisor**: Routing only. No architecture reasoning. Sub-500ms target. Passthrough for complex (EntryClassifier) and small+teach.
2. **Atomic Planner**: Each step max 3 files. Every step must have `verification_command`. Protocol tasks (Fediverse, ActivityPub): first step = discovery/WebFinger only.
3. **Evidence-Gated Critic**: `approved=false` requires at least one `blocking_issue` with sandbox/lsp `evidence_refs`. No blocking on speculation.
4. **Progressive Worker Prompts**: trivial (minimal), small (defensive), full (JCS). EntryClassifier sets `worker_persona` (Minimalist | Senior | Architect) and `worker_prompt_tier`.
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

## Performance and State Payload Optimization

- **Prefix caching**: Supervisor and Critic share synesis-supervisor-critic runtime with `--enable-prefix-caching`. Static system prompts maximize cache hit.
- **Guided JSON**: `SupervisorOut`, `PlannerOut`, `CriticOut`, `ExecutorOut` via LangChain `with_structured_output`.
- **State refs**: RAG/failure context passed as refs+cache where possible to reduce payload size between nodes.
- **Streaming**: SSE with `event: status` for Open WebUI; unbuffered headers (`X-Accel-Buffering: no`) for real-time spinner.

## See Also

- [nodes.md](nodes.md) — Node flow with full prompts per role
- [TAXONOMY.md](TAXONOMY.md) — Intent taxonomy, approach/dark debt, critic policy
- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) — Critic policy engine spec
- [approach_dark_debt_config.yaml](../base/planner/approach_dark_debt_config.yaml) — Approach + dark debt mappings
- [intent_weights.yaml](../base/planner/intent_weights.yaml) — EntryClassifier complexity/risk weights
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) — Industry plugin format
