# Prompt epistemology and taxonomy layering

This document records **design decisions** for how Synesis composes LLM prompts across nodes: what is universal, what is taxonomy-steered, how regulated domains are handled, and how the critic relates to taxonomy. It complements [WORKFLOW_PLANNER.MD](../WORKFLOW_PLANNER.MD) (graph flow) and [performance.md](performance.md) (prefix caching).

## Goals

- **Less tailorism:** Universal writer/critic/compiler text should not encode specific products, eval prompts, or assistant-shaped checklists.
- **More epistemics:** Stable rules about calibration, scope, evidence vs inference, and honest limits—across arbitrary user prompts.
- **Taxonomy owns domain shape:** Framing, depth, and **industry-specific strictness** (medical, legal, fintech, etc.) apply only when the system resolves a matching taxonomy / vertical / intent—not when the user *claims* a domain in chat.
- **Trust and joint cognition:** Injection resistance, authority tiers, and appropriate reliance stay in the universal layer; they are not weakened by moving detail into taxonomy.

## Three layers (L0 / L1 / L2)

| Layer | Role | Source of truth | User can override? |
|-------|------|-----------------|-------------------|
| **L0** | Universal trust + epistemic + non-bypassable safety floors | Code constants (planner/writer/critic shared) | **No** — not via prompt; not via taxonomy YAML alone |
| **L1** | Node contract: JSON schemas, rubric shape, router retrieval mechanics | Node modules (`planner_node`, `critic`, `router`, …) | **No** |
| **L2** | Domain depth, output style, regulated overlays, query hints | `taxonomy_prompt_config.yaml`, DB `taxonomy_domains`, vertical plugins, `intent_prompts.yaml` | **Admin / deploy-time only** — end users cannot inject L2 |

**Composition order** inside a single LLM call (e.g. critic):

1. **L0** static prefix (maximize KV cache hit rate).
2. **L1** role instructions (critic JSON contract, dimensions).
3. **L2** appended suffix: taxonomy `depth_instructions`, `output_style_guidance`, `epistemic_guidance`, **regulated overlays**, intent critic blocks, frame rubric, etc.

Taxonomy **extends** the critic; it does **not** sit “above” L0. Nothing in L2 may instruct the model to ignore L0.

## How taxonomy is chosen (escape prevention)

`taxonomy_metadata` (and `taxonomy_key`) come from the **entry classifier** plus [`resolve_taxonomy_metadata`](../base/planner/app/taxonomy_prompt_factory.py) — deterministic from signals derived from the user message and config, **not** from free-text instructions inside the user message that claim “you are now in medical mode.”

That means:

- A user **cannot opt out** of a regulated overlay by saying “ignore taxonomy” if the classifier still assigns a regulated taxonomy key.
- A user **cannot opt in** to weaker rules for a regulated topic solely by asking; assignment is system-side.

**Prompt injection** is still handled by the existing trust policy (untrusted RAG context must not override system behavior).

## Regulated and high-stakes domains (e.g. medical, legal)

**Design decision:** Move **detailed** checklist-style requirements (disclaimers, scope limits, “when to refuse,” citation expectations) from universal critic/writer text into **L2** for the relevant taxonomy nodes or vertical plugins.

**Non-bypassable L0 floor (keep thin):** A small set of rules that always apply regardless of taxonomy, for example:

- Do not provide **personalized** medical diagnosis, treatment, or dosing; encourage professional care.
- Do not provide **personalized** legal advice; describe general information only.
- Do not assist with illegal or high-harm requests.

These are **principles**, not industry playbooks. The playbooks live in L2.

## Recommended taxonomy fields (implementation backlog)

The following optional keys are **recommended** for `taxonomy_prompt_config.yaml` / `taxonomy_domains.raw_config` (exact names can be finalized in code when wired through `taxonomy_prompt_factory`):

| Field | Purpose |
|-------|---------|
| `epistemic_guidance` | How to express uncertainty, evidence strength, and limits for this discipline. |
| `regulated_domain` | Boolean (or enum) flag: when true, inject stricter L2 blocks. |
| `writer_regulated_block` | Extra writer instructions (disclaimers, tone, scope). |
| `critic_regulated_block` | Extra critic checks (e.g. inappropriate certainty, missing disclaimers). |
| `router_summarizer_tone` | One-line epistemic tone for evidence summarization (e.g. scientific vs policy). |

Smaller deployments can start with a single `regulated_compliance_block` string split between writer and critic in code until separate fields are needed.

Vertical plugins already support `critic_mode`, `critic_tiers`, and `worker_persona_block`; regulated overlays should align with those patterns so **new industries** can be added by taxonomy/DB edits without changing Python for each vertical.

## Router and evidence packets

The router should summarize retrieval in a way that makes **epistemic limits** visible (what was found, what was not, confidence)—see plan: “router epistemic signal.” That reduces pressure to compensate with bloated universal critic text.

## Caching

L0 should be the **largest** shared prefix per model endpoint. L2 varies per request; keep it **last** in the system message. See [performance.md](performance.md) “Prefix-Aware Prompt Structure.”

## Related documents

- [WORKFLOW_PLANNER.MD](../WORKFLOW_PLANNER.MD) — graph nodes and routing; links here for prompt layering.
- [.cursor/rules/planner-prompt-hygiene.mdc](../.cursor/rules/planner-prompt-hygiene.mdc) — what not to encode in generic planner nodes.
- [.cursor/rules/prefix-cache-prompt-ordering.mdc](../.cursor/rules/prefix-cache-prompt-ordering.mdc) — static-before-dynamic ordering.

## External audit references (rubrics, not copy-paste prompts)

- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- RAG evaluation tooling (e.g. RAGAS) for **measurement**, not prompt bloat
- Principle-based safety framing (e.g. constitutional-style **principles** as inspiration for L0 length discipline)
- Joint cognitive systems / appropriate reliance (Hollnagel, Woods) — align language with human–AI handoff

---

*This file should be updated when L0/L2 boundaries or taxonomy schema fields change.*
