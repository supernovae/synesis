# Model Exercise: Observed Limitations by Role

> **Living document.** Updated as we exercise the system with benchmark prompts and track external critic scores.

**Related:** [LORA_TRAINING_GUIDE.md](LORA_TRAINING_GUIDE.md), [WORKFLOW.md](WORKFLOW.md), [models.yaml](../models.yaml), [VLLM_RECIPES.md](VLLM_RECIPES.md)

---

## Benchmark Methodology

We use a complex multi-constraint architecture prompt as the primary benchmark. An external critic (GPT-4-class model) scores responses on: structure, specificity, tradeoff quality, hallucination/uncertainty handling, practical realism, and systems judgment.

| Date | Deployed config | External critic score | Key changes |
|------|----------------|----------------------|-------------|
| 2026-03-06 | Pre-BM25, code path, no deep-dive steering | 4/10 | Baseline. Classified as code task; produced JSON patch ops. |
| 2026-03-07a | Pre-BM25, code path, domain disambiguation | 5.5/10 | Better structure but still generic; model listed alternatives without choosing. |
| 2026-03-07b | BM25 classification + deep-dive prompt strengthening + format constraints pipeline | 4.5/10 | Correct classification (knowledge path), but brevity-encouraging pinned context caused regression from 5.5. |
| 2026-03-07c | Knowledge path depth fix: depth-encouraging pinned context, prescriptive planner, per-section depth rules, temp 0.3, improved web search queries, curated RAG docs | 6.5-7/10 | Major jump. Better role separation, hybrid control patterns, more buildable. Still lacks epistemic structure, decision policy, and concrete failure modes. |
| 2026-03-07d | Depth mode (parallel per-section generation), provenance/authority RAG, web search trust classification | 6.5-7/10 | Depth mode likely did NOT activate for benchmark — software_architecture domain detection required 2 keyword hits but prompt only matched 1 ("architecture"). Output was still monolithic. |
| 2026-03-07e | Fix domain keywords, epistemic enforcement in taxonomy/worker/critic, anti-boilerplate steering | ~7/10 (structure 8, specificity 7, prompt compliance 5) | Depth mode activated (process diagrams visible). Private/public split, deterministic tooling, practical roadmap. Still missing epistemic structure, decision policy, concrete failure modes, retrieval realism. |
| 2026-03-07f | Planner guarantees dedicated steps for decision policy/epistemic/failure modes; section-type-specific rules in section_worker; writer preserves epistemic labels; token budget increase (section 3072, writer 12288); narrative depth steering | TBD | Addressing prompt compliance gap. |
| 2026-03-07g | **Always-plan architecture**: all non-trivial knowledge tasks flow through planner → section_workers → critic → writer. Continuous difficulty (0-1) scales section count, token budgets, web search budget, critic strictness. CRAG-style corrective retrieval detection. Supervisor removed from knowledge path. | TBD | Major architectural simplification. Depth is a dial, not a gate. |

---

## Knowledge Path Regression Analysis (2026-03-07b → 2026-03-07c)

The BM25 classification fix correctly moved the architecture benchmark prompt from the **code path** to the **knowledge path**. However, score dropped from 5.5 to 4.5 because the knowledge path was optimized for brevity, not depth.

### Root causes identified

1. **Pinned context signaled brevity**: `"Produce formatted text only"` and `"Deliverable: text"` primed the model toward summary mode. The code path's `"Deliverable: code"` accidentally forced more substantial per-file output.
2. **Planner sections were too vague**: `"Section: Design Goals — what to cover"` told the model *what to write about* but not *how deep to go*. The code path's file-based steps (`design_goals.md`) forced the model to treat each as a standalone document.
3. **No per-section depth enforcement**: `_DEEP_DIVE_SUFFIX` said "cover every section" but didn't say "treat each section as a substantial deliverable."
4. **Temperature too high**: 0.4 produced varied but undisciplined output. Reverted to 0.3.
5. **Web search queries unfocused**: Concatenating multiple section titles into one query diluted the search signal.

### Fixes applied (2026-03-07c)

- Pinned context for `plan_required + is_document` changed to depth-encouraging: `"Produce a thorough, detailed analysis"` and `"Deliverable: detailed_analysis"`.
- `KNOWLEDGE_PLANNER_PROMPT` now requires concrete deliverable descriptions per step (not just topic labels).
- `_DEEP_DIVE_SUFFIX` opens with `DEPTH RULES` emphasizing standalone-document-quality sections.
- Temperature set to 0.3 for planned knowledge tasks.
- Web search generates per-section queries instead of concatenated mega-queries.
- 5 curated RAG documents created in `base/rag/knowledge-base/` for model grounding.

---

## Router / Planner (Qwen3-8B FP8)

**Role:** Task routing (supervisor), execution planning (planner), quality review (critic).

### Observed limitations

1. **Deliverable merging.** When a user prompt lists 8 explicit deliverables, the 8B planner merges them into 4-5 generic steps. It fails to preserve 1:1 mapping between user requests and plan steps. This directly causes the worker to skip sections the user asked for.

2. **Format constraint extraction.** The `KNOWLEDGE_PLANNER_PROMPT` instructs the planner to capture user meta-instructions (e.g., "separate facts from assumptions") in the `assumptions` field. The 8B model often ignores this instruction or produces vague paraphrases instead of exact constraint text.

3. **Section title quality.** Plan step `action` fields tend toward generic labels ("Define goals and constraints") rather than preserving the user's specific wording ("State the main design goals"). This degrades the worker's ability to map sections to the user's intent.

4. **Reasoning depth.** The `reasoning` field in planner output is typically a single sentence that restates the task rather than analyzing the decomposition strategy. At 8B scale, the model lacks capacity for meta-reasoning about plan quality.

### Mitigation status

- **Prompt strengthening** (Phase 4): Added explicit "count deliverables, produce 1:1 steps" instruction. Helps but doesn't fully resolve at 8B scale.
- **LoRA candidate:** Planner LoRA is Priority 1 in training guide. Training on (complex prompt → faithful N-step plan with format constraints) pairs would directly address these gaps.

---

## General / Worker (Qwen3-32B FP8)

**Role:** Response generation for both code and knowledge tasks.

### Observed limitations

1. **Menu-style responses.** Instead of committing to concrete technology choices, the model lists "X or Y or Z" alternatives. Example: "Use Elasticsearch or Weaviate" instead of "Use Elasticsearch because your team already runs it and it supports hybrid BM25+vector search." This persists even with explicit "choose one and justify" instructions at temperature 0.2.

2. **Invented metrics.** The model fabricates plausible-sounding numbers rather than admitting uncertainty. Example: "escalate if confidence score < 70%" — the model invented both the metric and the threshold. This is a form of hallucination that's hard to detect because the numbers sound reasonable.

3. **Compliance term priming.** When the system prompt mentions compliance frameworks (FIPS, FedRAMP, HIPAA) even with "only apply when signaled," the model includes them regardless. The user's prompt explicitly said "not in a highly regulated industry" but the response still mentioned FedRAMP. This is a well-documented LLM behavior: mentioning "don't do X" primes the model to do X.

4. **Constraint adherence decay.** The model follows the first 2-3 meta-instructions reliably but drops later ones. When given 5+ simultaneous constraints ("be specific AND constrain to 90 days AND separate facts/assumptions AND don't be generic AND make tradeoffs explicit"), the model typically satisfies only the first 2-3.

5. **Template-shaped prose.** At temperature 0.2, responses fall into repetitive patterns: "Purpose: ...", "Components: ...", "Considerations: ..." for each section. The structure is consistent but the content lacks the depth and specificity of genuine systems thinking.

6. **Scope inflation.** Even when told "useful within 90 days, not a research project," the model proposes sprawling stacks (NiFi, Airflow, multiple DBs, Triton, CDN, serverless) that no small team could deliver in 90 days. It defaults to "mention everything relevant" rather than "cut ruthlessly to fit the constraint."

### Mitigation status

- **Temperature adjusted** (Phase 5 → regression fix): 0.2 → 0.4 → 0.3 for knowledge deep-dives. 0.4 was too aggressive (undisciplined output); 0.3 balances variety with structure.
- **Prompt strengthening** (Phase 3): Added explicit anti-generic, timeline constraining, and uncertainty honesty rules to `_DEEP_DIVE_SUFFIX`.
- **Format constraints pipeline** (Phase 1): Planner-captured format constraints now reach the worker as `## Response Constraints`.
- **Compliance isolation** (Phase 6): Compliance terms removed from base vertical persona; injected only when user prompt contains trigger keywords.
- **Token budget raised** (Phase 7): Floor raised from 2048 to 4096 for planned knowledge tasks to prevent truncation of later sections. Depth mode section budget further raised to 3072 and writer budget to 12288 (2026-03-07f) for narrative depth.
- **Depth mode** (2026-03-07d): Parallel per-section generation activated. Produces better role separation and deterministic tooling mentions, but sections still tend toward bullet-point lists rather than narrative prose.
- **Section-type-specific rules** (2026-03-07f): Section worker now injects domain-specific requirements (failure mode concreteness, decision policy signal decomposition, retrieval design depth, confidence decomposition) based on section topic keywords.
- **Narrative depth steering** (2026-03-07f): Section worker and writer now explicitly require multi-paragraph prose, not bullet-point summaries.
- **LoRA candidate:** Worker LoRA is Priority 2. Training on (architecture prompt + planner outline + constraints → response with concrete choices, fact/assumption/recommendation separation, timeline-scoped recommendations) would address the remaining gaps.

---

## Critic (Qwen3-8B / R1-Distill-32B)

**Role:** Quality review of generated responses.

### Observed limitations

1. **Leniency at low temperature.** At temperature 0.1, the critic rarely blocks. It approves generic responses that technically mention required_elements but lack depth. The "specificity check" instruction exists in the prompt but the model doesn't reliably enforce it.

2. **"X or Y" detection.** The critic prompt says to flag "listing alternatives without choosing one." In practice, the 8B critic doesn't reliably detect this pattern. It tends to approve as long as the response mentions the topic.

3. **Structural compliance verification.** When the user asks to "separate facts from assumptions" and the response doesn't, the critic should flag this. The 8B model struggles to verify structural compliance against the user's explicit requests.

4. **Depth assessment.** The critic checks for required_elements coverage but not depth per element. A one-sentence mention of "Failure Modes" passes even when the user asked for detailed failure mode analysis with mitigations.

### Mitigation status

- **Critic prompt** already includes specificity and structural compliance checks (taxonomy depth review). The issue is model capability at 8B scale.
- **LoRA candidate:** Critic LoRA is Priority 3. Training on (weak response + user constraints → blocking_issues with specific citations) would improve rejection of generic content.

---

## Entry Classifier / Domain Detection (BM25 + Keyword Axes)

**Role:** Classify task complexity, risk, intent, and domain via keyword matching and BM25 scoring.

### Observed limitations

1. **Domain keyword threshold too strict.** `software_architecture` required `min_hits: 2` from a narrow keyword list. The benchmark prompt said "architecture" (1 hit) but used "design" which wasn't in the list. This caused the domain to not activate, bypassing the entire depth mode pipeline, `_DEEP_DIVE_SUFFIX` instructions, and taxonomy-specific persona/instructions.

2. **Single-word keywords vs. multi-word phrases.** Keywords like "system design" (2 words) require exact phrase match. A prompt saying "design a system" would not match "system design". This is a BM25 tokenization limitation.

3. **No semantic fallback.** The entry classifier is purely lexical. A prompt about "building an AI platform" is semantically close to software_architecture but may not hit any domain keywords if the user avoids the exact words in the list.

### Mitigation status

- **Keyword expansion** (Phase 1, 2026-03-07e): Added "design", "propose", "rollout plan", "failure modes", "model strategy", "retrieval", "assistant" to `software_architecture` keywords. Also added pairings for ("architecture" + "design") and ("architecture" + "propose") to boost complexity score.
- **Future fine-tuning notes:** If keyword expansion proves insufficient, consider:
  - Lowering `min_hits` to 1 for high-signal domains (architecture alone is a strong enough signal)
  - Adding a lightweight embedding similarity check as a fallback when keyword matches are 0-1
  - LoRA-trained classifier that maps prompts to domains directly (would replace the keyword axis entirely)

---

## Cross-Cutting Patterns

1. **Instruction following vs. model scale.** Both 8B and 32B models follow simple format instructions well (JSON schema, markdown structure, code blocks). Performance degrades with simultaneous meta-constraints. The 8B model struggles with >2 meta-constraints; the 32B model handles ~3-4 before dropping later ones.

2. **Temperature-specificity tradeoff.** Lower temperature (0.1-0.2) produces consistent structure but generic content. Higher temperature (0.4-0.5) produces more opinionated content but less predictable structure. After regression testing, 0.3 is the current sweet spot for knowledge deep-dives: maintains structural compliance while allowing more decisive language than 0.2.

3. **Negative instruction priming.** "Do not mention X" or "Only include X when Y" reliably primes the model to include X. The only effective mitigation is to remove X from the prompt entirely and inject it dynamically only when needed.

4. **Web search context quality.** The model produces better responses when grounded in real web search results, but search quality depends heavily on query formulation. Raw task text produces poor queries; structured queries from planner sections produce much better results.

5. **FP8 quantization impact.** We have not A/B tested FP8 vs FP16 for instruction following quality. FP8 may contribute to some of the constraint adherence issues, particularly for the 8B model where quantization has proportionally more impact on a smaller parameter space.
