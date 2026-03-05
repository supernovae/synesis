# Synesis Workflow

This document describes the LangGraph orchestration flow, routing logic, and key design invariants.

## Overview

Synesis implements a **Joint Cognitive System (JCS)** with 11 nodes: Entry Classifier, Strategic Advisor (Domain Aligner), Supervisor, Planner, Context Curator, Worker (Executor), Patch Integrity Gate, Sandbox, LSP Analyzer, Critic, and Respond. Each node has a narrow scope; the mantra is **Routing, not Reasoning** for the Supervisor and **Atomic Decomposition** for the Planner.

**Output philosophy:** The Worker always produces **streaming markdown** — no JSON wrapper, no format bifurcation. Code tasks include fenced code blocks; explanations are prose. The `needs_sandbox` boolean controls whether code blocks are extracted for sandbox execution.

## Models

| Role | Model | Hardware | Notes |
|------|-------|----------|-------|
| Supervisor / Planner / Critic | Qwen3-8B FP8-dynamic | GPU 1 (L40S) | Shared model, two K8s Services |
| Worker (Executor) | DeepSeek R1-Distill-Qwen-32B FP8-dynamic | GPU 2 (L40S) | Chain-of-thought reasoning via `--reasoning-parser=deepseek_r1` |
| Summarizer | Qwen2.5-0.5B-Instruct | CPU | Pivot history summarization |
| Embedder | all-MiniLM-L6-v2 | CPU | RAG embedding |

## Graph Flow

```
                                    ┌──────────────────┐
                                    │  entry_classifier │  ← deterministic (no LLM)
                                    └────────┬─────────┘
                                             │
                                             v
                                    ┌──────────────────┐
                                    │ strategic_advisor │  Domain classification
                                    └────────┬─────────┘
                                             │
              ┌──────────────────────────────┼──────────────────┐
              │                              │                  │
              v                              v                  v
    ┌─────────────────┐            ┌─────────────────┐  ┌──────────────┐
    │ context_curator │            │   supervisor    │  │   planner    │
    │ (easy fast path)│            │ (routing only)  │  │ (hard path)  │
    └────────┬────────┘            └────────┬────────┘  └──────┬───────┘
             │                              │                  │
             │                    ┌─────────┴────────┐         │
             │                    v                  v         │
             │            context_curator       planner        │
             │                    │                  │         │
             └────────────────────┼──────────────────┘         │
                                  v                            │
                         ┌─────────────────┐                   │
                         │ context_curator │  RAG + context     │
                         └────────┬────────┘                   │
                                  │                            │
                                  v                            │
                         ┌─────────────────┐                   │
                         │     worker      │  Markdown output   │
                         └────────┬────────┘                   │
                                  │                            │
                    ┌─────────────┴──────────────┐             │
                    │ needs_sandbox?              │             │
                    v                            v             │
           ┌─────────────────┐          ┌─────────────┐        │
           │patch_integrity_ │          │   respond   │        │
           │     gate        │          │   (direct)  │        │
           └────────┬────────┘          └─────────────┘        │
                    │                                          │
               ┌────┴────┐                                     │
               v         v                                     │
        ┌───────────┐ ┌─────────────┐                           │
        │ sandbox   │ │lsp_analyzer │                           │
        └─────┬─────┘ └──────┬──────┘                           │
              └──────┬───────┘                                  │
                     v                                         │
            ┌─────────────────┐                                │
            │     critic      │  Evidence-gated review          │
            └────────┬────────┘                                │
                     │                                         │
            ┌────────┴────────┐                                │
            v                 v                                │
     ┌─────────────┐  ┌─────────────┐                           │
     │   respond   │  │  supervisor │  (revision loop)          │
     │     END     │  └──────┬──────┘                           │
     └─────────────┘         └─────────────────────────────────┘
```

## Classification System

The Entry Classifier is **deterministic** (no LLM). It uses the YAML-driven `ScoringEngine` with split axes:

| Axis | Purpose | Source |
|------|---------|--------|
| `complexity_score` | Steps, scope, uncertainty | `intent_weights.yaml` + plugin YAMLs |
| `risk_score` | Destructive ops, secrets, compliance | `intent_weights.yaml` + plugin YAMLs |
| `difficulty` | Normalized 0.0–1.0 | `complexity_score / (medium_max * 2)` |
| `task_size` | `easy` / `medium` / `hard` | Derived from complexity + risk |
| `needs_sandbox` | `true` (code) / `false` (explain) | From `intent_class` + domain |
| `intent_class` | `code_generation`, `knowledge`, `conversation`, etc. | Keyword matching against `intent_classes` |

**Token budget:** Continuous difficulty curve, not bucketed. `budget = 64 + (4096 - 64) * difficulty^1.5`. Social acknowledgements get 128 tokens.

**Routing thresholds** (YAML-driven):
- `bypass_supervisor_below: 0.2` — easy tasks skip Supervisor
- `plan_required_above: 0.7` — hard tasks get Planner
- `critic_required_above: 0.6` — triggers full Critic review

## Routing Logic

### After Entry Classifier + Strategic Advisor

| Condition | Next Node |
|-----------|-----------|
| `pending_question_continue` | `context_curator` (if source=worker/planner) or source |
| `message_origin == "ui_helper"` | `respond` |
| `plan_required` + `task_size` in (hard, medium) or `needs_sandbox=false` | `planner` |
| `bypass_supervisor` (easy tasks, knowledge-downgraded) | `context_curator` |
| else | `supervisor` |

### After Supervisor

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `next_node == "planner"` | `planner` |
| `next_node == "worker"` | `context_curator` |
| else | `respond` |

**Taxonomy-driven passthroughs (no LLM):**
- `task_size == "hard"` + `plan_required` → skip LLM, route to `planner`
- `task_size == "medium"` + `interaction_mode == "teach"` → skip LLM, route to `worker`
- `needs_sandbox=false` (taxonomy) → skip LLM, route to `worker`

### After Planner

| Condition | Next Node |
|-----------|-----------|
| `plan_pending_approval` | `respond` (surface plan; user replies to proceed) |
| else | `context_curator` → worker (plan auto-proceeds) |

**Planning sessions:** `@plan`, `/plan`, "lets plan", "plan first" → show plan and ask to proceed. Normal tasks auto-proceed unless `require_plan_approval=True`.

### After Worker

| Condition | Next Node |
|-----------|-----------|
| `needs_input_question` | `respond` |
| `stop_reason == "needs_scope_expansion"` | `supervisor` |
| `stop_reason` (other) | `respond` |
| `needs_sandbox=false` + high complexity (>0.6) + required_elements | `critic` (depth check) |
| `needs_sandbox=false` (low complexity) | `respond` (direct) |
| else | `patch_integrity_gate` |

### After Patch Integrity Gate

| Condition | Next Node |
|-----------|-----------|
| `integrity_passed == false` | `context_curator` (retry Worker) |
| `needs_sandbox=false` | `respond` (bypass sandbox) |
| else | `sandbox` (or `lsp_analyzer` if LSP mode=always) |

### After Sandbox

| Condition | Next Node |
|-----------|-----------|
| `error` | `respond` |
| `next_node == "critic"` | `critic` |
| `exit_code == 0` or `None` | `critic` |
| `iteration >= max_iterations` | `critic` |
| `task_size == "easy"` and `iteration >= 1` | `critic` |
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

1. **Anemic Supervisor**: Routing only. No architecture reasoning. Sub-500ms target. Taxonomy-driven passthroughs skip LLM for easy, teach, and `needs_sandbox=false` cases.
2. **Taxonomy-Driven Everything**: Entry Classifier outputs `intent_class`, `needs_sandbox`, `active_domain_refs`, `taxonomy_metadata`, `difficulty`, and YAML-driven `routing_thresholds`. Taxonomy plugins provide domain keywords, complexity/risk weights, and vertical prompt data (worker persona, planner rules, critic mode).
3. **Atomic Planner**: Each step max 3 files. Every step must have `verification_command`. Protocol tasks (Fediverse, ActivityPub): first step = discovery/WebFinger only.
4. **Evidence-Gated Critic**: `approved=false` requires at least one `blocking_issue` with sandbox/lsp `evidence_refs`. No blocking on speculation.
5. **Unified Markdown Output**: Worker always produces markdown. No JSON wrapper, no `StreamingCodeExtractor`. Code is in fenced blocks; `code_extractor.py` extracts blocks for sandbox. `needs_sandbox` controls whether extraction happens.
6. **Monotonic Retry** (`state.retry`): Failures, decisions, diversification_history only append. At `max_iterations`, force PASS and emit `carried_uncertainties_signal`.
7. **Continuous Token Budgets**: Difficulty-based curve (not bucketed). Social acknowledgements get minimal budget (128 tokens). Thinking budgets scale with `task_size`.

## Adaptive Rigor

Rigor scales with `task_size`. Decouples general utility from engineering rigor.

| Task Size | Critic Mode | Respond Output | RAG | Status |
|-----------|-------------|----------------|-----|--------|
| **easy** | Advisory (no LLM) | Code/markdown + one line | disabled | "Generating…" |
| **medium** | Advisory (no LLM) | Code/markdown + explanation | light (generic) | "Generating…" |
| **hard** | Full JCS Critic | Decision Summary, Safety Analysis, Learner's Corner | normal | "Architecting solution…" |

- **Advisory Mode** (easy/medium): Critic skips LLM. `approved=true` if code compiles/runs. No What-If analysis.
- **Full Critic** (hard only): Full JCS analysis with What-Ifs. Evidence-gated blocking.
- **Tiered Critic** (lifestyle, LLM RAG/prompting/evaluation): basic → advanced → research tiers from taxonomy plugin YAML.
- **Vertical Persona Injection**: Taxonomy plugins inject domain-specific Worker persona blocks (HIPAA for medical, PCI-DSS for fintech, etc.), Planner decomposition rules, and Critic mode overrides.

## Streaming Architecture

All responses stream via SSE (`text/event-stream`) through the OpenAI-compatible `/v1/chat/completions` endpoint.

| Path | Mechanism | Reasoning |
|------|-----------|-----------|
| `needs_sandbox=false` | Worker returns `direct_stream_request` dict; `main.py` calls executor via raw OpenAI SDK | Preserves `reasoning_content` (LangChain drops it — #34706) |
| `needs_sandbox=true` | Worker calls LLM via LangChain `ainvoke`; code extracted from markdown post-hoc | Full response needed for code extraction |

**Reasoning content**: vLLM `--reasoning-parser=deepseek_r1` separates R1 thinking into `reasoning_content` in the SSE delta. Open WebUI v0.8.8+ renders this natively in a collapsible "Thinking" UI.

**Status events**: Pipeline phases (`Analyzing request…`, `Detecting domain…`, `Creating your plan…`, `Finishing…`) emit as `reasoning_content` before the main response, appearing in the Thinking dropdown.

**Deduplication**: Consecutive identical status descriptions are suppressed to prevent duplicate phase indicators.

## Planner: When, Why, and Performance

**When Planner runs:**
1. Code: `task_size=hard` + `plan_required` (multi-step, protocol-heavy)
2. Document deep-dive: `needs_sandbox=false` + domain in `deep_dive_domains` + `complexity > 0.6` → `plan_required=true` → Planner produces structured bullets; Worker receives taxonomy depth block
3. Simple document → `plan_required=false` → Supervisor passthrough → Worker → Respond

**Taxonomy shaping:** Taxonomy plugin YAMLs inject `planner_decomposition_rules` per vertical. For lifestyle: "Standard atomic steps." For medical/fintech/industrial: Step 1 audit/safety rules.

**Performance levers:**
1. **Routing:** Taxonomy sets `needs_sandbox=false` for (intent, domain) → `plan_required=false`; document tasks never hit Planner.
2. **max_tokens:** 1024 vs 2048 reduces generation time.
3. **Prefix caching:** Supervisor and Critic share a runtime with `--enable-prefix-caching`.

## Configuration System

All classification, routing, and prompt injection is driven by YAML config — no hardcoded if/else chains.

| File | Purpose |
|------|---------|
| `intent_weights.yaml` | Core complexity/risk weights, intent classes, routing thresholds |
| `plugins/weights/*.yaml` | Industry-specific keywords, weights, pairings, and vertical prompt data |
| `taxonomy_prompt_config.yaml` | Domain → persona, tone, depth instructions, required_elements |
| `intent_prompts.yaml` | Intent → Critic behavior overlay (hallucination-sensitive, evidence-required, etc.) |
| `prompt_taxonomy.yaml` | Pivot summarizer routing, vertical aliases |

**Plugin system:** Drop a YAML into `plugins/weights/` to add an industry vertical. Plugin loader merges complexity/risk/domain keywords, pairings, and vertical prompt blocks at startup.

## See Also

- [nodes.md](nodes.md) — Node flow with full prompts per role
- [TAXONOMY.md](TAXONOMY.md) — Intent taxonomy, output path, critic policy
- [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) — Taxonomy metadata, Planner deep-dive, depth block injection
- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) — Critic policy engine spec
- [intent_weights.yaml](../base/planner/intent_weights.yaml) — EntryClassifier complexity/risk weights
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) — Industry plugin format
