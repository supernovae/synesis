# Intent anchors (superseded) — ambiguity today

> **This file used to describe a separate “two-tier intent anchor” subsystem** (`SYNESIS_ANCHOR_*`, `intent_anchors` state, Tier 1/Tier 2 resolution). **That design is not in the planner anymore.**  
> **Do not use this page for env vars or state fields** — they do not exist in current code.

## Where ambiguity is handled now

Synesis resolves “what kind of task is this?” **through frame extraction and sensemaking**, not through a standalone anchor resolver:

1. **Frame extraction** (`frame_extractor` → `frame_normalizer.py`) builds a structured view of the prompt (technologies, deliverables, constraints, domain hints).
2. **Domain profile** (`_build_domain_profile()` → `DomainProfile` in `schemas.py`) treats the prompt as a **weighted mixture of domains** (topic-mixture model), not a single forced label.
3. **Frame coherence** is classified as:
   - **Focused** — one domain clearly dominates; safe to bias retrieval and optionally **pre-seed a soft cohesion lock** from YAML conflict groups (`cohesion_groups.yaml` / `get_conflict_groups()` in `cohesion.py`).
   - **Composite** — multiple domains matter; retrieval **diversifies** across hints; **no** hard “pick AWS vs GCP” lock.
   - **Diffuse** — frame is unclear (**Cynefin complex**); the pipeline should **probe the user** with a guided clarification (see planner Phase 2a) instead of assuming stack/vendor choices.

4. **Topic frame** (`_build_topic_frame()`) guides **what** to search for (deliverables / intent), while technologies **constrain the answer**, not the search entity — see sensemaking doc.

5. **Feedback / clarification** — When the frame is diffuse or gates fire, the system **asks** using partial understanding (joint cognitive system pattern), rather than silently picking defaults for ambiguous multi-vendor questions.

## Canonical documentation (read these)

| Topic | Document |
|-------|----------|
| Research ↔ code mapping (Klein, Cynefin, JCS, LDA, …) | [SENSEMAKING_REFERENCES.md](SENSEMAKING_REFERENCES.md) |
| Design narrative (complexity, sensemaking, Safety-II) | [DESIGN_THEORY.md](DESIGN_THEORY.md) |
| End-to-end pipeline, cohesion lock, query normalization | [WORKFLOW.md](WORKFLOW.md) |

## Cohesion lock (current behavior, short)

- For **focused** frames, the **router** may attach a **`_preseeded_lock`** derived from the dominant domain and **conflict groups** (`router.py` — domain-profile-aware preseeding). That filters retrieved docs **before** summarization in consolidated retrieve paths.
- If there is **no** preseeded lock, cohesion behavior continues **after** retrieval as documented in **WORKFLOW.md** (post-retrieval lock / filtering).
- **Composite** and **diffuse** frames intentionally avoid that early lock so the system does not assume a single vendor or stack.

## Historical note

The old “intent anchors” doc listed papers and `SYNESIS_ANCHOR_STRATEGY` as if they were live configuration. The **ideas** (resolve ambiguity early, avoid mixed-evidence thrash, ask when truly conflicted) are preserved in the **sensemaking** design; the **implementation** is **domain profile + diffuse probe + focused preseed**, not a separate anchor node.
