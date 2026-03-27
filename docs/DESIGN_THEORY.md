# Design Theory: Complexity, Sensemaking, and Joint Cognitive Systems

This document captures the theoretical framing behind Synesis design choices: how we handle different kinds of problem complexity, when we clarify instead of guess, and how the system stays a **joint cognitive system** (human + AI) rather than a black box. It supports consistent quality across complex domains (architecture, scientific rigor, strategy) without tailoring to a single prompt type.

## Cynefin and problem domains

We treat incoming requests as falling into different **problem domains** (ordered vs unordered). Design choices map to Cynefin-style sense-making:

| Domain | Cause–effect | Synesis behavior |
|--------|--------------|------------------|
| **Clear** | Obvious, repeatable | Low difficulty → bypass planner, direct writer fast-path. No planner, minimal critic. |
| **Complicated** | Knowable with analysis | Plan required → Planner + evidence + full Critic. Sense → analyze → respond. |
| **Complex** | Only visible in retrospect | Retrieval + critic→router loops; low confidence → refine. Probe → sense → respond. |
| **Chaotic** | No stable pattern yet | High ambiguity → **clarify first** (ask the user); do not run full writer/critic until the frame is stable. Act to stabilize (one clarifying question), then sense. |

**Important:** For chaotic prompts we do **not** trigger a full answer-and-critique cycle. We return a clarification question (see Clarify-first below). That reduces cost and oscillation: we avoid assuming or guessing when the request is ambiguous, and we avoid repeated RETRY loops that would otherwise fire when the critic rejects an answer built on wrong assumptions.

**Implementation:** The entry classifier (`base/planner-ts/src/nodes/entry-classifier.ts`) derives a `cynefin_domain` label (clear / complicated / complex / chaotic) from difficulty, frame coherence, and taxonomy complexity via `classifyCynefin()`. This label flows into the trace `classification` for admin observability, and drives routing decisions:

- **Clear** → `task_is_trivial` or low difficulty → writer fast-path, background critic
- **Complicated** → `plan_required`, planner + plan gate + evidence + inline critic
- **Complex** → high difficulty or composite frame → full pipeline with retrieval, critic→router loops when `need_more_evidence`
- **Chaotic** → diffuse frame + high difficulty → `shouldClarify()` fires, pipeline stops at clarification

The domain profile (`base/planner-ts/src/nodes/domain-profile.ts`) produces `frameCoherence` (focused / composite / diffuse) using keyword-domain weights and coherence scoring — directly aligned with Cynefin's ordered vs unordered distinction.

## Clarify-first and ambiguous prompts

When the planner detects material ambiguities (from the frame extractor) and the taxonomy or request sets **clarify_first**, the pipeline returns a short clarification message and stops. The user can answer the questions or say "proceed" and we continue with stated assumptions.

- **Where:** `base/planner-ts/src/nodes/llm-planner.ts` — `shouldClarify()` checks `clarify_first`, frame coherence, confidence, and open question count. When true, returns clarification payload and routes to `respond` without running Writer/Critic.
- **Why:** Ambiguous prompts are treated as **chaotic** in the Cynefin sense. Answering with a long, confident response would likely be wrong or generic; the critic would reject it, and we would retry — wasting tokens and creating oscillation. Clarifying first stabilizes the frame and avoids that loop.
- **Cost/latency:** One planner call and one short response. No writer, no critic, no retrieval churn. This is cheaper and faster than multiple retry cycles.
- **Pipeline enforcement:** `base/planner-ts/src/pipeline.ts` — when the LLM planner sets `next_node: "respond"` with a `clarification_question`, the plan gate skips validation, and the graph exits directly to respond.

So: **better handling of ambiguous prompts reduces cost and oscillation** by not guessing when we lack a clear frame.

## Sensemaking and joint cognitive systems

Synesis is designed as a **joint cognitive system**: the human and the AI share the work. Quality and safety emerge from the interaction, not from the model alone.

- **Evidence-governed answers** — The router provides evidence packets; the writer renders them as grounding context (`base/planner-ts/src/nodes/writer-compose.ts`); the critic scores both `grounding` and `evidence_utilization` (`base/planner-ts/src/nodes/critic-evaluator.ts`). The human sees citations and can judge grounding.
- **Explicit epistemic discipline** — For complex tasks, the writer is instructed to label uncertainty with `[Assumption: …]`, `[Estimate: …]`, `[Target: …]`, and `[Measured: …]` tags (`base/planner-ts/src/nodes/writer-compose.ts`, `buildAssumptionInstructions`). The critic checks for missing labels when `show_assumptions` is active, including detection of false-certainty language and unlabeled numeric claims.
- **Escalation and refusal** — Authorization policy (`base/planner-ts/src/auth/policy-engine.ts`) enforces access control refusal. The critic detects when a draft describes a routing/escalation system but omits refusal/out-of-scope handling (`missing_escalation_refusal_policy`). The critic routing (`base/planner-ts/src/nodes/critic-routing.ts`) supports `blocked_external` and `needs_input` terminal conditions. The deterministic critic sets `need_more_evidence` when blocking issues exist but retrievable evidence is expected.
- **Clarify-first** — When the situation is chaotic, we ask instead of answering. The human supplies the missing structure; we don't fabricate it.

Research on sensemaking with LLMs (e.g. *What to Make Sense of in the Era of LLM?* [arXiv:2603.08604]) emphasizes **human–AI collaboration** and complementary roles rather than full automation. Our design aligns with that: the system supports sensemaking by constraining when we answer, how we label uncertainty, and when we hand back to the user.

## Generalization across complex domains

Quality improvements (epistemic discipline, routing clarity, confidence-engine type, retrieval description, numeric labeling) are **condition-based**, not tied to a single prompt type:

- **Epistemic discipline** — Applied whenever the taxonomy or request sets `show_assumptions` and difficulty is high (`entry-classifier.ts` activates at `difficulty >= 0.55` or when taxonomy complexity score >= 0.55). Any vertical (scientific, legal, architecture, strategy) that enables this gets the same bar.
- **Routing / escalation / refusal** — The critic checks for missing escalation/refusal policy when the **content** of the answer describes a router, escalation logic, or confidence gate. Scientific or creative answers that don't describe such systems are unaffected.
- **Retrieval (metadata, permissions, hybrid)** — RAG mode (`disabled`, `light`, `normal`) is driven by difficulty and taxonomy, not by vertical. Verticals that often describe RAG (e.g. `software_architecture`) naturally get `normal` mode through higher complexity scores.
- **Numeric labeling** — `[Target: …]`, `[Estimate: …]`, `[Measured: …]` can be used in any domain that makes quantitative claims; the critic flags unlabeled numeric claims when `show_assumptions` is active. Taxonomy can opt in per vertical via `output_controls`.
- **Cynefin domain** — Explicitly classified on every request (`cynefin_domain` in state and trace), enabling consistent domain-appropriate behavior regardless of vertical.

This keeps the system useful across **broad complex/complicated domains** (architecture, scientific rigor, strategy) without over-fitting to one kind of prompt.

## Key implementation files

| Concern | File | Function / area |
|---------|------|----------------|
| Cynefin classification | `base/planner-ts/src/nodes/entry-classifier.ts` | `classifyCynefin()`, `classifyEntry()` |
| Domain profiling | `base/planner-ts/src/nodes/domain-profile.ts` | `buildDomainProfile()` |
| Clarify-first | `base/planner-ts/src/nodes/llm-planner.ts` | `shouldClarify()` |
| Evidence in writer | `base/planner-ts/src/nodes/writer-compose.ts` | `renderEvidenceContext()`, `buildAssumptionInstructions()` |
| Critic scoring | `base/planner-ts/src/nodes/critic-evaluator.ts` | `scoreDraft()`, `checkAssumptionLabels()`, `deterministicCritic()` |
| Critic routing | `base/planner-ts/src/nodes/critic-routing.ts` | `routeAfterCritic()` |
| Oscillation detection | `base/planner-ts/src/nodes/oscillation-detector.ts` | `detectOscillation()` |
| Auth policy | `base/planner-ts/src/auth/policy-engine.ts` | `DeterministicPolicyEngine` |
| Span tracing | `base/planner-ts/src/tracing/span-collector.ts` | `SpanCollector` |
| Pipeline orchestration | `base/planner-ts/src/pipeline.ts` | `runCanonicalPipeline()` |

## References

- Cynefin framework: sense-making over categorization; ordered (Clear, Complicated) vs unordered (Complex, Chaotic) domains.
- *What to Make Sense of in the Era of LLM? A Perspective from the Structure and Efforts in Sensemaking* — arXiv:2603.08604 (human–AI collaborative sensemaking).
- Data-Frame theory (Klein et al.): sensemaking as fitting data into frames and frames around data — used in domain profiling and frame coherence classification.
- Hollnagel (Synesis namesake): productivity, quality, safety, and reliability as emergent from the same adaptive processes — aligned with shared infrastructure (taxonomy, critic, retrieval) that surrounds every agent.
