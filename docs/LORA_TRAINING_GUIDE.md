# LoRA Training Guide for Synesis

> **Status: NOT IMPLEMENTED.** No LoRA adapters are currently deployed. This documents the future training path for when prompt-only differentiation is insufficient.

This document describes how to train and tune LoRA adapters for the Router and Critic roles in the Synesis graph.

**Related:** [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD)

---

## No LoRA Required to Start

**You do not need LoRA adapters** to achieve distinct Router vs Critic behavior. The router deployment (Qwen2.5-14B-Instruct FP8) serves all three non-executor roles via:

| Role | Purpose | Differentiation |
|------|---------|-----------------|
| **Router** | Task routing, retrieval orchestration, clarification decisions | System prompt + `temperature=0.0`, `max_completion_tokens=1536` |
| **Planner** | Execution plans, `touched_files`, dependencies | System prompt + `temperature=0.2`, `max_completion_tokens=1024` |
| **Critic** | Logical validation, patch integrity, what-if analysis | System prompt + `temperature=0.1`, `max_completion_tokens=4096` |

Each node uses a different `ChatOpenAI` instance with role-specific prompts and inference params. The same vLLM endpoint handles all requests; behavior differs per request content, not per model.

**When to add LoRA:** If prompts + params are insufficient -- e.g. Router over-clarifies despite prompt changes, or Critic false positives persist -- then train adapters and load them with vLLM `--lora-modules`.

---

## Current Base Model

| Component | Model | Quantization | VRAM |
|-----------|-------|-------------|------|
| **Router, Planner, Critic** | Qwen2.5-14B-Instruct FP8 | FP8 | ~14 GB on L40S |
| **Critic (R1)** | DeepSeek R1-Distill-Qwen-32B FP8 | FP8 | ~33 GB on L40S |

LoRA adapters would be trained against the **Qwen2.5-14B-Instruct** base and loaded onto the router deployment. The R1-Distill critic would not use LoRA in the initial phase.

---

## Why LoRA for Router and Critic?

| Benefit | Description |
|---------|-------------|
| **Shared base, distinct personas** | One base model (~8GB VRAM) serves both roles. Adapters add ~50-200MB each. |
| **Fast adapter swap** | vLLM Multi-LoRA switches adapters per request in milliseconds. No model reload. |
| **Configurable bias** | Adapters can encode temperature, verbosity, risk tolerance, and routing preferences. |
| **Incremental improvement** | Fix Router over-clarification or Critic false positives without retraining the full model. |
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

### Router LoRA

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
   - Filter by node (router, critic)
   - Extract (input_messages, expected_output, outcome)
2. Convert to chat/instruction format
   - System prompt + user/assistant turns
   - Target format matches RouterOut / CriticOut JSON
3. Train LoRA (Unsloth or Axolotl)
   - Base: Qwen2.5-14B-Instruct (text-only)
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
| **Adapter overlap** | Router and Critic have different prompts; train on distinct data. Use separate adapter names. |
| **Catastrophic forgetting** | Low-rank LoRA limits impact. Monitor base capabilities on holdout set. |
| **Overfitting to logs** | Logs may be biased. Balance positive/negative examples. Use diverse sources. |
| **Schema drift** | RouterOut/CriticOut change over time. Version adapters; retrain when schema changes. |
| **Multi-LoRA memory** | vLLM `max_loras`, `max_lora_rank` affect memory. Start small (rank 16); increase if needed. |

---

## Observed Limitations and LoRA Training Priorities

> See [MODEL_EXERCISE.md](MODEL_EXERCISE.md) for the full list of observed model limitations per role, benchmark methodology, and external critic scores.

The following priorities are ordered by impact. Each describes the specific behavior gap that prompt engineering cannot fully close, the training data shape, and the signal that triggers LoRA investment.

### Priority 1: Planner LoRA (Qwen2.5-14B base)

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

### Priority 2: Executor LoRA (Qwen3-32B base)

**Target behavior:** Commit to concrete technology choices with justification. Follow multi-layered meta-instructions: facts/assumptions/recommendations separation, timeline constraining, uncertainty disclosure. Resist "menu-style" responses.

**Observed gap:** The 32B model lists alternatives ("use Elasticsearch or Weaviate") instead of recommending one with justification. It invents plausible metrics ("70% confidence threshold") rather than admitting uncertainty. It proposes overbuilt stacks that ignore stated timeline constraints. See MODEL_EXERCISE.md § General / Executor.

**Training data shape:**

| Input | Output |
|-------|--------|
| Architecture prompt + planner outline + format constraints (separate facts/assumptions/recommendations, constrain to 90 days, be specific) | Response with explicit ## Facts / ## Assumptions / ## Recommendations headers, named technologies with 1-sentence justifications, scope limited to stated timeline, [Uncertain] flags on speculative claims |
| Simple explanation prompt | Concise markdown response without over-structuring |

**Data sources:** (1) Manually curated gold-standard architecture responses scored 8+/10 by external critic. (2) Contrastive pairs: (weak 5/10 response, strong 8/10 response) for the same prompt. (3) Filtered production logs where critic revision improved response quality.

**Evaluation metric:** External critic score on benchmark architecture prompt. Target: 7.5+/10. Current baseline (prompt-only): 6.5-7/10 (improved from 5.5 via depth mode + steering; domain detection fix + epistemic enforcement pending).

**Note on training cost:** 32B LoRA requires more VRAM. Use QLoRA (4-bit base + LoRA adapters) on 2x L40S (96GB total). Alternatively, use LoRA on the FP8 checkpoint directly if vLLM supports it at training time.

**Signal to train:** When `_DEEP_DIVE_SUFFIX` + temperature 0.4 + format constraints pipeline still produces "menu-style" responses on >30% of benchmark prompts.

### Priority 3: Critic LoRA (Qwen2.5-14B base)

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

### Priority 4: Domain Classifier LoRA (Qwen2.5-14B base) — FUTURE

**Target behavior:** Map a user prompt directly to domain labels (software_architecture, cloud, kubernetes, etc.) and complexity assessment, replacing or augmenting the current keyword-based axis 2 detection.

**Observed gap:** The keyword-based domain detection in `intent_weights.yaml` is brittle — it requires exact keyword matches and a `min_hits` threshold. A prompt about "building an AI platform" is semantically `software_architecture` but may not hit any listed keywords. Adding more keywords is a stopgap; a classifier that understands semantic intent would be more robust. See MODEL_EXERCISE.md § Entry Classifier / Domain Detection.

**Training data shape:**

| Input | Output |
|-------|--------|
| User prompt text (architecture design, system proposal, etc.) | `{"domain": "software_architecture", "confidence": 0.92}` |
| User prompt text (Kubernetes deployment question) | `{"domain": "kubernetes", "confidence": 0.88}` |
| User prompt text (simple greeting or off-domain) | `{"domain": "general", "confidence": 0.95}` |

**Data sources:** (1) Curated prompt/domain pairs from production logs and benchmark prompts. (2) Synthetic prompts generated by a larger model with domain labels. (3) Edge cases: prompts that the keyword system misclassifies.

**Evaluation metric:** Domain classification accuracy on holdout set. Target: 95%+ accuracy. Current baseline (keyword-only): estimated ~75% on diverse prompts (based on benchmark prompt failure).

**Signal to train:** When keyword expansion + pairing rules still misclassify >15% of complex prompts on the benchmark set. This is a longer-term investment — keyword improvements should be exhausted first.

### Priority 5: Toulmin Argumentation LoRA (Qwen3-32B base) — FUTURE

**Target behavior:** Model produces claims with complete Toulmin structure (grounds, warrant, qualifier, rebuttal) by default, without requiring extensive system prompt steering. This would reduce dependence on long system prompts for argumentation quality.

**Observed gap:** Current models produce incomplete arguments — claims without warrants ("Use Elasticsearch"), decisions without rebuttals ("X or Y"), and unqualified confidence claims ("75% threshold"). The Toulmin rubric in the critic catches these, but ideally the generation model would produce complete arguments natively.

**Training data shape:**

| Input | Output |
|-------|--------|
| Architecture prompt + system instructions | Response with explicit claim/grounds/warrant/rebuttal structure for each major decision |
| Training plan prompt | Response with committed choices, rejected alternatives, qualified scope limits |
| Explanation prompt | Response with grounded claims, sourced evidence, stated limitations |

**Data sources:** (1) Production responses that score 8+/10 on the Toulmin critic rubric. (2) Synthetic paired examples: weak response (option-listing) → strong response (committed, warranted). (3) External critic feedback as reward signal.

**Evaluation metric:** Toulmin completeness score from the critic (% of major claims with all 5 components). Target: 80%+ claims complete. Current baseline: estimated ~30-40%.

**Signal to train:** When prompt-only Toulmin steering plateaus below 7/10 on the external critic benchmark across diverse domains (not just architecture).

**Research basis:** Toulmin zero-shot argument mining (ACL 2024, Gupta et al.), ArgLLMs (arxiv 2405.02079), Critical Questions for LLM Reasoning (arxiv 2412.15177).

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
7. Proceed to Priority 2 (Executor LoRA) when planner quality is stable.
8. A/B test base vs. LoRA in staging before production rollout.

---

## Closed-Loop Training Data Contract (Agentic Behavior)

For coding-agent stability work, use a shared trajectory contract across real traces, synthetic trajectories, and curated prompt tasks:

```json
{
  "task_id": "run123:5",
  "session_id": "run123",
  "model_id": "synesis-agent",
  "runtime_profile": "balanced_completion",
  "user_intent": "implement",
  "trajectory_steps": [
    {
      "assistant_action": "tool_call",
      "tool_name": "Bash",
      "args_valid": true,
      "tool_result_class": "ok",
      "token_cost": 850,
      "latency_ms": 2200
    }
  ],
  "outcome": "completed",
  "failure_tags": ["invalid_tool_args"],
  "strength_tags": ["recovery_success"],
  "quality_signals": {
    "tests_green": true,
    "retries_count": 1
  },
  "gold_next_step": "Apply one focused edit and run narrow verification"
}
```

### Minimum Label Taxonomy

- Weakness: `invalid_tool_args`, `read_loop`, `broad_verify_loop`, `no_progress`, `hallucinated_interface`
- Strength: `first_pass_fix`, `narrow_verification`, `correct_tool_choice`, `recovery_success`, `token_efficient`

### Dataset Mix Recommendation

- 50% real traces (anchor to production UX)
- 30% synthetic hard cases (coverage)
- 20% curated benchmark/prompt tasks (breadth)

## Integration with `~/src/qwen3`

Treat `~/src/qwen3` as the training workspace and this repo as the source of labeled/evaluable trajectory artifacts.

Suggested handoff:
1. Run feedback-loop pipeline in Synesis Admin (`/api/v1/feedback-loop/...`).
2. Export dataset (`jsonl`) from a run.
3. Import exported data into `~/src/qwen3` preprocessing pipeline.
4. Merge with synthetic/curriculum data and train LoRA candidate.
5. Replay eval suites and regression checks before any promotion.

Use consistent metadata keys (`task_id`, `failure_tags`, `strength_tags`, `runtime_profile`) so training and evaluation remain comparable over time.
