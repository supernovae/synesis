# Critic Design: Research Basis and Best Practices

This document captures the research foundation for the Synesis critic node's
evaluation rubric. It should be updated as we iterate on critic behavior and
as new research becomes available.

**Canonical paper links:** [AWESOME_PAPERS.MD — Critic, judges, and evaluation](AWESOME_PAPERS.MD#critic-judges-and-evaluation).

---

## 1. Context and Current State

The Synesis critic scores responses on factual grounding, constraint compliance,
and structural fidelity. Early testing identified four problems that the research
below informed fixes for:

| Problem (observed) | Root cause (research) | Fix (implemented) |
|---|---|---|
| No failure mode for shallow responses | LLM judges don't penalize thin content unprompted (ResearchRubrics, ARES) | `insufficient_depth` and `evidence_underuse` failure modes with deterministic citation rate check |
| 200 chars/section skeleton too small to detect thin content | Skeleton hid the very problem the critic needed to catch | 500 chars/section for difficulty >= 0.6; full text for non-lenient tasks; input budget scales 8K-24K by difficulty |
| 2,000 char evidence budget too small to verify evidence use | Critic couldn't compare response claims against provided evidence | 4,000 char evidence reference budget (`critic_rag_context_budget`) |
| Score compression (10/10 on lean output) | Systematic top-of-scale bias in LLM-as-judge (Latent Judges) | Binary failure modes override inflated scores; deterministic depth gate rejects shallow responses regardless of LLM score |

---

## 2. Key Research Papers

### 2.1 ResearchRubrics — Evaluating Deep Research Agents

**Paper**: Wibowo et al., "ResearchRubrics: A Benchmark of Prompts and Rubrics
For Evaluating Deep Research Agents," arXiv:2511.07685, Nov 2025.

**Relevance**: The closest analogue to our use case. Evaluates long-form,
multi-step, evidence-based research responses (exactly what our pipeline
produces).

**Key findings**:
- Evaluates on three axes: **factual grounding**, **reasoning soundness**,
  **clarity**.
- Even state-of-the-art systems (Gemini DR, OpenAI DR) achieve **under 68%
  rubric compliance**.
- Primary failure modes: **missed implicit context** and **inadequate reasoning
  about retrieved information**.
- Uses 2,500+ fine-grained, binary-checkable rubric items — not holistic scores.
- Introduces a complexity taxonomy: conceptual breadth, logical nesting,
  exploration scope.

**What we implemented from this paper**:
- `evidence_underuse` failure mode catches "inadequate reasoning about retrieved
  information" — the primary failure mode this paper identifies.
- Deterministic citation rate check (< 30% of evidence URIs cited at difficulty
  >= 0.6 triggers `evidence_underuse` without LLM involvement) acts as a
  binary-checkable rubric item resistant to score inflation.
- Complexity-aware evaluation: our `difficulty` parameter drives the depth gate,
  skeleton visibility, input budget, and thinking budget — validated by this
  paper's complexity taxonomy.

---

### 2.2 RAG-Zeval — Rule-Guided RAG Evaluation

**Paper**: "RAG-Zeval: Towards Robust and Interpretable Evaluation on RAG
Responses through End-to-End Rule-Guided Reasoning," arXiv:2505.22430, May 2025.

**Relevance**: Demonstrates that structured rule-based evaluation outperforms
open-ended LLM scoring for RAG systems.

**Key findings**:
- Formulates faithfulness and correctness as a **rule-guided reasoning task**.
- Compact evaluator models (10-100x fewer parameters) achieve **stronger
  correlation with human judgments** than large LLMs.
- Single-pass assessment is sufficient when rules are well-defined.

**What we implemented from this paper**:
- The critic prompt uses **14 enumerated failure modes** with definitions (e.g.
  `genericity`, `unsupported_specificity`, `insufficient_depth`,
  `evidence_underuse`) rather than open-ended quality rating.
- Each failure mode has a concrete definition in the prompt so the LLM applies
  it consistently.

**Future work** (Phase 3): A smaller, faster model trained on structured rules
could replace the large critic model. Requires calibration data (Phase 2) first.

---

### 2.3 ARES — Automated RAG Evaluation System

**Paper**: Saad-Falcon et al., "ARES: An Automated Evaluation Framework for
Retrieval-Augmented Generation Systems," Stanford, arXiv:2311.09476, 2023
(updated 2024).

**Relevance**: The standard framework for RAG evaluation, defining the
canonical evaluation dimensions.

**Key findings**:
- The **RAG Triad**: context relevance, answer faithfulness, answer relevance.
- Uses Prediction-Powered Inference (PPI) for statistically confident
  evaluation with minimal human annotations.
- Synthetic data generation to finetune lightweight judge models.
- Model-agnostic; judges remain effective across domain shifts.

**What we implemented from this paper**:
- The RAG Triad is fully covered by our 6-axis scoring:
  - **Answer faithfulness** → `grounding` (0.10) + `task_faithfulness` (0.25)
  - **Context relevance** → `coverage` (0.25) + `evidence_utilization` (0.10)
  - **Answer relevance** → `constraint_compliance` (0.20) + `judgment_quality` (0.10)
- "Does the response incorporate the retrieved context meaningfully?" is now
  both an LLM scoring dimension (`evidence_utilization`) and a deterministic
  check (citation rate).

---

### 2.4 GER-Eval — LLM-Designed Rubrics

**Paper**: "Learning to Judge: LLMs Designing and Applying Evaluation Rubrics,"
arXiv:2602.08672, Feb 2026.

**Relevance**: Studies whether LLMs can reliably design and apply their own
evaluation rubrics.

**Key findings**:
- LLM-designed rubrics work well for subjective tasks but **degrade in
  factual and knowledge-intensive settings**.
- Open-weight models (e.g. Llama) show **lower inter-rater agreement** than
  closed-source models (e.g. GPT-4o).
- Rubric items must be **concrete and binary-checkable** to maintain
  consistency.

**What we implemented from this paper**:
- Since we use open-weight models (DeepSeek R1-Distill-32B), we supplement
  LLM scoring with **deterministic binary checks** that do not depend on model
  consistency:
  - Deliverable coverage precheck (headings + word count)
  - Evidence citation rate (< 30% = `evidence_underuse`)
  - Hallucinated URL detection (cited URLs not in evidence packets)
- These binary checks override the LLM's 0-10 scores when they fire,
  avoiding the reliability degradation this paper documents for open-weight
  models on subjective criteria.

---

### 2.5 Latent Judges — Score Compression Problem

**Paper**: "Latent Judges," arXiv:2509.24678, Sep 2025.

**Relevance**: Explains why our critic gives 10/10 on lean output.

**Key findings**:
- Standard LLM-as-judge prompting **compresses scores near the top of the
  scale** — a systematic bias, not a random error.
- **Explicit rubrics with binary pass/fail items** resist this inflation.
- Latent signal extraction (from internal model activations) produces better
  calibrated scores, but requires access to model logits or hidden-layer
  activations.

**What we implemented from this paper**:
- Binary failure modes (`insufficient_depth`, `evidence_underuse`,
  `hallucinated_citation`) override inflated LLM scores. The deterministic
  depth gate rejects responses at difficulty >= 0.7 regardless of the LLM's
  `weighted_overall` score when these failure modes fire.
- This directly addresses the score compression problem without requiring
  access to model internals.

**Not applicable**: Latent signal extraction requires logit-level access
through model activations (linear probes on hidden layers). vLLM's
OpenAI-compatible chat API does not expose this. The binary failure mode
approach achieves a similar goal through a different mechanism.

---

### 2.6 Causal Judge Evaluation — Calibration

**Paper**: "Causal Judge Evaluation: Calibrated Surrogate Metrics for LLM
Systems," arXiv:2512.11150, Dec 2025.

**Relevance**: Demonstrates the consequences of uncalibrated LLM judges.

**Key findings**:
- Uncalibrated judges exhibit **preference inversion** (higher scores predict
  lower true quality) and **invalid confidence intervals** (0% coverage
  without calibration vs ~95% with it).
- Calibrating against just 5% oracle labels achieves 99% ranking accuracy at
  14x lower cost.

**What we implemented from this paper**:
- Scoring dimensions are **independent and concrete** (6 axes with defined
  weights), reducing calibration problems.

**Future work** (Phase 2): Collect human feedback on a small sample of
responses and calibrate critic scores against them. The `request_feedback`
structured log in `graph.py` captures the data needed; what's missing is a
calibration pipeline to process it.

---

### 2.7 CLEAR — Actionable Error Analysis

**Paper**: "CLEAR: Error Analysis via LLM-as-a-Judge Made Easy,"
arXiv:2507.18392, Jul 2025.

**Relevance**: Provides a pattern for going beyond single scores to actionable
error analysis.

**Key findings**:
- Per-instance feedback + system-level error pattern identification.
- Quantifies issue prevalence across a corpus.
- Interactive dashboards for investigation.

**What we have in place**:
- `request_feedback` structured log emits per-request data including difficulty,
  domain tags, evidence packet count, average confidence, and critic scores.
- `failure_modes_detected` is logged per critic invocation.

**Future work** (Phase 3): Aggregate critic failure modes across requests to
identify systematic pipeline weaknesses (e.g. "30% of hard queries trigger
`evidence_underuse`"). Build an interactive dashboard for investigation.

---

### 2.8 ManyIFEval — Instruction Following Degrades with Count

**Paper**: "Curse of Instructions: ManyIFEval — Evaluating LLMs on
Multi-Instruction Following," 2024-2025 (extensions of IFEval, arXiv:2311.07911).

**Relevance**: Directly explains why compound prompts (e.g. "design an
architecture that can 1) answer docs, 2) help write code, 3) avoid
hallucination, 4) escalate, 5) keep costs low") lose individual requirements.

**Key findings**:
- LLM compliance follows a **power law** vs instruction count. GPT-4o
  success on 10 simultaneous instructions: **15-31%** (31% with iterative
  self-refinement).
- Multi-Dimensional Constraint Framework (arXiv:2505.07591) tested 19 LLMs:
  performance drops from **77.67% at Level I** to **32.96% at Level IV**.
- WildIFEval (arXiv:2503.06573) categorizes constraints into 8 classes and
  finds all models struggle with multiple simultaneous constraints.

**What we implemented from this paper**:
- **Planner capability injection**: `explicit_requirements` are now injected
  into the planner prompt as individually listed "SYSTEM CAPABILITIES" so
  each requirement is explicitly visible (not buried in a compound paragraph).
  This is the explicit decomposition strategy the research recommends.
- **Per-requirement deterministic check**: `_deterministic_requirement_coverage`
  in the critic verifies each requirement individually, implementing the
  per-constraint verification the Multi-Dimensional Constraint Framework
  advocates.

**Key design decision**: We chose NOT to modify the taxonomy to address
requirement coverage. The taxonomy provides domain style and depth guidance
(e.g. "write like an architecture document"). Requirement coverage must be
**user-driven** — derived from the user's actual requirements, not statically
prescribed. This ensures the system adapts to any domain intersection (e.g.
"AI + architecture" today, "payment systems + compliance" tomorrow) without
polluting domain taxonomies with cross-cutting concerns.

---

### 2.9 BEAVER — Deterministic Verification of LLM Outputs

**Paper**: "BEAVER: An Efficient Deterministic LLM Verifier,"
arXiv:2512.05439, Dec 2025.

**Relevance**: First framework for computing deterministic, sound probability
bounds on LLM constraint satisfaction.

**Key findings**:
- Achieves **6-8x tighter probability bounds** and identifies **3-4x more
  high-risk instances** vs baseline methods.
- Applied to correctness verification, privacy verification, and secure code
  generation.
- Demonstrates that deterministic verification catches failures that
  LLM-based evaluation misses.

**What we implemented from this paper**:
- `_deterministic_requirement_coverage` uses keyword extraction and paragraph
  proximity as a deterministic lower bound on requirement coverage. This is
  not probabilistic (BEAVER computes probability bounds over token tries),
  but follows the same principle: deterministic checks as a sound complement
  to LLM-based scoring.
- The check fires as a **binary gate**: either a requirement has substantive
  coverage (40+ word paragraph with 50% keyword overlap) or it doesn't.
  No LLM judgment involved.

---

### 2.10 FActScore — Per-Claim Atomic Evaluation

**Paper**: Min et al., "FActScore: Fine-grained Atomic Evaluation of Factual
Precision in Long Form Text Generation," EMNLP 2023, arXiv:2305.14251.

**Relevance**: Establishes the per-claim evaluation paradigm we apply to
requirement coverage.

**Key findings**:
- Breaks generated text into **atomic facts** and scores each individually.
- ChatGPT achieves only **58%** on biography generation — holistic evaluation
  would mask this per-claim variance.
- Automated evaluation achieves **< 2% error rate** vs human judgment.

**What we implemented from this paper**:
- The `_deterministic_requirement_coverage` check treats each
  `explicit_requirement` as an "atomic claim" that must be individually
  verified in the output. Requirements with no matching paragraph are flagged
  independently, preventing holistic "looks good overall" bias from masking
  per-requirement gaps.

---

### 2.11 TraceLLM — Requirements Traceability

**Paper**: "TraceLLM: Leveraging Large Language Models with Prompt Engineering
for Enhanced Requirements Traceability," arXiv:2602.01253, Feb 2026.

**Relevance**: Demonstrates that requirement traceability (linking requirements
to implementation artifacts) benefits from explicit prompt decomposition.

**Key findings**:
- Achieves state-of-the-art F2 scores across 8 LLMs on 4 benchmark datasets.
- Traceability performance depends critically on **prompt quality** and
  **label-aware, diversity-based sampling**.
- Outperforms traditional IR baselines and fine-tuned models.

**What we implemented from this paper** (indirect):
- The planner's capability injection creates an explicit traceability link:
  each `explicit_requirement` is listed in the planner prompt, the planner
  maps it to plan sections, the writer follows the plan, and the critic
  verifies coverage. This is a lightweight form of requirements traceability
  through the pipeline.

**Future work**: Implement explicit requirement-to-section mapping in the plan
output schema (deliverable_ids already exist for deliverables; extend to
capability_requirement_ids).

---

## 3. Recommended Path Forward

### Phase 1: Immediate -- IMPLEMENTED

All Phase 1 items are implemented in the Retrieval Enrichment Pipeline.

1. **`insufficient_depth` failure mode** — Implemented. "Sections that lack
   concrete details, specific recommendations, or technical reasoning
   proportional to the task complexity." Blocking for difficulty >= 0.7, or
   when response < 3000 chars at that difficulty.

2. **`evidence_underuse` failure mode** — Implemented. "Available evidence was
   provided but the response does not incorporate or reference it meaningfully."
   A deterministic pre-check computes evidence citation rate: if < 30% of
   evidence packet URIs appear in the response at difficulty >= 0.6, the
   failure mode is injected automatically (no LLM involved).

3. **`evidence_utilization` scoring dimension** — Implemented as a weighted
   dimension (0.10 weight) in the critic's 6-axis scoring:
   `task_faithfulness (0.25), constraint_compliance (0.20), coverage (0.25),
   judgment_quality (0.10), grounding (0.10), evidence_utilization (0.10)`.

4. **Stricter depth gate** — Implemented. For difficulty >= 0.7: a single
   `insufficient_depth` or `evidence_underuse` is blocking. For difficulty
   >= 0.6: 2+ flagged sections is blocking. Short responses (< 3000 chars)
   at difficulty >= 0.7 with any depth failure are always blocking.

5. **Expanded critic visibility** — Implemented. Skeleton `per_section_chars`
   increased to 500 for hard tasks. Evidence reference budget increased to
   4,000 chars.

6. **`missing_requirement_coverage` failure mode** — Implemented. Per-requirement
   deterministic check (see §2.8, §2.9, §2.10) verifies that each
   `explicit_requirement` from the user's task has substantive paragraph
   coverage (keyword proximity + 40+ word paragraph threshold). Blocking at
   difficulty >= 0.7. Also injects actionable repair instructions naming the
   uncovered requirements.

7. **`thin_technology_coverage` failure mode** — Implemented. When
   `user_task.technologies` lists specific tools and no paragraph of 60+ words
   mentions them, flags non-blocking `thin_technology_coverage`. Repair
   instructions request workflow-specific details.

8. **Planner capability injection** — Implemented. The planner now receives
   `explicit_requirements` as "SYSTEM CAPABILITIES" alongside deliverables,
   filtered to exclude quality/style constraints and items already covered
   by deliverables. Ensures each user-requested capability maps to plan
   coverage upstream of the writer.

9. **Writer capability visibility** — Implemented. The writer's task block now
   formats requirements as a bulleted "SYSTEM CAPABILITIES" list instead of a
   semicolon-joined line, reinforcing depth-of-coverage expectations.

### Phase 2: Short-term

10. **Collect calibration data**: Use the `request_feedback` log to build a
    small corpus of (prompt, response, human_rating) triples. Even 50-100
    examples would allow calibrating critic scores against human judgment
    (per Causal Judge Evaluation). **Status**: Not started. The structured log
    exists in `graph.py`; what's needed is a collection pipeline and rating UI.

11. **Difficulty-aware rubric scaling** — PARTIALLY IMPLEMENTED. What scales
    with difficulty today:
    - Skeleton visibility: 500 chars/section for difficulty >= 0.6 (vs 200 default)
    - Critic input budget: 8K-24K chars based on difficulty
    - Depth gate thresholds: stricter at >= 0.7 than >= 0.6
    - Thinking budget: 256-2048 tokens scaled by difficulty
    What does NOT yet scale: the number of rubric criteria generated. Hard tasks
    get the same rubric template as medium tasks. Per ResearchRubrics, harder
    tasks should generate more fine-grained evaluation criteria.

12. **Track failure mode prevalence**: Aggregate `insufficient_depth`,
    `evidence_underuse`, `missing_requirement_coverage`, and
    `thin_technology_coverage` rates across requests to identify whether the
    problem is in retrieval, generation, or planning. **Status**: Partially
    implemented. `failure_modes_detected` is logged per critic invocation.
    No aggregation pipeline or dashboard yet.

13. **Explicit requirement-to-section traceability**: Per TraceLLM, extend the
    planner output schema with `capability_requirement_ids` (analogous to
    existing `deliverable_ids`) to create an auditable link from each
    requirement to the plan sections that address it. **Status**: Not started.

### Phase 3: Long-term (research-backed)

14. **Compact critic model**: Per RAG-Zeval, a smaller model trained on
    structured rules can outperform a large model with open-ended prompts.
    Fine-tune a lightweight judge on our calibration data. Requires Phase 2
    calibration data first.

15. **Failure pattern aggregation dashboard**: Per CLEAR, aggregate critic
    outputs into a dashboard showing system-level failure patterns, most common
    issues, and retrieval quality trends over time. The `request_feedback` and
    `critic_task_faithful_scores` structured logs provide the raw data.

---

## 4. Design Decisions

- **LLM scoring + deterministic overrides**: We use 0-10 scales across 6
  dimensions (the LLM is good at relative ranking) but supplement them with
  binary deterministic checks that override inflated scores: citation rate,
  deliverable coverage precheck, hallucinated URL detection, requirement
  coverage, and the depth gate. Research (Latent Judges, GER-Eval, BEAVER)
  confirms this hybrid approach resists score compression better than either
  method alone.

- **Taxonomy drives style; user requirements drive content**: Taxonomy
  provides domain-appropriate persona, depth instructions, and output style
  guidance. It does NOT prescribe content sections for specific task types
  (e.g. "coding assistant" sections in `software_architecture`). Content
  coverage is driven by the user's actual requirements, extracted by the
  frame extractor and injected into the planner as tracked capabilities.
  Research (ManyIFEval, Multi-Dimensional Constraint Framework) shows that
  per-requirement tracking is essential for compound instructions. This
  separation ensures taxonomies remain reusable across task variations
  within a domain.

- **Skeleton for lenient tasks; full visibility for strict**: Lenient tasks
  (difficulty < 0.4) use skeleton extraction to save latency. Strict tasks
  get the full response (input budget scales to 24K chars by difficulty).
  The critic sees enough to detect shallow content on the tasks where depth
  matters.

- **LLM-as-judge over deterministic metrics (BLEU, ROUGE)**: Research
  consensus (ARES, RAG-Zeval) is that LLM-as-judge outperforms token-overlap
  metrics for semantic quality. We use deterministic checks as **supplements**
  (citation rate, URL validation, deliverable coverage, requirement coverage,
  technology coverage) not replacements.

- **No latent signal extraction**: This technique (linear probes on hidden
  layers) produces better-calibrated scores than prompting (Latent Judges),
  but requires model activation access that vLLM's OpenAI-compatible API
  does not expose. Our binary failure mode approach achieves a similar goal
  through a different, production-practical mechanism.

---

## 5. References

Numbered list → titles and URLs: [AWESOME_PAPERS.MD — Critic, judges, and evaluation](AWESOME_PAPERS.MD#critic-judges-and-evaluation) (same ordering as sections 2.1–2.11 above).
