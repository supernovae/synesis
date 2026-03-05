# Synesis Workflow

This document describes the LangGraph orchestration flow, routing logic, and key design invariants.

## Overview

Synesis implements a **Joint Cognitive System (JCS)** with 9 active nodes:
Entry Classifier, Strategic Advisor (Domain Aligner), Supervisor,
Planner, Context Curator, Worker (Executor), Patch Integrity Gate,
Critic, and Respond. Each node has a narrow scope; the mantra is
**Routing, not Reasoning** for the Supervisor and **Atomic
Decomposition** for the Planner.

**Output philosophy:** The Worker always produces **streaming
markdown** -- no JSON wrapper, no format bifurcation. Code tasks
include fenced code blocks; explanations are prose. The
`is_code_task` boolean controls whether code blocks are extracted
for validation.

**Sandbox and LSP are not in the default pipeline.** They remain
available as tool-accessible resources for future agent-based
self-correction loops (see [Architecture Decision: Sandbox/LSP
Decoupling](#architecture-decision-sandboxlsp-decoupling)).

## Models

| Role | Model | Hardware | Notes |
|------|-------|----------|-------|
| Supervisor / Planner / Critic | Qwen3-8B FP8-dynamic | GPU 1 (L40S) | Shared model, two K8s Services |
| Worker (Executor) | DeepSeek R1-Distill-Qwen-32B FP8-dynamic | GPU 2 (L40S) | Chain-of-thought reasoning via `--reasoning-parser=deepseek_r1` |
| Summarizer | Qwen2.5-0.5B-Instruct | CPU | Pivot history summarization |
| Embedder | all-MiniLM-L6-v2 | CPU | RAG embedding |

## Graph Flow

```
                                    +--------------------+
                                    |  entry_classifier  |  <- deterministic (no LLM)
                                    +--------+-----------+
                                             |
                                             v
                                    +--------------------+
                                    | strategic_advisor  |  Domain classification
                                    +--------+-----------+
                                             |
              +------------------------------+------------------+
              |                              |                  |
              v                              v                  v
    +-----------------+            +-----------------+  +--------------+
    | context_curator |            |   supervisor    |  |   planner    |
    | (easy fast path)|            | (routing only)  |  | (hard path)  |
    +--------+--------+            +--------+--------+  +------+-------+
             |                              |                  |
             |                    +---------+--------+         |
             |                    v                  v         |
             |            context_curator       planner        |
             |                    |                  |         |
             +--------------------+------------------+         |
                                  v                            |
                         +-----------------+                   |
                         | context_curator |  RAG + context    |
                         +--------+--------+                   |
                                  |                            |
                                  v                            |
                         +-----------------+                   |
                         |     worker      |  Markdown output  |
                         +--------+--------+                   |
                                  |                            |
                    +-------------+--------------+             |
                    | is_code_task?              |             |
                    v                            v             |
           +-----------------+          +-------------+       |
           |patch_integrity_ |          |   respond   |       |
           |     gate        |          |   (direct)  |       |
           +--------+--------+          +-------------+       |
                    |                                          |
                    v                                          |
            +-----------------+                                |
            |     critic      |  Evidence-gated review         |
            +--------+--------+                                |
                     |                                         |
            +--------+--------+                                |
            v                 v                                |
     +-------------+  +-------------+                          |
     |   respond   |  |  supervisor |  (revision loop)         |
     |     END     |  +------+------+                          |
     +-------------+         +------->------>------>-----------+
```

## Classification System

The Entry Classifier is **deterministic** (no LLM). It uses the
YAML-driven `ScoringEngine` with split axes:

| Axis | Purpose | Source |
|------|---------|--------|
| `complexity_score` | Steps, scope, uncertainty | `intent_weights.yaml` + plugin YAMLs |
| `risk_score` | Destructive ops, secrets, compliance | `intent_weights.yaml` + plugin YAMLs |
| `difficulty` | Normalized 0.0-1.0 | `complexity_score / (medium_max * 2)` |
| `task_size` | `easy` / `medium` / `hard` | Derived from complexity + risk |
| `is_code_task` | `true` (code) / `false` (explain) | From `intent_class` + domain |
| `intent_class` | `code_generation`, `knowledge`, `conversation`, etc. | Keyword matching against `intent_classes` |

**Token budget:** Continuous difficulty curve, not bucketed.
`budget = 512 + (4096 - 512) * difficulty^1.5`. Social
acknowledgements get 256 tokens.

**Routing thresholds** (YAML-driven):
- `bypass_supervisor_below: 0.2` -- easy tasks skip Supervisor
- `plan_required_above: 0.7` -- hard tasks get Planner
- `critic_required_above: 0.6` -- triggers full Critic review

## Routing Logic

### After Entry Classifier + Strategic Advisor

| Condition | Next Node |
|-----------|-----------|
| `pending_question_continue` | `context_curator` (if source=worker/planner) or source |
| `message_origin == "ui_helper"` | `respond` |
| `plan_required` + `task_size` in (hard, medium) or `is_code_task=false` | `planner` |
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
- `task_size == "hard"` + `plan_required` -> skip LLM, route to `planner`
- `task_size == "medium"` + `interaction_mode == "teach"` -> skip LLM, route to `worker`
- `is_code_task=false` (taxonomy) -> skip LLM, route to `worker`

### After Planner

| Condition | Next Node |
|-----------|-----------|
| `plan_pending_approval` | `respond` (surface plan; user replies to proceed) |
| else | `context_curator` -> worker (plan auto-proceeds) |

### After Worker

| Condition | Next Node |
|-----------|-----------|
| `needs_input_question` | `respond` |
| `stop_reason == "needs_scope_expansion"` | `supervisor` |
| `stop_reason` (other) | `respond` |
| `is_code_task=false` + high complexity (>0.6) + required_elements | `critic` (depth check) |
| `is_code_task=false` (low complexity) | `respond` (direct) |
| else | `patch_integrity_gate` |

### After Patch Integrity Gate

| Condition | Next Node |
|-----------|-----------|
| `integrity_passed == false` | `context_curator` (retry Worker) |
| else | `critic` |

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

1. **Anemic Supervisor**: Routing only. No architecture reasoning.
   Sub-500ms target. Taxonomy-driven passthroughs skip LLM for
   easy, teach, and `is_code_task=false` cases.
2. **Taxonomy-Driven Everything**: Entry Classifier outputs
   `intent_class`, `is_code_task`, `active_domain_refs`,
   `taxonomy_metadata`, `difficulty`, and YAML-driven
   `routing_thresholds`. Taxonomy plugins provide domain keywords,
   complexity/risk weights, and vertical prompt data (worker
   persona, planner rules, critic mode).
3. **Atomic Planner**: Each step max 3 files. Every step must have
   `verification_command`. Protocol tasks (Fediverse,
   ActivityPub): first step = discovery/WebFinger only.
4. **Evidence-Gated Critic**: `approved=false` requires at least
   one `blocking_issue` with valid `evidence_refs` (ref_type:
   static_analysis, syntax, spec, code_smell, lsp, or sandbox).
   No blocking on speculation.
5. **Unified Markdown Output**: Worker always produces markdown.
   No JSON wrapper. Code is in fenced blocks; `code_extractor.py`
   extracts blocks for validation. `is_code_task` controls whether
   extraction happens.
6. **Monotonic Retry** (`state.retry`): Failures, decisions,
   diversification_history only append. At `max_iterations`, force
   PASS and emit `carried_uncertainties_signal`.
7. **Continuous Token Budgets**: Difficulty-based curve (not
   bucketed). Social acknowledgements get minimal budget (256
   tokens). Thinking budgets scale with `task_size`.
8. **No fixed sandbox/LSP pipeline stages**: Sandbox and LSP are
   decoupled from the default graph edges. The default code path
   is Worker -> PatchIntegrityGate -> Critic -> Respond. Sandbox
   and LSP remain as tool-accessible resources for future
   agent-based self-correction loops.

## Adaptive Rigor

Rigor scales with `task_size`. Decouples general utility from
engineering rigor.

| Task Size | Critic Mode | Respond Output | RAG | Status |
|-----------|-------------|----------------|-----|--------|
| **easy** | Advisory (no LLM) | Code/markdown + one line | disabled | "Generating..." |
| **medium** | Advisory (no LLM) | Code/markdown + explanation | light (generic) | "Generating..." |
| **hard** | Full JCS Critic | Decision Summary, Safety Analysis, Learner's Corner | normal | "Architecting solution..." |

- **Advisory Mode** (easy/medium): Critic skips LLM.
  `approved=true` if code compiles/runs. No What-If analysis.
- **Full Critic** (hard only): Full JCS analysis with What-Ifs.
  Evidence-gated blocking.
- **Tiered Critic** (lifestyle, LLM RAG/prompting/evaluation):
  basic -> advanced -> research tiers from taxonomy plugin YAML.
- **Vertical Persona Injection**: Taxonomy plugins inject
  domain-specific Worker persona blocks (HIPAA for medical,
  PCI-DSS for fintech, etc.), Planner decomposition rules, and
  Critic mode overrides.

## Streaming Architecture

All responses stream via SSE (`text/event-stream`) through the
OpenAI-compatible `/v1/chat/completions` endpoint.

| Path | Mechanism | Reasoning |
|------|-----------|-----------|
| `is_code_task=false` | Worker returns `direct_stream_request` dict; `main.py` calls executor via raw OpenAI SDK | Preserves `reasoning_content` (LangChain drops it) |
| `is_code_task=true` | Worker calls LLM via LangChain `ainvoke`; code extracted from markdown post-hoc | Full response needed for code extraction |

**Reasoning content**: vLLM `--reasoning-parser=deepseek_r1`
separates R1 thinking into `reasoning_content` in the SSE delta.
Open WebUI v0.8.8+ renders this natively in a collapsible
"Thinking" UI.

**Status events**: Pipeline phases (`Analyzing request...`,
`Detecting domain...`, `Creating your plan...`, `Finishing...`)
emit as `reasoning_content` before the main response, appearing
in the Thinking dropdown.

**Deduplication**: Consecutive identical status descriptions are
suppressed to prevent duplicate phase indicators.

## Architecture Decision: Sandbox/LSP Decoupling

**Decision**: Sandbox and LSP are removed from the default graph
edges. They remain as tool-accessible resources for future
agent-based self-correction loops.

**Rationale**: The fixed pipeline (Worker -> Sandbox -> LSP ->
Critic) imposed mandatory latency on every code task, even when
the code was trivially correct. Research on LLM self-correction
shows that agent-based dynamic tool selection outperforms fixed
pipelines.

**Current code path** (default):
```
Worker -> PatchIntegrityGate -> Critic -> Respond
```

PatchIntegrityGate provides deterministic safety checks (secrets,
network, workspace boundaries, import integrity, AST syntax) in
<10ms. The Critic operates in Advisory mode for easy/medium tasks
(no LLM call) and Full JCS mode for hard tasks.

**Future self-correction loop** (planned):
```
Worker -> PatchIntegrityGate -> Critic -> [exception?]
    -> Agent selects tool: compile -> ruff -> sandbox -> LSP
    -> Re-try with enriched context
```

### Research References

The following research informed this architecture decision:

1. **Graduated Escalation** (LLMLOOP pattern): Start with the
   cheapest validation (compile/parse), escalate to static
   analysis, then sandbox execution, then mutation testing. Each
   level costs more but catches deeper issues. Most code passes
   early stages.
   - Ref: Chen et al., "Teaching Large Language Models to
     Self-Debug" (2023), arXiv:2304.05128

2. **Agent-Based Dynamic Tool Selection**: LLM agents that
   dynamically choose which validation tools to invoke outperform
   fixed pipelines by 15-30% on code repair benchmarks.
   - Ref: InspectCoder (2024) -- multi-agent code review with
     dynamic tool selection
   - Ref: CodeCureAgent (2024) -- repair agent with graduated
     tool escalation

3. **Static Analysis Effectiveness**: Ruff, mypy, and AST-based
   checks catch 60-80% of common Python issues without execution.
   Sandbox adds latency but only catches runtime-specific bugs.
   - Ref: Beller et al., "Analyzing the State of Static Analysis"
     (2016), IEEE TSE

4. **Client-Side Code Formatting**: Code formatting (black, ruff
   format, prettier) is best delegated to the client/IDE rather
   than performed server-side. The LLM should focus on correctness,
   not style.
   - Ref: Industry consensus -- VS Code, Cursor, and JetBrains
     all apply formatters on save/paste

5. **Dynamic Reasoning Quota Allocation (DRQA)**: Adaptive
   computation budgets for LLM reasoning, allocating more thinking
   tokens to harder problems. Synesis implements this via
   continuous difficulty-based token budgets.
   - Ref: Xu et al., "DRQA: Dynamic Reasoning Quota Allocation"
     (2025), arXiv:2502.17268

6. **RouteLLM and Adaptive Routing**: Research on routing prompts
   to different-capability models based on estimated difficulty.
   Synesis uses taxonomy-driven scoring instead of a separate
   routing model.
   - Ref: Ong et al., "RouteLLM: Learning to Route LLMs with
     Preference Data" (2024), arXiv:2406.18665

### What Changed

| Before | After |
|--------|-------|
| Worker -> PatchGate -> Sandbox -> [LSP] -> Critic | Worker -> PatchGate -> Critic |
| `/test` command for user-triggered sandbox | Removed (sandbox is internal-only) |
| `force_sandbox` state field | Removed |
| `needs_sandbox` boolean | Renamed to `is_code_task` |
| Evidence gate required `lsp` or `sandbox` refs | Accepts `static_analysis`, `syntax`, `spec`, `code_smell`, `lsp`, `sandbox` |
| Sandbox/LSP nodes registered in graph | Removed from graph edges; code remains for future tool use |

## Planner: When, Why, and Performance

**When Planner runs:**
1. Code: `task_size=hard` + `plan_required` (multi-step,
   protocol-heavy)
2. Document deep-dive: `is_code_task=false` + domain in
   `deep_dive_domains` + `complexity > 0.6` ->
   `plan_required=true` -> Planner produces structured bullets;
   Worker receives taxonomy depth block
3. Simple document -> `plan_required=false` -> Supervisor
   passthrough -> Worker -> Respond

**Taxonomy shaping:** Taxonomy plugin YAMLs inject
`planner_decomposition_rules` per vertical. For lifestyle:
"Standard atomic steps." For medical/fintech/industrial: Step 1
audit/safety rules.

**Performance levers:**
1. **Routing:** Taxonomy sets `is_code_task=false` for (intent,
   domain) -> `plan_required=false`; document tasks never hit
   Planner.
2. **max_tokens:** 1024 vs 2048 reduces generation time.
3. **Prefix caching:** Supervisor and Critic share a runtime with
   `--enable-prefix-caching`.

## Configuration System

All classification, routing, and prompt injection is driven by
YAML config -- no hardcoded if/else chains.

| File | Purpose |
|------|---------|
| `intent_weights.yaml` | Core complexity/risk weights, intent classes, routing thresholds |
| `plugins/weights/*.yaml` | Industry-specific keywords, weights, pairings, and vertical prompt data |
| `taxonomy_prompt_config.yaml` | Domain -> persona, tone, depth instructions, required_elements |
| `intent_prompts.yaml` | Intent -> Critic behavior overlay (hallucination-sensitive, evidence-required, etc.) |
| `prompt_taxonomy.yaml` | Pivot summarizer routing, vertical aliases |

**Plugin system:** Drop a YAML into `plugins/weights/` to add an
industry vertical. Plugin loader merges complexity/risk/domain
keywords, pairings, and vertical prompt blocks at startup.

## See Also

- [nodes.md](nodes.md) -- Node flow with full prompts per role
- [TAXONOMY.md](TAXONOMY.md) -- Intent taxonomy, output path, critic policy
- [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) -- Taxonomy metadata, Planner deep-dive, depth block injection
- [critic_policy_spec.json](../base/planner/critic_policy_spec.json) -- Critic policy engine spec
- [intent_weights.yaml](../base/planner/intent_weights.yaml) -- EntryClassifier complexity/risk weights
- [plugins/weights/README.md](../base/planner/plugins/weights/README.md) -- Industry plugin format
