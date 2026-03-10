# Intent Taxonomy — Critic-Aware Routing

> **Status: IMPLEMENTED.** Intent classes use BM25-scored keyword matching (term frequency saturation, document length normalization, IDF weighting). The `intent_weights.yaml` file defines keywords per intent class; the ScoringEngine scores all intents simultaneously and picks the highest (code intents preferred within 10% ties). Code/knowledge disambiguation (`is_code_task`) uses a semantic intent classifier based on cosine similarity against route embeddings (see section 7). See `entry_classifier_engine.py`, `semantic_intent.py`, and `docs/WORKFLOW.md` ref #10.

**Design:** Intent class × Domain vertical → routing + critic behavior.

---

## 1. Primary Intent Classes (10)

| Intent | Routing Hint | Critic Behavior | Rationale |
|--------|--------------|-----------------|-----------|
| **Knowledge & Explanation** | RAG-heavy, clarification if underspecified | Hallucination-sensitive: flag unsourced claims, invented facts | Q&A and explanation need fact-checking |
| **Writing & Content Creation** | Standard Worker path | Tone-based: voice, audience fit, clarity | Content quality ≠ code correctness |
| **Code & Technical Implementation** | Default path | Evidence-gated (sandbox/LSP) | Baseline code critic |
| **Debugging & Error Analysis** | LSP/sandbox evidence first; may short-circuit to LSP | Evidence-heavy: require sandbox/LSP refs for blocking | "Why does it fail?" needs traceability |
| **Review & Validation** | Stricter path; may force Architect | Stricter critic: block on style, security, edge cases | Review = higher bar than "it runs" |
| **Planning & Strategy** | Planner path (plan_required) | Decomposition-focused; step verifiability | Atomic steps, verification_command |
| **Data Transformation & Structuring** | Standard | Schema-enforcing: output shape, type consistency | Parse/convert needs output validation |
| **Tool-Orchestrated / Multi-Step** | Multi-step loop, tool routing | Cross-step consistency, idempotency | Search→summarize, multi-file |
| **Personal Guidance & Optimization** | Lifestyle path, tiered | Safety gating: no medical/legal/financial advice | "Improve my running" ≠ prescribe |
| **Creative Ideation** | Light path | Lightweight: no blocking on style | Brainstorm, ideas — low stakes |

---

## 2. Taxonomy Audit: ≥95% Coverage?

**Verdict: The 10 classes cover ≥95% when combined with Domain.**

| Potential Gap | Verdict | Reason |
|---------------|---------|--------|
| Summarization | Covered by Knowledge | Fact preservation, no invented content → hallucination-sensitive |
| Translation | Covered by Writing | Tone, fluency, audience → tone-based critic |
| Extraction | Covered by Data Transformation | Structure in → structure out → schema-enforcing |
| Classification | Covered by Data Transformation or Review | Output schema or validation |
| Refactoring | Covered by Code or Review | Refactor = code change; often reviewed |

**Refinements (not additions):**

1. **Subtype signals** — e.g. Knowledge can have subtypes: `explanation` vs `factual_qa` (hallucination-sensitive). Both use hallucination-sensitive critic; explanation subtypes get deeper taxonomy steering via `taxonomy_prompt_config.yaml`.
2. **Intent × Domain** — Personal Guidance + healthcare domain → stronger safety gate (no diagnosis).
3. **Routing precedence** — Debugging should prefer LSP-on-failure path; Planning forces Planner.

---

## 3. Critic Behavior Overlays (Intent → Prompt Block)

Each intent appends a **critic_behavior_block** to the system prompt:

```yaml
# intent_prompts.yaml (structure)
intent_classes:
  knowledge:
    critic_behavior_block: |
      HALLUCINATION SENSITIVE: Flag claims not grounded in RAG/source. Block on invented facts.
      Nonblocking: suggest citations for key claims.
  writing:
    critic_behavior_block: |
      TONE/VOICE: Check audience fit, clarity, consistency. No code-style blocking.
  code:
    critic_behavior_block: ""  # default
  debugging:
    critic_behavior_block: |
      EVIDENCE REQUIRED: Blocking issues MUST cite sandbox or LSP evidence. No speculation.
  review:
    critic_behavior_block: |
      STRICT: Block on style violations, security concerns, edge cases. Higher bar than run-only.
  planning:
    critic_behavior_block: |
      DECOMPOSITION: Each step must have verification_command. Flag underspecified steps.
  data_transform:
    critic_behavior_block: |
      SCHEMA: Validate output shape matches stated schema. Flag type mismatches.
  tool_orchestrated:
    critic_behavior_block: |
      IDEMPOTENCY: Multi-step tasks—check step consistency. Flag cross-step drift.
  personal_guidance:
    critic_behavior_block: |
      SAFETY GATE: No medical/legal/financial advice. Flag unsupported recommendations.
  creative_ideation:
    critic_behavior_block: |
      LIGHT: No blocking on style. Approve if output is coherent and on-topic.
```

---

## 4. Routing Implications

| Intent | Routing Change |
|--------|----------------|
| Debugging | Prefer LSP analyzer when sandbox fails (already: lsp_mode=on_failure) |
| Planning | plan_required → Planner (already) |
| Review | Optionally force Architect persona for strict path |
| Tool-Orchestrated | Multi-step loop (existing) |

---

## 5. Integration: Intent × Domain

**Combined critic prompt:**

```
[Base: Gentle or Full JCS]
+ [Domain: safety_ii / tiered block if medical, fintech, etc.]
+ [Intent: critic_behavior_block from intent_class]
```

Example: **Knowledge + medical** → hallucination-sensitive + HIPAA (no PHI in explanations).

---

## 6. Intent Classification — BM25 Scoring

Intent classification is defined in `intent_weights.yaml` under the `intent_classes` key. Each intent class has a `keywords` list. The ScoringEngine scores the user prompt against every intent class using an adapted BM25 algorithm:

- **TF Saturation** (k1=1.5): Repeated keyword matches have diminishing returns.
- **Document Length Normalization** (b=0.75): Long prompts don't accumulate inflated scores.
- **IDF Weighting**: Keywords unique to fewer intent classes are more discriminating.

The highest-scoring intent wins. When a code intent scores within 10% of the best non-code intent, the code intent is preferred (preserving code-priority for ambiguous prompts). Default when nothing matches: `general` (text/document path).

See `entry_classifier_engine.py` for the implementation and `docs/WORKFLOW.md` ref #10 for the research references.

---

## 7. Semantic Intent Classifier — Code vs Knowledge

After BM25 intent classification determines the `intent_class`, the `is_code_task` flag is determined by a **semantic intent classifier** (`semantic_intent.py`). This replaces the former regex-based `code_rescue` pattern that was brittle for ambiguous prompts (e.g., "architecture supporting Python workflows" was incorrectly classified as code because bare language names triggered the regex).

### How It Works

The classifier uses pre-computed mean embeddings for two route categories:

- **CODE_OUTPUT_UTTERANCES**: 15 example phrases that request code output ("Write a Python function...", "Create a React component...", "Show me a code snippet...")
- **KNOWLEDGE_DISCUSSION_UTTERANCES**: 15 example phrases that request knowledge discussion ("Propose an architecture...", "Explain how Kubernetes scheduling works...", "Compare microservices vs monolith...")

At classification time:
1. The user query is embedded using the shared `all-MiniLM-L6-v2` encoder (~5ms, no HTTP calls)
2. Cosine similarity is computed against both route mean embeddings
3. The margin (`code_sim - knowledge_sim`) determines `is_code_task`
4. A configurable threshold (default 0.05, set in `intent_weights.yaml` under `semantic_classifier.confidence_threshold`) controls sensitivity

### Safety Nets

- **`inherently_document`**: Intent classes marked with `inherently_document: true` always classify as knowledge, regardless of semantic score
- **Graceful fallback**: If the encoder fails to load, returns `(False, 0.0)` — safe fallback to knowledge/markdown path

### Research Basis

| Paper | Key Contribution | How We Apply It |
|---|---|---|
| Semantic Router (Aurelio Labs) | Cosine similarity over route embeddings for fast, training-free intent classification | Core architecture: route utterances + mean embeddings + cosine margin |
| VecStat/NormStat (ICLR 2026) | Training-free embedding methods are more robust to ambiguous and OOD prompts than keyword classifiers | Validates that embedding-based classification outperforms the regex approach |
| Routesplain ([arxiv 2511.09373](https://arxiv.org/abs/2511.09373)) | Interpretable concept-based routing for software tasks outperforms black-box and keyword baselines | Informs the utterance design — concepts like "propose architecture" vs "write function" |
