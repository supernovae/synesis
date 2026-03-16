# Design Theory: Complexity, Sensemaking, and Joint Cognitive Systems

This document captures the theoretical framing behind Synesis design choices: how we handle different kinds of problem complexity, when we clarify instead of guess, and how the system stays a **joint cognitive system** (human + AI) rather than a black box. It supports consistent quality across complex domains (architecture, scientific rigor, strategy) without tailoring to a single prompt type.

## Cynefin and problem domains

We treat incoming requests as falling into different **problem domains** (ordered vs unordered). Design choices map to Cynefin-style sense-making:

| Domain | Cause–effect | Synesis behavior |
|--------|--------------|------------------|
| **Clear** | Obvious, repeatable | Low difficulty → bypass supervisor, direct answer. No planner, minimal critic. |
| **Complicated** | Knowable with analysis | Plan required → Planner + evidence + full Critic. Sense → analyze → respond. |
| **Complex** | Only visible in retrospect | Retrieval + CRAG; low confidence → escalate or refine. Probe → sense → respond. |
| **Chaotic** | No stable pattern yet | High ambiguity → **clarify first** (ask the user); do not run full writer/critic until the frame is stable. Act to stabilize (one clarifying question), then sense. |

**Important:** For chaotic prompts we do **not** trigger a full answer-and-critique cycle. We return a clarification question (see Clarify-first below). That reduces cost and oscillation: we avoid assuming or guessing when the request is ambiguous, and we avoid repeated RETRY loops that would otherwise fire when the critic rejects an answer built on wrong assumptions.

## Clarify-first and ambiguous prompts

When the planner detects material ambiguities (from the frame extractor) and the taxonomy or request sets **clarify_first**, the pipeline returns a short clarification message and stops. The user can answer the questions or say "proceed" and we continue with stated assumptions.

- **Where:** `base/planner/app/nodes/planner_node.py` — when `clarify_first` is true, `ambiguities` + `open_questions` meet a minimum count, and difficulty is above a trivial threshold, we set `clarify_question` and route to respond without running Writer/Critic.
- **Why:** Ambiguous prompts are treated as **chaotic** in the Cynefin sense. Answering with a long, confident response would likely be wrong or generic; the critic would reject it, and we would retry — wasting tokens and creating oscillation. Clarifying first stabilizes the frame and avoids that loop.
- **Cost/latency:** One planner call and one short response. No writer, no critic, no retrieval churn. This is cheaper and faster than multiple retry cycles.

So: **better handling of ambiguous prompts reduces cost and oscillation** by not guessing when we lack a clear frame.

## Sensemaking and joint cognitive systems

Synesis is designed as a **joint cognitive system**: the human and the AI share the work. Quality and safety emerge from the interaction, not from the model alone.

- **Evidence-governed answers** — RAG and web search provide evidence packets; the writer is instructed to use them; the critic scores `evidence_utilization`. The human sees citations and can judge grounding.
- **Explicit epistemic discipline** — For complex tasks we require separation of facts, assumptions, and recommendations, and labels like [Assumption], [Estimate], [Target]. That makes the human’s job easier: they see what is established vs what is inferred.
- **Escalation and refusal** — When we describe systems that route, escalate, or refuse (e.g. in architecture answers), we require the *answer* to state when to answer vs escalate vs refuse and how out-of-scope requests are handled. That keeps the human–AI boundary visible in the design.
- **Clarify-first** — When the situation is chaotic, we ask instead of answering. The human supplies the missing structure; we don’t fabricate it.

Research on sensemaking with LLMs (e.g. *What to Make Sense of in the Era of LLM?* [arXiv:2603.08604]) emphasizes **human–AI collaboration** and complementary roles rather than full automation. Our design aligns with that: the system supports sensemaking by constraining when we answer, how we label uncertainty, and when we hand back to the user.

## Generalization across complex domains

Quality improvements (epistemic discipline, routing clarity, confidence-engine type, retrieval description, numeric labeling) are **condition-based**, not tied to a single prompt type:

- **Epistemic discipline** — Applied whenever the taxonomy or request sets `show_assumptions` and difficulty is high. Any vertical (scientific, legal, architecture, strategy) that enables this gets the same bar.
- **Routing / escalation / refusal** — Only required when the **content** of the answer describes a router, escalation logic, or confidence gate. Scientific or creative answers that don’t describe such systems are unaffected.
- **Retrieval (metadata, permissions, hybrid)** — Only added to depth instructions for verticals that often describe RAG (e.g. software_architecture). Other domains are unchanged.
- **Numeric labeling** — [Target], [Estimate], [Measured] can be used in any domain that makes quantitative claims; taxonomy can opt in per vertical.

This keeps the system useful across **broad complex/complicated domains** (architecture, scientific rigor, strategy) without over-fitting to one kind of prompt.

## References

- Cynefin framework: sense-making over categorization; ordered (Clear, Complicated) vs unordered (Complex, Chaotic) domains.
- *What to Make Sense of in the Era of LLM? A Perspective from the Structure and Efforts in Sensemaking* — arXiv:2603.08604 (human–AI collaborative sensemaking).
- Hollnagel (Synesis namesake): productivity, quality, safety, and reliability as emergent from the same adaptive processes — aligned with shared infrastructure (taxonomy, critic, retrieval) that surrounds every agent.
