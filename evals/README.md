# Synesis Full vs Selective A/B Evaluation

## Overview

Compares two inference modes:

- **`full`** — current pipeline: always-on frame extraction, retrieval, critic,
  and verification for non-trivial prompts.
- **`selective`** — answer-first: lean on the main LLM for most prompts,
  only escalate to frame repair / critic / RAG when difficulty or risk
  signals warrant it.

## Files

| File | Purpose |
|------|---------|
| `benchmark_prompts.yaml` | 70 evaluation prompts (25 easy, 25 medium, 20 hard) |
| `judge_rubric.yaml` | External judge scoring rubric and deterministic checks |
| `run_ab.py` | Runner that sends prompts in both modes and collects metrics |
| `README.md` | This file |

## Quick Start

```bash
# 1. Set the planner to accept per-request mode override via header
#    (already wired — X-Synesis-Inference-Mode header)

# 2. Run evaluation (with external judge)
export OPENROUTER_API_KEY=...
python evals/run_ab.py \
    --prompts evals/benchmark_prompts.yaml \
    --rubric evals/judge_rubric.yaml \
    --planner-url http://localhost:8000/v1/chat/completions \
    --judge-api-key $OPENROUTER_API_KEY \
    --output evals/results/

# 3. Run evaluation (deterministic checks only, no judge)
python evals/run_ab.py \
    --prompts evals/benchmark_prompts.yaml \
    --planner-url http://localhost:8000/v1/chat/completions \
    --no-judge \
    --output evals/results/

# 4. Run a single bucket
python evals/run_ab.py \
    --prompts evals/benchmark_prompts.yaml \
    --planner-url http://localhost:8000/v1/chat/completions \
    --no-judge \
    --buckets easy

# 5. Run specific prompts
python evals/run_ab.py \
    --prompts evals/benchmark_prompts.yaml \
    --planner-url http://localhost:8000/v1/chat/completions \
    --no-judge \
    --ids hard-01,easy-02
```

## Acceptance Gates (Quality-First)

Before rolling out `selective` mode:

### Must-Pass (Hard Gates)

1. **No quality regression on hard prompts**: Mean weighted judge score for
   `selective` on hard bucket must be >= 95% of `full` score.
2. **Must-pass check parity**: Pass rate on deterministic checks (code fences,
   no think tags, heading structure) must not regress.
3. **No new failure modes**: Error rate for `selective` must not exceed `full`
   by more than 2 percentage points.

### Should-Pass (Soft Gates)

4. **Latency improvement on easy/medium**: p95 latency for `selective` should
   be at least 20% lower than `full` on easy prompts, 10% on medium.
5. **Cost reduction**: Mean tokens/request for `selective` should be lower than
   `full` on easy and medium buckets.
6. **Judge preference**: On easy/medium, `selective` should be preferred or
   tied in >= 60% of judge comparisons.

### Decision Matrix

| Hard Gate | Soft Gate | Action |
|-----------|-----------|--------|
| All pass  | All pass  | Roll out `selective` as default |
| All pass  | Some fail | Roll out `selective` for easy/medium only; keep `full` for hard |
| Any fail  | —         | Keep `full`; tune selective thresholds and re-evaluate |

## Per-Request Mode Override

The planner accepts `X-Synesis-Inference-Mode: full|selective` header to
override the global `SYNESIS_INFERENCE_MODE` env var for A/B evaluation.
This avoids restarting pods between runs.

## Effective Threshold Comparison

| Threshold | Full | Selective | Effect |
|-----------|------|-----------|--------|
| RAG disable below | 0.3 | 0.5 | More prompts skip retrieval |
| Frame repair above | 0.4 | 0.6 | Fewer LLM repair calls |
| Entry fast-path below | 0.3 | 0.5 | More prompts skip advisor + frame |
| Critic skip below | 0.15 | 0.3 | More prompts skip critic |
| Critic lenient below | 0.4 | 0.6 | More prompts get lenient critic |
| Multi-query above | 0.3 | 0.5 | Fewer multi-query fan-outs |
| HyDE above | 0.5 | 0.7 | Fewer HyDE variant generations |

## Rollout Stages

1. **Offline replay**: Run `run_ab.py` against the live planner with both
   modes. Collect metrics. Apply acceptance gates.
2. **Shadow traffic**: Set `SYNESIS_INFERENCE_MODE=selective` on one pod
   replica. Compare logs side-by-side.
3. **Segmented rollout**: If gates pass, make `selective` the default for
   easy/medium prompts (difficulty < 0.6) while keeping `full` for hard.
4. **Full rollout**: After 1-2 weeks of monitoring, promote `selective` to
   default if no regressions detected.
