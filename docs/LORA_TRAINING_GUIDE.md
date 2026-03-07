# LoRA Training Guide for Synesis

> **Status: NOT IMPLEMENTED.** No LoRA adapters are currently deployed. This documents the future training path for when prompt-only differentiation is insufficient.

This document describes how to train and tune LoRA adapters for the Supervisor and Critic roles in the Synesis graph.

**Related:** [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md), [WORKFLOW.md](WORKFLOW.md), [models.yaml](../models.yaml)

---

## No LoRA Required to Start

**You do not need LoRA adapters** to achieve distinct Supervisor vs Critic behavior. The router deployment (Qwen3-8B FP8-dynamic) serves all three non-executor roles via:

| Role | Purpose | Differentiation |
|------|---------|-----------------|
| **Supervisor** | Task routing, context curating, clarification decisions | System prompt + `temperature=0.0`, `max_completion_tokens=1536` |
| **Planner** | Execution plans, `touched_files`, dependencies | System prompt + `temperature=0.2`, `max_completion_tokens=1024` |
| **Critic** | Logical validation, patch integrity, what-if analysis | System prompt + `temperature=0.1`, `max_completion_tokens=4096` |

Each node uses a different `ChatOpenAI` instance with role-specific prompts and inference params. The same vLLM endpoint handles all requests; behavior differs per request content, not per model.

**When to add LoRA:** If prompts + params are insufficient -- e.g. Supervisor over-clarifies despite prompt changes, or Critic false positives persist -- then train adapters and load them with vLLM `--lora-modules`.

---

## Current Base Model

| Component | Model | Quantization | VRAM |
|-----------|-------|-------------|------|
| **Router (Supervisor/Planner/Critic)** | Qwen3-8B FP8-dynamic | FP8 | ~8 GB on L40S |
| **Critic (R1)** | DeepSeek R1-Distill-Qwen-32B FP8 | FP8 | ~33 GB on L40S |

LoRA adapters would be trained against the **Qwen3-8B** base and loaded onto the router deployment. The R1-Distill critic would not use LoRA in the initial phase.

---

## Why LoRA for Supervisor and Critic?

| Benefit | Description |
|---------|-------------|
| **Shared base, distinct personas** | One base model (~8GB VRAM) serves both roles. Adapters add ~50-200MB each. |
| **Fast adapter swap** | vLLM Multi-LoRA switches adapters per request in milliseconds. No model reload. |
| **Configurable bias** | Adapters can encode temperature, verbosity, risk tolerance, and routing preferences. |
| **Incremental improvement** | Fix Supervisor over-clarification or Critic false positives without retraining the full model. |
| **Lower training cost** | LoRA trains 0.1-1% of parameters. Much faster and cheaper than full fine-tuning. |

---

## Training Stack Options

| Tool | Best for | Pros | Cons |
|------|----------|------|------|
| **Unsloth** | Fast iteration | 2x faster, 70% less memory, QLoRA support | Newer ecosystem |
| **Axolotl** | Reproducibility | YAML config, wandb, many formats | Heavier setup |
| **PEFT + Transformers** | Custom pipelines | Full control, Hugging Face native | More code |

**Recommendation:** Start with **Unsloth** or **Axolotl**. Unsloth if speed matters; Axolotl if you want declarative config and experiment tracking.

---

## Data Requirements

### Supervisor LoRA

**Goal:** Triage intent, routing, planning_suggested, clarification behavior.

| Data type | Examples | Format |
|-----------|----------|--------|
| Intent triage | (user message -> task_size, target_language, route_to) | JSONL: input + structured output |
| Clarification decisions | (context -> needs_clarification bool) | JSONL |
| Planning vs. direct | (context -> planning_suggested bool) | JSONL |

### Critic LoRA

**Goal:** Evidence-gated critique, blocking_issues. Avoid false positives on safe code.

| Data type | Examples | Format |
|-----------|----------|--------|
| Approval decisions | (code + sandbox result -> approved bool, blocking_issues) | JSONL |
| What-if reasoning | (code + context -> what_if_suggestions) | JSONL |
| Evidence refs | Pointer-only evidence, no inline pasting | Matches CriticOut schema |

---

## Training Pipeline (High Level)

```
1. Export training data from Synesis logs
   - Filter by node (supervisor, critic)
   - Extract (input_messages, expected_output, outcome)
2. Convert to chat/instruction format
   - System prompt + user/assistant turns
   - Target format matches SupervisorOut / CriticOut JSON
3. Train LoRA (Unsloth or Axolotl)
   - Base: Qwen3-8B (text-only)
   - Rank: 16-64, alpha: 32 (typical)
   - Epochs: 2-4, lr: 1e-4 to 5e-5
4. Export adapter (safetensors)
5. Add to vLLM --lora-modules
6. Route requests by adapter name
```

---

## Concerns and Mitigations

| Concern | Mitigation |
|---------|------------|
| **Adapter overlap** | Supervisor and Critic have different prompts; train on distinct data. Use separate adapter names. |
| **Catastrophic forgetting** | Low-rank LoRA limits impact. Monitor base capabilities on holdout set. |
| **Overfitting to logs** | Logs may be biased. Balance positive/negative examples. Use diverse sources. |
| **Schema drift** | SupervisorOut/CriticOut change over time. Version adapters; retrain when schema changes. |
| **Multi-LoRA memory** | vLLM `max_loras`, `max_lora_rank` affect memory. Start small (rank 16); increase if needed. |

---

## Observed Limitations and LoRA Training Priorities

> See [MODEL_EXERCISE.md](MODEL_EXERCISE.md) for the full list of observed model limitations per role, benchmark methodology, and external critic scores.

The following priorities are ordered by impact. Each describes the specific behavior gap that prompt engineering cannot fully close, the training data shape, and the signal that triggers LoRA investment.

### Priority 1: Planner LoRA (Qwen3-8B base)

**Target behavior:** Faithful 1:1 mapping of user deliverables to plan steps. Extraction of meta-instructions (format constraints, structural requests) into the `assumptions` field.

**Observed gap:** The 8B planner merges a user's 8 explicit deliverables into 4-5 generic steps. It fails to extract "separate facts from assumptions" or "make tradeoffs explicit" into the `assumptions` field despite explicit prompt instructions. See MODEL_EXERCISE.md § Router / Planner.

**Training data shape:**

| Input | Output |
|-------|--------|
| Complex user prompt with N numbered deliverables + 3-5 meta-instructions | Plan JSON with exactly N steps (1:1 mapped) + each meta-instruction captured in `assumptions` as `"User format constraints: ..."` |
| Simple user prompt with 2 deliverables | Plan JSON with 2 steps, no invented extras |

**Data sources:** (1) Manually curated benchmark prompts with gold-standard plans. (2) Filtered Synesis logs where planner output was later corrected by critic feedback. (3) Synthetic generation from larger model (GPT-4-class) producing gold plans from user prompts.

**Evaluation metric:** Deliverable coverage rate — percentage of user-listed deliverables that appear as distinct plan steps. Target: 95%+. Current baseline (prompt-only): ~60%.

**Signal to train:** When `KNOWLEDGE_PLANNER_PROMPT` strengthening (Phase 4) still results in merged/dropped deliverables on >20% of complex benchmark prompts.

### Priority 2: Worker LoRA (Qwen3-32B base)

**Target behavior:** Commit to concrete technology choices with justification. Follow multi-layered meta-instructions: facts/assumptions/recommendations separation, timeline constraining, uncertainty disclosure. Resist "menu-style" responses.

**Observed gap:** The 32B model lists alternatives ("use Elasticsearch or Weaviate") instead of recommending one with justification. It invents plausible metrics ("70% confidence threshold") rather than admitting uncertainty. It proposes overbuilt stacks that ignore stated timeline constraints. See MODEL_EXERCISE.md § General / Worker.

**Training data shape:**

| Input | Output |
|-------|--------|
| Architecture prompt + planner outline + format constraints (separate facts/assumptions/recommendations, constrain to 90 days, be specific) | Response with explicit ## Facts / ## Assumptions / ## Recommendations headers, named technologies with 1-sentence justifications, scope limited to stated timeline, [Uncertain] flags on speculative claims |
| Simple explanation prompt | Concise markdown response without over-structuring |

**Data sources:** (1) Manually curated gold-standard architecture responses scored 8+/10 by external critic. (2) Contrastive pairs: (weak 5/10 response, strong 8/10 response) for the same prompt. (3) Filtered production logs where critic revision improved response quality.

**Evaluation metric:** External critic score on benchmark architecture prompt. Target: 7.5+/10. Current baseline (prompt-only): 5.5/10.

**Note on training cost:** 32B LoRA requires more VRAM. Use QLoRA (4-bit base + LoRA adapters) on 2x L40S (96GB total). Alternatively, use LoRA on the FP8 checkpoint directly if vLLM supports it at training time.

**Signal to train:** When `_DEEP_DIVE_SUFFIX` + temperature 0.4 + format constraints pipeline still produces "menu-style" responses on >30% of benchmark prompts.

### Priority 3: Critic LoRA (Qwen3-8B base)

**Target behavior:** Flag generic/menu-style responses as `approved=false`. Verify structural compliance against user's explicit format requests. Reject invented metrics and unsupported claims.

**Observed gap:** The 8B critic at temperature 0.1 approves responses that score 5/10 on the external benchmark. It doesn't reliably detect "X or Y" listing without recommendation, doesn't verify fact/assumption/recommendation separation when the user requested it, and doesn't flag invented thresholds. See MODEL_EXERCISE.md § Critic.

**Training data shape:**

| Input | Output |
|-------|--------|
| Weak response (5/10) + user task with explicit format constraints | `approved=false`, `blocking_issues` citing "lists alternatives without choosing" (ref_type="taxonomy_depth"), "ignores 90-day constraint", "invents 70% confidence threshold without justification" |
| Strong response (8/10) + same user task | `approved=true`, `nonblocking` with minor polish suggestions |

**Data sources:** (1) Pairs of (response, external critic assessment) from benchmark runs. (2) Synthetic examples where a weak response is paired with specific blocking_issues that match the external critic's complaints.

**Evaluation metric:** Precision and recall on rejection of sub-6/10 responses. Target: 80% recall on weak responses, 95% precision on strong responses (avoid false blocks).

**Signal to train:** When the critic consistently approves responses that the external benchmark scores below 6/10.

---

## Evaluation Framework

For each LoRA adapter, maintain a holdout evaluation set:

1. **Benchmark prompts:** 10-20 complex prompts spanning architecture, system design, knowledge synthesis, and code generation. Include the primary architecture benchmark prompt.
2. **Gold-standard outputs:** For each prompt, a reference output scored 8+/10 by external critic.
3. **Regression tests:** Simple prompts that should not change behavior (greetings, basic code, simple explanations).
4. **External critic scoring:** Run the external critic on each response and track the score distribution.
5. **A/B comparison:** For each adapter, compare base model + prompt-only vs. base model + LoRA on the same prompts. The LoRA must improve benchmark scores without regressing simple tasks.

Track results in MODEL_EXERCISE.md benchmark table.

---

## Next Steps (When Ready)

1. Set up Unsloth or Axolotl environment (GPU instance or cluster).
2. Export and curate training data from Synesis logs.
3. Create gold-standard benchmark dataset (10-20 prompts with reference outputs).
4. Define evaluation metrics per role (see Evaluation Framework above).
5. Train Priority 1 (Planner LoRA) first — lowest cost, highest impact.
6. Evaluate with benchmark; if scores improve, deploy via vLLM `--lora-modules`.
7. Proceed to Priority 2 (Worker LoRA) when planner quality is stable.
8. A/B test base vs. LoRA in staging before production rollout.
