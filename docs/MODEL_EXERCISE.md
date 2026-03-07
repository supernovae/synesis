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
| 2026-03-07b | BM25 classification + deep-dive prompt strengthening + format constraints pipeline | TBD | Phases 1-7 of knowledge quality plan. |

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

- **Temperature raised** (Phase 5): 0.2 → 0.4 for knowledge deep-dives. Encourages more varied phrasing and opinionated responses.
- **Prompt strengthening** (Phase 3): Added explicit anti-generic, timeline constraining, and uncertainty honesty rules to `_DEEP_DIVE_SUFFIX`.
- **Format constraints pipeline** (Phase 1): Planner-captured format constraints now reach the worker as `## Response Constraints`.
- **Compliance isolation** (Phase 6): Compliance terms removed from base vertical persona; injected only when user prompt contains trigger keywords.
- **Token budget raised** (Phase 7): Floor raised from 2048 to 4096 for planned knowledge tasks to prevent truncation of later sections.
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

## Cross-Cutting Patterns

1. **Instruction following vs. model scale.** Both 8B and 32B models follow simple format instructions well (JSON schema, markdown structure, code blocks). Performance degrades with simultaneous meta-constraints. The 8B model struggles with >2 meta-constraints; the 32B model handles ~3-4 before dropping later ones.

2. **Temperature-specificity tradeoff.** Lower temperature (0.1-0.2) produces consistent structure but generic content. Higher temperature (0.4-0.5) produces more opinionated content but less predictable structure. The sweet spot for knowledge deep-dives appears to be 0.3-0.4.

3. **Negative instruction priming.** "Do not mention X" or "Only include X when Y" reliably primes the model to include X. The only effective mitigation is to remove X from the prompt entirely and inject it dynamically only when needed.

4. **Web search context quality.** The model produces better responses when grounded in real web search results, but search quality depends heavily on query formulation. Raw task text produces poor queries; structured queries from planner sections produce much better results.

5. **FP8 quantization impact.** We have not A/B tested FP8 vs FP16 for instruction following quality. FP8 may contribute to some of the constraint adherence issues, particularly for the 8B model where quantization has proportionally more impact on a smaller parameter space.
