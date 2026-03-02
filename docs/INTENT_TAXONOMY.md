# Intent Taxonomy — Critic-Aware Routing

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

1. **Subtype signals** — e.g. Knowledge can have subtypes: `explanation` (teach mode) vs `factual_qa` (hallucination). Both use hallucination-sensitive critic; teach adds learners_corner.
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

## 6. Intent Classification Keywords

Add to `intent_weights.yaml` or new `intent_classes.yaml`:

```yaml
# Maps keywords → intent_class (RAG-style, no score)
intent_classes:
  knowledge:
    keywords: [explain, what is, how does, why does, define, describe, tell me about]
  writing:
    keywords: [write, draft, compose, email, blog, article, content]
  code:
    keywords: [implement, create, build, script, function, class]  # default fallback
  debugging:
    keywords: [fix, debug, error, trace, why does it fail, stack trace]
  review:
    keywords: [review, validate, audit, check, assess]
  planning:
    keywords: [plan, strategy, design, architecture, break down]
  data_transform:
    keywords: [parse, convert, transform, extract, schema, json, csv]
  tool_orchestrated:
    keywords: [search and, fetch and, multi-step]
  personal_guidance:
    keywords: [how can i, improve my, optimize my, help me with]
  creative_ideation:
    keywords: [brainstorm, ideas for, suggest, creative]
```

First match wins. Default: `code`.
