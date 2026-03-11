# Synesis Experiments

Ideas explored but not yet implemented. Each experiment includes rationale,
expected tradeoffs, and rough implementation notes so future work can pick
them up without re-deriving context.

---

## Experiment 1: Per-Section Parallel Critic

**Status:** Not implemented -- documented for future exploration.

**Context (March 2026):**
The deep-dive pipeline generates sections in parallel,
then merges them into a single blob evaluated by one holistic critic call.
This works well for moderate complexity, but the single-pass critic has
limitations:

- One large context per critic call (8-16K chars) -- less precise for
  smaller critic models (14B-32B).
- Cannot provide section-specific approval/rejection without parsing
  the merged text.
- Cannot parallelize evaluation across sections.

**Proposed architecture:**

```
Writer Section 1 ──> Section Critic 1 ──┐
Writer Section 2 ──> Section Critic 2 ──┤
Writer Section 3 ──> Section Critic 3 ──├──> Merge ──> Holistic Critic (optional)
Writer Section 4 ──> Section Critic 4 ──┤
Writer Section N ──> Section Critic N ──┘
```

Each section critic receives:
- The section text (~2-4K tokens)
- The matched deliverable from the semantic frame
- The section's specific constraints
- A lightweight rubric (just that section's requirements)

Per-section critic output:
- Section-level scores (task_faithfulness, coverage, grounding)
- Section-specific repair instructions
- CRAG confidence for that section

Failed sections get re-sent to their section worker with repair instructions
before the merge step, avoiding full-pipeline retries.

**Why this could be valuable:**

1. **Smaller context per critic call** -- better precision from 14B-32B
   models that struggle with long-context evaluation.
2. **Parallel evaluation** -- 6 critic calls can run concurrently,
   similar latency to one call.
3. **Targeted retries** -- only re-generate sections that failed, not
   the entire response.
4. **KV cache efficiency** -- small context = fast prefill on A10G GPUs.
5. **Matches our architecture philosophy** -- multi-pass with smaller
   models and targeted context, rather than one-shot with frontier models.

**Why it's not implemented yet:**

1. **6x additional LLM calls** to the critic model per request. The critic
   model is a shared resource; 6 concurrent critic calls may queue.
2. **Cannot catch cross-section issues** (overlap, gaps, contradictions)
   without the holistic pass.
3. **Retry complexity** -- a failed section needs re-generation from the
   writer, which requires maintaining the Send() state.
4. **Latency risk** -- if critic calls don't fully overlap with section
   generation, total wall-clock time increases.

**Prerequisites to try this:**

- Dedicated critic model capacity (or a fast lightweight critic like
  Qwen2.5-7B for per-section, with the 14B+ model for holistic).
- LangGraph support for conditional re-sends within a fanout (or a
  custom retry loop in the writer node).
- Metrics showing that the holistic critic is missing section-specific
  issues despite the per-section scoring prompt added in March 2026.

**Rough implementation path:**

1. Add a `section_critic` node that takes a single section result +
   its deliverable + frame constraints.
2. Run section_critic in parallel after writer (pipeline them
   or use a separate fanout).
3. Section_critic returns `{section_id, approved, repair_instructions}`.
4. If any section fails, re-send to writer with repair instructions.
5. After all sections pass, merge and optionally run the holistic critic
   for cross-section coherence.

**Metrics to validate:**

- Per-section requirement coverage (met/partial/missed) compared to
  holistic-only evaluation.
- Total latency impact (parallel critic adds ~2-5s if the model is free).
- Retry rate: how often per-section critic catches issues the holistic
  critic would miss (or vice versa).

---

## Experiment 2: Adaptive Depth Mode (Parallel vs Monolithic)

**Status:** Not implemented -- the parallel path is now always used for
2+ step plans.

**Idea:** Instead of always using parallel sections for complex prompts,
dynamically choose between parallel sections and monolithic generation
based on:

- Number of deliverables (>4 favors parallel)
- Token budget required (>8K favors parallel)
- Retrieval diversity (high topic diversity favors parallel)
- Available model capacity (low GPU headroom favors monolithic)

The monolithic path currently does not use the semantic frame for retrieval,
so this experiment would also require frame-driven retrieval in the
monolithic worker.

**Why deferred:** The parallel path now has frame-driven queries, coherence
gating, per-section deliverable injection, and section-level critic scoring.
There's no clear advantage to monolithic for complex prompts anymore.
