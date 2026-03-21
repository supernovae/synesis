# Sensemaking, Cynefin, and Joint Cognitive Systems in Synesis

Synesis is designed as a **joint cognitive system** (JCS) where the AI and the human collaborate to produce high-quality output. The system's domain profiling, frame extraction, and retrieval architecture are grounded in established sensemaking research rather than ad-hoc heuristics.

This document tracks the research foundations that inform Synesis design decisions.

## Core References

### Sensemaking

**Klein, G., Moon, B., & Hoffman, R.R. (2007).** "Making Sense of Sensemaking 2: A Macrocognitive Model." *IEEE Intelligent Systems*, 21(5), 88-92.

- **Applied in:** Frame extraction pipeline (`frame_normalizer.py`)
- **Key insight:** Sensemaking is about fitting data into frames and frames around data iteratively. Build a holistic understanding of the prompt before acting, rather than locking on the first keyword signal.
- **Design impact:** The `_build_domain_profile()` function builds a weighted DomainProfile from the full extracted frame (technologies, deliverables, constraints, domain hints) before any retrieval happens. This replaces the old intent-anchor system that locked on the first keyword match.

**Pirolli, P. & Card, S. (1999).** "Information Foraging." *Psychological Review*, 106(4), 643-675.

- **Applied in:** Router evidence gathering, topic frame construction
- **Key insight:** Information foraging theory describes how people (and systems) should build a holistic frame of the problem and then use that frame to guide evidence gathering — not the other way around.
- **Design impact:** The TopicFrame (conceptual search entity) is built from deliverables and domain tags, deliberately excluding technologies. Technologies constrain the output, not the search. Evidence retrieval is guided by what the user wants, not by what tools they mentioned.

### Cynefin Framework

**Snowden, D.J. & Boone, M.E. (2007).** "A Leader's Framework for Decision Making." *Harvard Business Review*, 85(11), 68-76.

- **Applied in:** Frame coherence classification, clarification triggers
- **Key insight:** Different problem domains require different response strategies: obvious (sense-categorize-respond), complicated (sense-analyze-respond), complex (probe-sense-respond), chaotic (act-sense-respond).
- **Design impact:** The DomainProfile classifies frame coherence into three states:
  - **Focused** (obvious/complicated): One dominant domain. Safe to apply soft cohesion constraints. Existing behavior preserved.
  - **Composite** (complicated, multi-expert): Multiple clear domains. Address all proportionally. No hard exclusion. Cross-domain connections are valuable.
  - **Diffuse** (complex): No clear frame. Trigger a Cynefin probe — ask the user a guided clarification question before retrieving blindly. This prevents wasted compute and off-target responses.

### Topic Modeling and Multi-Label Classification

**Blei, D.M., Ng, A.Y., & Jordan, M.I. (2003).** "Latent Dirichlet Allocation." *Journal of Machine Learning Research*, 3, 993-1022.

- **Applied in:** DomainProfile weighted domain vector
- **Key insight:** Documents (and prompts) are not single-topic. They are mixtures of topics with different weights.
- **Design impact:** DomainProfile models each prompt as a weighted vector of domains (e.g., `{software_architecture: 0.8, llm_rag: 0.7, kubernetes: 0.3}`), not a single-label classification. This prevents the system from forcing a multi-domain architecture prompt into a single "kubernetes" category.

### Query Diversification

**Agrawal, R., Gollapudi, S., Halverson, A., & Ieong, S. (2009).** "Diversifying Search Results." *Proceedings of WSDM 2009*, 5-14.

- **Applied in:** Multi-domain retrieval, composite frame evidence gathering
- **Key insight:** When a query spans multiple aspects, retrieval should diversify results to cover all aspects rather than collapsing to one.
- **Design impact:** For composite frames, the router returns ALL weighted domains as retrieval hints, ensuring evidence is gathered from all relevant domains. The summarizer receives multi-domain context instead of hard exclusion constraints.

### Query Intent Understanding

**Broder, A. (2002).** "A Taxonomy of Web Search." *ACM SIGIR Forum*, 36(2), 3-10.

- **Applied in:** Entry classifier intent classification
- **Key insight:** Query intent (informational, navigational, transactional) should drive retrieval strategy, not keyword matching alone.
- **Design impact:** The entry classifier determines intent_class (planning, coding, information_request, etc.) before domain detection. Intent drives pipeline behavior; domains provide context.

### Joint Cognitive Systems and Safety-II

**Hollnagel, E. (2014).** *Safety-I and Safety-II: The Past and Future of Safety Management.* CRC Press.

- **Applied in:** Overall system philosophy (the Synesis name itself)
- **Key insight:** Safety and success are not separate goals. They are emergent properties of the same adaptive processes. A system should focus on making things go right (Safety-II), not just preventing things from going wrong (Safety-I).
- **Design impact:** Synesis (the word coined by Hollnagel) means the unification of productivity, quality, safety, and reliability. The lateral collaboration model, taxonomy-driven behavior, and evidence-gated critique are all expressions of this principle.

**Woods, D.D. & Hollnagel, E. (2006).** *Joint Cognitive Systems: Patterns in Cognitive Systems Engineering.* CRC Press.

- **Applied in:** Human-AI collaboration patterns, clarify-first behavior
- **Key insight:** Effective joint cognitive systems maintain shared understanding between human and machine. When the machine is uncertain, it should expose that uncertainty and collaborate with the human rather than proceeding with low confidence.
- **Design impact:** The diffuse frame probe (Cynefin complex domain) asks the user a guided clarification question using what the system already knows about the prompt. This is a JCS pattern: the system exposes its partial understanding and invites the human to refine it, rather than stalling silently or assuming incorrectly.

### Faceted Search

**Hearst, M.A. (2009).** *Search User Interfaces.* Cambridge University Press.

- **Applied in:** Multi-domain retrieval filters, taxonomy as soft context
- **Key insight:** Faceted search allows users to explore multiple dimensions simultaneously. Facets are not mutually exclusive — they are complementary perspectives.
- **Design impact:** Active domains in the DomainProfile function as retrieval facets, not exclusive filters. Multiple domains can be active simultaneously, and evidence from each domain enriches the response.

## How These Connect to the Codebase

| Research | Codebase Location | Mechanism |
|----------|------------------|-----------|
| Klein (2007) Data-Frame | `frame_normalizer.py` `_build_domain_profile()` | Weighted domain profiling from full frame |
| Pirolli & Card (1999) Foraging | `frame_normalizer.py` `_build_topic_frame()` | TopicFrame guides evidence gathering |
| Snowden & Boone (2007) Cynefin | `frame_normalizer.py` frame coherence classification | focused/composite/diffuse states |
| Snowden & Boone (2007) Probe | `planner_node.py` Phase 2a diffuse frame probe | Guided clarification for complex frames |
| Blei et al. (2003) LDA | `schemas.py` `DomainProfile`, `DomainWeight` | Prompts as weighted topic mixtures |
| Agrawal et al. (2009) Diversity | `router.py` `_domain_hints_from_state()` | Broad retrieval for composite frames |
| Hollnagel (2014) Safety-II | Overall system philosophy | Synesis name, lateral collaboration |
| Woods & Hollnagel (2006) JCS | `planner_node.py` clarify-first gate | Human-AI shared understanding |

## Design Principles (Derived from Research)

1. **Sensemaking before action** — Build a holistic frame (DomainProfile) before retrieving evidence or generating content. Never lock on the first keyword signal.

2. **Prompts are topic mixtures** — Model domains as weighted vectors, not single labels. A scientist managing GPU ML on OpenShift genuinely spans 3-4 domains.

3. **Match response to complexity** — Focused prompts get focused responses. Composite prompts get proportional multi-domain responses. Diffuse prompts trigger collaborative clarification.

4. **Taxonomy helps, never harms** — Domain knowledge structures (persona, depth, epistemic guidance) help the model produce better output. They should never hard-exclude relevant content from a multi-domain prompt.

5. **When uncertain, inquire** — In the Cynefin complex domain, probe before acting. Ask the user a guided question using what you already know, rather than proceeding with low confidence or stalling with no context.

6. **Safety and success are one thing** — Quality, safety, and productivity emerge from the same adaptive processes (taxonomy routing, evidence-gated critique, knowledge retrieval). They are not separate concerns bolted onto each agent.

## Obsolete terminology: “intent anchors”

Older documentation described a separate **two-tier intent anchor** pipeline (`SYNESIS_ANCHOR_*`, dedicated state fields). That subsystem **is not in the codebase** anymore; behavior lives in **frame extraction → `DomainProfile` → focused / composite / diffuse** and **cohesion pre-seeding** for focused frames. If you followed an old link, see [INTENT_ANCHORS.md](INTENT_ANCHORS.md) for a redirect and pointers here and to [WORKFLOW.md](WORKFLOW.md).
