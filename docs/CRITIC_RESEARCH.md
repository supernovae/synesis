# Critic Design: Research Basis and Best Practices

This document captures the research foundation for the Synesis critic node's
evaluation rubric. It should be updated as we iterate on critic behavior and
as new research becomes available.

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

### Phase 2: Short-term

6. **Collect calibration data**: Use the `request_feedback` log to build a
   small corpus of (prompt, response, human_rating) triples. Even 50-100
   examples would allow calibrating critic scores against human judgment
   (per Causal Judge Evaluation). **Status**: Not started. The structured log
   exists in `graph.py`; what's needed is a collection pipeline and rating UI.

7. **Difficulty-aware rubric scaling** — PARTIALLY IMPLEMENTED. What scales
   with difficulty today:
   - Skeleton visibility: 500 chars/section for difficulty >= 0.6 (vs 200 default)
   - Critic input budget: 8K-24K chars based on difficulty
   - Depth gate thresholds: stricter at >= 0.7 than >= 0.6
   - Thinking budget: 256-2048 tokens scaled by difficulty
   What does NOT yet scale: the number of rubric criteria generated. Hard tasks
   get the same rubric template as medium tasks. Per ResearchRubrics, harder
   tasks should generate more fine-grained evaluation criteria.

8. **Track failure mode prevalence**: Aggregate `insufficient_depth` and
   `evidence_underuse` rates across requests to identify whether the problem
   is in retrieval (not enough evidence) or generation (evidence available but
   not used). **Status**: Partially implemented. `failure_modes_detected` is
   logged per critic invocation. No aggregation pipeline or dashboard yet.

### Phase 3: Long-term (research-backed)

9. **Compact critic model**: Per RAG-Zeval, a smaller model trained on
   structured rules can outperform a large model with open-ended prompts.
   Fine-tune a lightweight judge on our calibration data. Requires Phase 2
   calibration data first.

10. **Failure pattern aggregation dashboard**: Per CLEAR, aggregate critic
    outputs into a dashboard showing system-level failure patterns, most common
    issues, and retrieval quality trends over time. The `request_feedback` and
    `critic_task_faithful_scores` structured logs provide the raw data.

---

## 4. Design Decisions

- **LLM scoring + deterministic overrides**: We use 0-10 scales across 6
  dimensions (the LLM is good at relative ranking) but supplement them with
  binary deterministic checks that override inflated scores: citation rate,
  deliverable coverage precheck, hallucinated URL detection, and the depth
  gate. Research (Latent Judges, GER-Eval) confirms this hybrid approach
  resists score compression better than either method alone.

- **Skeleton for lenient tasks; full visibility for strict**: Lenient tasks
  (difficulty < 0.4) use skeleton extraction to save latency. Strict tasks
  get the full response (input budget scales to 24K chars by difficulty).
  The critic sees enough to detect shallow content on the tasks where depth
  matters.

- **LLM-as-judge over deterministic metrics (BLEU, ROUGE)**: Research
  consensus (ARES, RAG-Zeval) is that LLM-as-judge outperforms token-overlap
  metrics for semantic quality. We use deterministic checks as **supplements**
  (citation rate, URL validation, deliverable coverage) not replacements.

- **No latent signal extraction**: This technique (linear probes on hidden
  layers) produces better-calibrated scores than prompting (Latent Judges),
  but requires model activation access that vLLM's OpenAI-compatible API
  does not expose. Our binary failure mode approach achieves a similar goal
  through a different, production-practical mechanism.

---

## 5. References

| ID | Paper | arXiv | Year |
|----|-------|-------|------|
| 1 | ResearchRubrics: Evaluating Deep Research Agents | 2511.07685 | 2025 |
| 2 | RAG-Zeval: Rule-Guided RAG Evaluation | 2505.22430 | 2025 |
| 3 | ARES: Automated RAG Evaluation System | 2311.09476 | 2023 |
| 4 | GER-Eval: LLM-Designed Evaluation Rubrics | 2602.08672 | 2026 |
| 5 | Latent Judges: Score Compression in LLM-as-Judge | 2509.24678 | 2025 |
| 6 | Causal Judge Evaluation: Calibration | 2512.11150 | 2025 |
| 7 | CLEAR: Actionable Error Analysis | 2507.18392 | 2025 |
