# LoRA Training Guide for Synesis Manager Cluster

This document describes how to train and tune LoRA adapters for the Supervisor and Critic nodes in the Synesis graph. The Manager Cluster uses a single base model (Qwen3.5-35B-A3B) with two LoRA adapters to specialize behavior without maintaining separate 35B fine-tunes.

**Status:** Planning. Training is a future process; this doc captures the path, advantages, concerns, and tooling.

**Related:** [BLACKWELL_ARCHITECTURE.md](BLACKWELL_ARCHITECTURE.md), [WORKFLOW.md](WORKFLOW.md)

---

## No LoRA Required to Start

**You do not need two model instances or LoRA adapters** to achieve distinct Supervisor vs Critic behavior. One Manager instance serves all three roles (Supervisor, Planner, Critic) via:

| Role | Purpose | Differentiation |
|------|---------|-----------------|
| **Supervisor** | Task routing, context curating, clarification decisions | System prompt + `temperature=0.0`, `max_tokens=1536` |
| **Planner** | Execution plans, `touched_files`, dependencies | System prompt + `temperature=0.2`, `max_tokens=2048` |
| **Critic** | Deep logical validation, patch integrity, what‑if analysis | System prompt + `temperature=0.1`, `max_tokens=4096` |

Each node uses a different `ChatOpenAI` instance with role-specific prompts and inference params. The same vLLM endpoint (`synesis-manager-predictor`) handles all requests; behavior differs per request content, not per model. No LoRA weights, no adapter IDs, no second GPU.

**When to add LoRA:** If prompts + params are insufficient—e.g. Supervisor over-clarifies despite prompt changes, or Critic false positives persist—then train adapters and load them with vLLM `--lora-modules`. Until then, config-only differentiation is sufficient.

---

## Why LoRA for Supervisor and Critic?

| Benefit | Description |
|---------|-------------|
| **Shared base, distinct personas** | One base model (~18GB VRAM) serves both roles. Adapters add ~50–200MB each. Far cheaper than two separate 35B models. |
| **Fast adapter swap** | vLLM Multi-LoRA switches adapters per request in milliseconds. No model reload. |
| **Configurable bias** | Adapters can encode temperature, verbosity, risk tolerance, and routing preferences. Train one adapter per "profile" or customer segment. |
| **Incremental improvement** | Fix Supervisor over-clarification or Critic false positives without retraining the full 35B. |
| **Lower training cost** | LoRA trains 0.1–1% of parameters. Much faster and cheaper than full fine-tuning. |

---

## Training Stack Options

| Tool | Best for | Pros | Cons |
|------|----------|------|------|
| **Unsloth** | Fast iteration | 2x faster, 70% less memory, QLoRA support | Newer ecosystem |
| **Axolotl** | Reproducibility | YAML config, wandb, many formats | Heavier setup |
| **PEFT + Transformers** | Custom pipelines | Full control, Hugging Face native | More code |
| **vLLM LoRA training** | Alignment with serving | Same stack | Less mature for training |

**Recommendation:** Start with **Unsloth** or **Axolotl**. Unsloth if speed matters; Axolotl if you want declarative config and experiment tracking.

---

## Data Requirements

### Supervisor LoRA

**Goal:** Triage intent, routing, planning_suggested, clarification behavior. Should *not* ask clarification for trivial/small when clarification_budget=0.

| Data type | Examples | Format |
|-----------|----------|--------|
| Intent triage | (user message → task_size, target_language, route_to) | JSONL: input + structured output |
| Clarification decisions | (context → needs_clarification bool, clarification_question or null) | JSONL |
| Planning vs. direct | (context → planning_suggested bool) | JSONL |

**Sources:**
- Logged Synesis runs where Supervisor was correct vs. over-asked
- Synthesized examples from WORKFLOW.md rules
- Human-labeled corrections

### Critic LoRA

**Goal:** Evidence-gated critique, Security-II what-if, blocking_issues. Avoid false positives on safe code.

| Data type | Examples | Format |
|-----------|----------|--------|
| Approval decisions | (code + sandbox result → approved bool, blocking_issues) | JSONL |
| What-if reasoning | (code + context → what_if_suggestions) | JSONL |
| Evidence refs | Pointer-only evidence, no inline pasting | Matches CriticOut schema |

**Sources:**
- Successful vs. failed Critic decisions from logs
- Security review labels (safe vs. unsafe)
- Human feedback on false positives/negatives

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
   - Base: Qwen3.5-35B-A3B (text-only)
   - Rank: 16–64, alpha: 32 (typical)
   - Epochs: 2–4, lr: 1e-4 to 5e-5
4. Export adapter (safetensors)
5. Add to vLLM --lora-modules
6. Route requests by adapter name (e.g. model=Qwen3.5-35B-A3B/synesis-supervisor)
```

---

## Advantages of LoRA Tuning

- **Faster iteration:** Retrain in hours, not days. Test new behaviors without full model rebuild.
- **Per-customer profiles:** Train `supervisor-strict` vs. `supervisor-relaxed` for different risk appetites.
- **Fix narrow failures:** If Supervisor keeps asking "Which database?" on trivial tasks, add 50 corrected examples and retrain adapter.
- **Token/parameter efficiency:** Adapters are small; share base model across roles and customers.
- **Easier rollback:** Swap adapter file; no base model change.

---

## Concerns and Mitigations

| Concern | Mitigation |
|---------|------------|
| **Adapter overlap** | Supervisor and Critic have different prompts; train on distinct data. Use separate adapter names. |
| **Catastrophic forgetting** | Low-rank LoRA limits impact. Monitor base capabilities (e.g. general QA) on holdout set. |
| **Overfitting to logs** | Logs may be biased (e.g. more failures). Balance positive/negative examples. Use diverse sources. |
| **Schema drift** | SupervisorOut/CriticOut change over time. Version adapters; retrain when schema changes. |
| **Multi-LoRA memory** | vLLM `max_loras`, `max_lora_rank` affect memory. Start small (rank 16); increase if needed. |
| **Training data quality** | Garbage in, garbage out. Prefer human-reviewed or high-confidence automated labels. |

---

## How This Helps Synesis

1. **Reduce over-clarification:** Supervisor LoRA learns when *not* to ask. Fewer "Which script?" on hello-world.
2. **Sharper Critic:** Fewer false positives on safe code; better catch on real issues (imports, secrets, scope).
3. **Configurable rigor:** Strict vs. permissive adapters for different orgs or compliance contexts.
4. **Cheaper scaling:** One 35B base + N adapters vs. N separate 35B models.
5. **Continuous improvement:** As users provide feedback, retrain adapters and deploy without base model churn.

---

## Next Steps (When Ready)

1. Set up Unsloth or Axolotl environment (GPU instance or cluster).
2. Export and curate training data from Synesis logs.
3. Define evaluation metrics (precision on clarification, Critic approval accuracy).
4. Train initial Supervisor and Critic LoRAs on base model behavior.
5. Integrate adapters into vLLM `--lora-modules` and Planner routing.
6. A/B test base vs. LoRA in staging before production rollout.
