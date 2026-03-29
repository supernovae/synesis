# Sensemaking, Cynefin, and Joint Cognitive Systems in Synesis

Synesis is designed as a **joint cognitive system** (JCS) where the AI and the human collaborate to produce high-quality output. The system's domain profiling, frame extraction, and retrieval architecture are grounded in established sensemaking research rather than ad-hoc heuristics.

This document tracks the research foundations that inform Synesis design decisions.

## Core References

### Sensemaking

**Klein, G., Moon, B., & Hoffman, R.R. (2007).** "Making Sense of Sensemaking 2: A Macrocognitive Model." *IEEE Intelligent Systems*, 21(5), 88-92.

- **Applied in:** Frame extraction and domain profiling (`domain-profile.ts`, `frame-extractor.ts` in planner-ts; `frame_normalizer.py` in planner)
- **Key insight:** Sensemaking is about fitting data into frames and frames around data iteratively. Build a holistic understanding of the prompt before acting, rather than locking on the first keyword signal.
- **Design impact:** `buildDomainProfile()` builds a weighted DomainProfile from the full extracted frame (technologies, deliverables, constraints, domain hints) before any retrieval happens. This replaces the old intent-anchor system that locked on the first keyword match.

**Pirolli, P. & Card, S. (1999).** "Information Foraging." *Psychological Review*, 106(4), 643-675.

- **Applied in:** Router evidence gathering, topic frame construction (`router.ts`, `frame-extractor.ts` in planner-ts; `router.py`, `frame_normalizer.py` in planner)
- **Key insight:** Information foraging theory describes how people (and systems) should build a holistic frame of the problem and then use that frame to guide evidence gathering — not the other way around.
- **Design impact:** The TopicFrame (conceptual search entity) is built from deliverables and domain tags, deliberately excluding technologies. Technologies constrain the output, not the search. Evidence retrieval is guided by what the user wants, not by what tools they mentioned.

### Cynefin Framework

**Snowden, D.J. & Boone, M.E. (2007).** "A Leader's Framework for Decision Making." *Harvard Business Review*, 85(11), 68-76.

- **Applied in:** Frame coherence classification, clarification triggers, Cynefin domain mapping (`entry-classifier.ts`, `domain-profile.ts`, `llm-planner.ts` in planner-ts; `frame_normalizer.py`, `planner_node.py` in planner)
- **Key insight:** Different problem domains require different response strategies: obvious (sense-categorize-respond), complicated (sense-analyze-respond), complex (probe-sense-respond), chaotic (act-sense-respond).
- **Design impact:** `buildDomainProfile()` classifies frame coherence into three states, and `classifyCynefin()` maps difficulty + coherence to a formal Cynefin domain (clear / complicated / complex / chaotic):
  - **Focused** (clear/complicated): One dominant domain. Safe to apply soft cohesion constraints. Existing behavior preserved.
  - **Composite** (complicated, multi-expert): Multiple clear domains. Address all proportionally. No hard exclusion. Cross-domain connections are valuable.
  - **Diffuse** (complex/chaotic): No clear frame. Trigger a Cynefin probe — ask the user a guided clarification question before retrieving blindly. This prevents wasted compute and off-target responses.

### Topic Modeling and Multi-Label Classification

**Blei, D.M., Ng, A.Y., & Jordan, M.I. (2003).** "Latent Dirichlet Allocation." *Journal of Machine Learning Research*, 3, 993-1022.

- **Applied in:** DomainProfile weighted domain vector (`domain-profile.ts` in planner-ts; `schemas.py` in planner)
- **Key insight:** Documents (and prompts) are not single-topic. They are mixtures of topics with different weights.
- **Design impact:** DomainProfile models each prompt as a weighted vector of domains (e.g., `{software_architecture: 0.8, llm_rag: 0.7, kubernetes: 0.3}`), not a single-label classification. The scoring engine's `domain_ref_counts` and pairing rules reinforce this: keyword co-occurrence across domains adds weight to multiple active domains simultaneously, supporting multidimensional classification. This prevents the system from forcing a multi-domain architecture prompt into a single "kubernetes" category.

### Query Diversification

**Agrawal, R., Gollapudi, S., Halverson, A., & Ieong, S. (2009).** "Diversifying Search Results." *Proceedings of WSDM 2009*, 5-14.

- **Applied in:** Multi-domain retrieval, composite frame evidence gathering (`router.ts` in planner-ts; `router.py` in planner)
- **Key insight:** When a query spans multiple aspects, retrieval should diversify results to cover all aspects rather than collapsing to one.
- **Design impact:** For composite frames, the router returns ALL weighted domains as retrieval hints, ensuring evidence is gathered from all relevant domains. The summarizer receives multi-domain context instead of hard exclusion constraints.

### Query Intent Understanding

**Broder, A. (2002).** "A Taxonomy of Web Search." *ACM SIGIR Forum*, 36(2), 3-10.

- **Applied in:** Entry classifier intent classification (`entry-classifier.ts`, `scoring-engine.ts` in planner-ts; `entry_classifier_engine.py` in planner)
- **Key insight:** Query intent (informational, navigational, transactional) should drive retrieval strategy, not keyword matching alone.
- **Design impact:** The entry classifier determines `intent_class` (planning, coding, information_request, etc.) before domain detection. Intent drives pipeline behavior; domains provide context. In planner-ts, the scoring engine loads intent classes, domain keywords, and pairing rules from the merged ontology snapshot (`intent_weights.yaml` + `plugins/weights/*.yaml`), and an optional embedding-based semantic cross-check validates or overrides the keyword-selected taxonomy key.

### Joint Cognitive Systems and Safety-II

**Hollnagel, E. (2014).** *Safety-I and Safety-II: The Past and Future of Safety Management.* CRC Press.

- **Applied in:** Overall system philosophy (the Synesis name itself), vertical prompt critic modes
- **Key insight:** Safety and success are not separate goals. They are emergent properties of the same adaptive processes. A system should focus on making things go right (Safety-II), not just preventing things from going wrong (Safety-I).
- **Design impact:** Synesis (the word coined by Hollnagel) means the unification of productivity, quality, safety, and reliability. The lateral collaboration model, taxonomy-driven behavior, and evidence-gated critique are all expressions of this principle. Vertical prompts in planner-ts support a `safety_ii` critic mode that steers the critic toward outcome-oriented evaluation ("did it help the user succeed?") rather than pure defect detection, directly implementing Hollnagel's insight.

**Woods, D.D. & Hollnagel, E. (2006).** *Joint Cognitive Systems: Patterns in Cognitive Systems Engineering.* CRC Press.

- **Applied in:** Human-AI collaboration patterns, clarify-first behavior (`llm-planner.ts` `shouldClarify()` + `buildClarificationQuestion()` in planner-ts; `planner_node.py` in planner)
- **Key insight:** Effective joint cognitive systems maintain shared understanding between human and machine. When the machine is uncertain, it should expose that uncertainty and collaborate with the human rather than proceeding with low confidence.
- **Design impact:** The diffuse frame probe (Cynefin complex domain) asks the user a guided clarification question using what the system already knows about the prompt. `shouldClarify()` fires when frame coherence is diffuse and difficulty is high enough, or when the plan's open questions exceed a threshold. This is a JCS pattern: the system exposes its partial understanding and invites the human to refine it, rather than stalling silently or assuming incorrectly.

### Faceted Search

**Hearst, M.A. (2009).** *Search User Interfaces.* Cambridge University Press.

- **Applied in:** Multi-domain retrieval filters, taxonomy as soft context (`router.ts`, `scoring-engine.ts` in planner-ts; `router.py`, `entry_classifier_engine.py` in planner)
- **Key insight:** Faceted search allows users to explore multiple dimensions simultaneously. Facets are not mutually exclusive — they are complementary perspectives.
- **Design impact:** Active domains in the DomainProfile function as retrieval facets, not exclusive filters. Multiple domains can be active simultaneously, and evidence from each domain enriches the response. The taxonomy resolution layer (`taxonomy-prompt-factory.ts`) propagates all `activeDomains` to prompt injection, ensuring writer/critic prompts reflect the full multidimensional profile.

## How These Connect to the Codebase

> **planner-ts** is the primary runtime. Python planner paths are kept for reference.

| Research | planner-ts | Python planner | Mechanism |
|----------|-----------|----------------|-----------|
| Klein (2007) Data-Frame | `domain-profile.ts` `buildDomainProfile()` | `frame_normalizer.py` `_build_domain_profile()` | Weighted domain profiling from full frame |
| Pirolli & Card (1999) Foraging | `frame-extractor.ts` topic_frame construction; `router.ts` topic-frame-guided retrieval | `frame_normalizer.py` `_build_topic_frame()` | TopicFrame guides evidence gathering |
| Snowden & Boone (2007) Cynefin | `entry-classifier.ts` `classifyCynefin()`, `domain-profile.ts` `frameCoherence` | `frame_normalizer.py` coherence classification | focused/composite/diffuse × Cynefin domain |
| Snowden & Boone (2007) Probe | `llm-planner.ts` `shouldClarify()` + `buildClarificationQuestion()` | `planner_node.py` Phase 2a probe | Guided clarification for diffuse/complex frames |
| Blei et al. (2003) LDA | `domain-profile.ts` `DomainProfile`, `scoring-engine.ts` `domain_ref_counts` | `schemas.py` `DomainProfile`, `DomainWeight` | Prompts as weighted topic mixtures |
| Agrawal et al. (2009) Diversity | `router.ts` domain-hint + topic-frame diversified dispatch | `router.py` `_domain_hints_from_state()` | Broad retrieval for composite frames |
| Broder (2002) Intent | `entry-classifier.ts` + `scoring-engine.ts` (ontology merge) | `entry_classifier_engine.py` | Intent class drives pipeline; domains provide context |
| Hollnagel (2014) Safety-II | `vertical-prompts.ts` `safety_ii` critic mode | System philosophy | Synesis name; critic steers toward "did it help?" |
| Woods & Hollnagel (2006) JCS | `llm-planner.ts` clarify-first gate | `planner_node.py` clarify-first gate | Human-AI shared understanding |
| Hearst (2009) Facets | `taxonomy-prompt-factory.ts` multi-domain propagation; `scoring-engine.ts` pairings | `entry_classifier_engine.py` pairings | Active domains as retrieval facets, not exclusive filters |

## Clarification Subsystem (planner-ts)

The clarification pipeline in `llm-planner.ts` has several safeguards to
ensure the Cynefin probe (design principle 5) fires reliably:

### Parse-fallback clarification

When the planner LLM returns unparseable JSON (e.g. due to budget truncation
or provider quirks), the catch path now calls `detectActionableAmbiguities()`
instead of silently falling back to a deterministic plan. If targeted
ambiguities are found, the result triggers `shouldClarify()` and the user
receives a clarification question rather than a low-quality assumed plan.

### Structured output (`response_format`)

The planner LLM call uses `response_format: { type: "json_object" }` when
available. Providers that reject this (OpenRouter passthrough, older vLLM) get
a graceful retry without the flag. Combined with the adaptive budget increase,
this nearly eliminates truncated-JSON failures.

### Deduplication

`buildClarificationQuestion()` deduplicates questions before merging
`plan.open_questions` with `detectActionableAmbiguities()`. The parse-fallback
path puts targeted ambiguities directly into `open_questions`, so a naive
merge would repeat them. A `Set` filter prevents duplicates.

### Post-clarification session preservation

When the user answers a clarification, the follow-up message is typically
short ("on prem, open weights, 50 users"). Without intervention, the entry
classifier downgrades it to trivial and skips the planner. Two flags are set
when consuming `pendingClarification`:

- `plan_required = true` — forces the full pipeline
- `difficulty = max(current, 0.6)` — prevents trivial classification

This ensures the planner runs with the accumulated conversation context plus
the user's answer, producing a full substantive response.

## Design Principles (Derived from Research)

1. **Sensemaking before action** — Build a holistic frame (DomainProfile) before retrieving evidence or generating content. Never lock on the first keyword signal.

2. **Prompts are topic mixtures** — Model domains as weighted vectors, not single labels. A scientist managing GPU ML on OpenShift genuinely spans 3-4 domains. Pairing rules and semantic cross-checks reinforce multidimensional classification.

3. **Match response to complexity** — Focused prompts get focused responses. Composite prompts get proportional multi-domain responses. Diffuse prompts trigger collaborative clarification.

4. **Taxonomy helps, never harms** — Domain knowledge structures (persona, depth, epistemic guidance, vertical prompts) help the model produce better output. They should never hard-exclude relevant content from a multi-domain prompt. Taxonomy blocks are injected at the tail of system prompts, preserving LLM prefix-cache efficiency.

5. **When uncertain, inquire** — In the Cynefin complex domain, probe before acting. Ask the user a guided question using what you already know, rather than proceeding with low confidence or stalling with no context.

6. **Safety and success are one thing** — Quality, safety, and productivity emerge from the same adaptive processes (taxonomy routing, evidence-gated critique, knowledge retrieval). The `safety_ii` critic mode embodies this directly. They are not separate concerns bolted onto each agent.

7. **Configuration is composable** — The ontology merge layer (`merge-plugins.ts`) combines core intent weights with plugin YAML overlays into a single `MergedOntologySnapshot`. Plugins add domain keywords, pairings, risk/complexity weights, and vertical prompts without modifying the core. This supports incremental specialization.

## Obsolete terminology: “intent anchors”

Older documentation described a separate **two-tier intent anchor** pipeline (`SYNESIS_ANCHOR_*`, dedicated state fields). That subsystem **is not in the codebase** anymore; behavior lives in:

- **Frame extraction → `DomainProfile` → focused / composite / diffuse** and **cohesion pre-seeding** for focused frames.
- **Ontology merge → `ScoringEngine`** (planner-ts): `intent_weights.yaml` + `plugins/weights/*.yaml` merged into a `MergedOntologySnapshot` with intent classes, domain keywords, complexity/risk weights, pairings, and vertical prompts.
- **Taxonomy resolution** (planner-ts): `taxonomy-prompt-factory.ts` + optional `semantic-taxonomy.ts` embedding cross-check resolve a taxonomy key and inject persona / epistemic / style / regulated-domain blocks into writer, critic, and planner prompts.

If you followed an old link, see [INTENT_ANCHORS.md](INTENT_ANCHORS.md) for a redirect and pointers here and to [WORKFLOW.md](WORKFLOW.md).
