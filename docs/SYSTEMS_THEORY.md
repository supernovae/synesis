# Systems Theory — Foundations and Design Philosophy

Synesis is named for Erik Hollnagel's concept of **synesis**: the unification of productivity, quality, safety, and reliability as emergent properties of the same adaptive processes. The platform's architecture is grounded in established research on how humans and systems make sense of complex, multi-domain problems — not in ad-hoc heuristics or pattern matching.

This document is the central reference for the theoretical foundations, research bibliography, and design principles that guide engineering decisions across Synesis.

---

## 1. Guiding Premise

AI platforms that bolt safety, quality, and retrieval onto a generation pipeline as afterthoughts produce brittle systems. Synesis treats these as **co-emergent** properties of a single adaptive architecture:

- The same taxonomy that shapes the writer's persona also governs critic depth and retrieval strategy.
- The same trust envelope that defends against prompt injection also carries attribution metadata for human review.
- The same sensemaking pipeline that classifies intent complexity also decides when to ask the user for clarification instead of generating a low-confidence answer.

When these concerns share infrastructure, improvements in one dimension propagate across all others.

## 2. Theoretical Foundations

### 2.1 Joint Cognitive Systems

**Woods, D.D. & Hollnagel, E. (2006).** *Joint Cognitive Systems: Patterns in Cognitive Systems Engineering.* CRC Press.

Effective joint cognitive systems maintain shared understanding between human and machine. When the machine is uncertain, it should expose that uncertainty and collaborate with the human rather than proceeding with low confidence or stalling silently.

**Design impact:** Synesis is designed as a human-AI collaboration where the system exposes its understanding and uncertainty, inviting the human to refine direction. The diffuse-frame probe asks the user a guided clarification question using what the system already knows (`shouldClarify()` in `llm-planner.ts`). The human-in-the-loop review queue, trust attribution metadata, and epistemic uncertainty labels (`[Assumption: …]`, `[Estimate: …]`) all express this principle.

### 2.2 Safety-II

**Hollnagel, E. (2014).** *Safety-I and Safety-II: The Past and Future of Safety Management.* CRC Press.

Safety and success are not separate goals. They are emergent properties of the same adaptive processes. A system should focus on making things go right (Safety-II), not just preventing things from going wrong (Safety-I).

**Design impact:** Synesis (the name itself) embodies this. The critic, taxonomy routing, evidence-gated retrieval, and trust envelopes are not bolted-on safety checks — they are core architectural patterns that make all output better. Vertical prompts support a `safety_ii` critic mode that steers evaluation toward outcome-oriented assessment ("did it help the user succeed?") rather than pure defect detection.

### 2.3 Sensemaking and Data-Frame Theory

**Klein, G., Moon, B., & Hoffman, R.R. (2007).** "Making Sense of Sensemaking 2: A Macrocognitive Model." *IEEE Intelligent Systems*, 21(5), 88-92.

Sensemaking is about fitting data into frames and frames around data iteratively. Build a holistic understanding of the prompt before acting, rather than locking on the first keyword signal.

**Design impact:** `buildDomainProfile()` constructs a weighted `DomainProfile` from the full extracted frame (technologies, deliverables, constraints, domain hints) before any retrieval happens. This replaces intent-anchor systems that locked on first-match keywords.

### 2.4 Information Foraging

**Pirolli, P. & Card, S. (1999).** "Information Foraging." *Psychological Review*, 106(4), 643-675.

Information foraging theory describes how systems should build a holistic frame of the problem and then use that frame to guide evidence gathering — not the other way around.

**Design impact:** The `TopicFrame` (conceptual search entity) is built from deliverables and domain tags, deliberately excluding technologies. Technologies constrain the output, not the search. Evidence retrieval follows what the user wants, not what tools they mentioned.

### 2.5 Cynefin Framework

**Snowden, D.J. & Boone, M.E. (2007).** "A Leader's Framework for Decision Making." *Harvard Business Review*, 85(11), 68-76.

Different problem domains require different response strategies: obvious (sense-categorize-respond), complicated (sense-analyze-respond), complex (probe-sense-respond), chaotic (act-sense-respond).

**Design impact:** `classifyCynefin()` maps difficulty × frame coherence to a formal Cynefin domain. Response strategy scales accordingly:

| Frame Coherence | Cynefin Domain | Synesis Behavior |
|----------------|---------------|-----------------|
| **Focused** | Clear / Complicated | One dominant domain; soft cohesion constraints; direct response |
| **Composite** | Complicated, multi-expert | Multiple clear domains; proportional coverage; no hard exclusion |
| **Diffuse** | Complex / Chaotic | Unclear frame; guided clarification before retrieval |

### 2.6 Topic Modeling

**Blei, D.M., Ng, A.Y., & Jordan, M.I. (2003).** "Latent Dirichlet Allocation." *Journal of Machine Learning Research*, 3, 993-1022.

Documents (and prompts) are not single-topic. They are mixtures of topics with different weights.

**Design impact:** `DomainProfile` models each prompt as a weighted vector of domains (e.g., `{software_architecture: 0.8, llm_rag: 0.7, kubernetes: 0.3}`), not a single-label classification. The scoring engine's `domain_ref_counts` and pairing rules reinforce multidimensional classification. A scientist managing GPU ML on OpenShift genuinely spans 3-4 domains and should be served accordingly.

### 2.7 Query Diversification

**Agrawal, R., Gollapudi, S., Halverson, A., & Ieong, S. (2009).** "Diversifying Search Results." *Proceedings of WSDM 2009*, 5-14.

When a query spans multiple aspects, retrieval should diversify results to cover all aspects rather than collapsing to one.

**Design impact:** For composite frames, the router returns ALL weighted domains as retrieval hints, ensuring evidence is gathered from all relevant domains. The writer receives multi-domain context instead of hard exclusion constraints.

### 2.8 Query Intent Understanding

**Broder, A. (2002).** "A Taxonomy of Web Search." *ACM SIGIR Forum*, 36(2), 3-10.

Query intent (informational, navigational, transactional) should drive retrieval strategy, not keyword matching alone.

**Design impact:** The entry classifier determines `intent_class` (planning, coding, information_request, etc.) before domain detection. Intent drives pipeline behavior; domains provide context. The scoring engine loads intent classes, domain keywords, and pairing rules from the merged ontology snapshot (`intent_weights.yaml` + `plugins/weights/*.yaml`).

### 2.9 Faceted Search

**Hearst, M.A. (2009).** *Search User Interfaces.* Cambridge University Press.

Faceted search allows users to explore multiple dimensions simultaneously. Facets are not mutually exclusive — they are complementary perspectives.

**Design impact:** Active domains in the `DomainProfile` function as retrieval facets, not exclusive filters. Multiple domains can be active simultaneously, and evidence from each domain enriches the response. The taxonomy resolution layer propagates all `activeDomains` to prompt injection.

### 2.10 Retrieval-Augmented Generation

**Lewis, P., Perez, E., Piktus, A., et al. (2020).** "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks." *NeurIPS 2020* — link in [AWESOME_PAPERS.MD](AWESOME_PAPERS.MD#rag-and-retrieval).

Augmenting generation with retrieved evidence reduces hallucination, grounds responses in verifiable sources, and enables domain specialization without model retraining.

**Design impact:** The entire planner-ts pipeline is retrieval-first: the router gathers evidence packets before the writer generates content, the critic scores evidence utilization, and deterministic validators check citation preservation. Graph-native retrieval (NornicDB vector seeds plus code/document graph expansion, web search via SearXNG, RRF merge) provides broad coverage. Authority-weighted provenance, objective authz predicates, and freshness scoring ensure the most relevant, trustworthy evidence surfaces.

### 2.11 Human–AI Collaborative Sensemaking

**Zhang, Y. et al. (2025).** "What to Make Sense of in the Era of LLM? A Perspective from the Structure and Efforts in Sensemaking." — [arXiv:2603.08604](https://arxiv.org/abs/2603.08604) (also indexed in [AWESOME_PAPERS.MD](AWESOME_PAPERS.MD#sensemaking-cognition-and-design-theory)).

Sensemaking with LLMs emphasizes human-AI collaboration and complementary roles rather than full automation. The system should support sensemaking by constraining when it answers, how it labels uncertainty, and when it hands back to the user.

**Design impact:** Synesis constrains its own behavior: clarify-first for chaotic frames, epistemic labels for uncertain claims, evidence-governed answers with visible citations, and HITL review queues for corpus quality. The human supplies judgment and domain authority; the system supplies structure, recall, and consistency.

---

## 3. Prompt Injection and Trust Research

Security-oriented papers and OWASP mapping are centralized in [AWESOME_PAPERS.MD — Security and prompt injection](AWESOME_PAPERS.MD#security-and-prompt-injection). Implementation details: [SECURITY.md](SECURITY.md).

---

## 4. Lateral Collaboration Model

Synesis implements a **lateral collaboration model** — domain agents operate independently with their own tools and context, but share a common layer of intelligence infrastructure: taxonomy routing, knowledge retrieval, quality gates, and critic reasoning.

The Coder agent is the first instance. It connects directly to a dedicated coding model with tool-calling support and reaches Synesis capabilities (RAG, taxonomy, architecture knowledge, critic review) through MCP tool calls when needed. The agent stays lightweight and domain-focused; Synesis provides the connective tissue.

This is the Hollnagel insight applied to multi-agent AI. Quality, safety, and productivity are not separate concerns bolted onto each agent — they emerge from the shared adaptive processes (taxonomy-driven routing, evidence-gated critique, knowledge retrieval) that surround every agent equally.

**The pattern generalizes beyond coding.** A GIS spatial analysis agent, a compliance auditor, or a data pipeline builder can each plug into the same lateral infrastructure. Each domain agent brings its own model and tools for domain-specific work, while MCP connections to Synesis provide access to organizational knowledge, quality validation, and structured reasoning — without forcing that intelligence into the agent itself.

The architecture scales with need: from a single guided model endpoint with taxonomy shaping, up to a fully autonomous agent with MCP tools and sandbox execution.

---

## 5. Codebase Mapping

> **planner-ts** is the primary runtime.

| Research | Module | Mechanism |
|----------|--------|-----------|
| Klein (2007) Data-Frame | `domain-profile.ts` `buildDomainProfile()` | Weighted domain profiling from full frame |
| Pirolli & Card (1999) Foraging | `frame-extractor.ts` TopicFrame; `router.ts` topic-frame-guided retrieval | TopicFrame guides evidence gathering |
| Snowden & Boone (2007) Cynefin | `entry-classifier.ts` `classifyCynefin()`, `domain-profile.ts` `frameCoherence` | focused / composite / diffuse × Cynefin domain |
| Snowden & Boone (2007) Probe | `llm-planner.ts` `shouldClarify()` + `buildClarificationQuestion()` | Guided clarification for diffuse/complex frames |
| Blei et al. (2003) LDA | `domain-profile.ts` `DomainProfile`, `scoring-engine.ts` `domain_ref_counts` | Prompts as weighted topic mixtures |
| Agrawal et al. (2009) Diversity | `router.ts` domain-hint + topic-frame diversified dispatch | Broad retrieval for composite frames |
| Broder (2002) Intent | `entry-classifier.ts` + `scoring-engine.ts` (ontology merge) | Intent class drives pipeline; domains provide context |
| Lewis et al. (2020) RAG | `router.ts` → `unified.ts` → `rag-client.ts` | Hybrid retrieval, RRF merge, authority weighting |
| Hollnagel (2014) Safety-II | `vertical-prompts.ts` `safety_ii` critic mode | Critic steers toward "did it help?" |
| Woods & Hollnagel (2006) JCS | `llm-planner.ts` clarify-first gate | Human-AI shared understanding |
| Hearst (2009) Facets | `taxonomy-prompt-factory.ts` multi-domain propagation; `scoring-engine.ts` pairings | Active domains as retrieval facets |
| Trust / injection research | `@synesis/context-trust`, `scanner.ts`, `normalizer.ts` | TrustPacketV1, 9-layer defense-in-depth |

---

## 6. Clarification Subsystem

The clarification pipeline in `llm-planner.ts` ensures the Cynefin probe fires reliably:

- **Parse-fallback clarification** — When the planner LLM returns unparseable JSON, the catch path calls `detectActionableAmbiguities()` instead of silently falling back to a deterministic plan. If targeted ambiguities are found, the user receives a clarification question rather than a low-quality assumed plan.
- **Structured output** — The planner LLM call uses `response_format: { type: "json_object" }` when available. Providers that reject this get a graceful retry without the flag.
- **Deduplication** — `buildClarificationQuestion()` deduplicates questions before merging `plan.open_questions` with `detectActionableAmbiguities()`. A `Set` filter prevents duplicates from the parse-fallback path.
- **Post-clarification session preservation** — When the user answers a clarification, the follow-up message is typically short. Two flags (`plan_required = true`, `difficulty = max(current, 0.6)`) prevent the entry classifier from downgrading it and ensure the planner runs with accumulated context.

---

## 7. Design Principles

These principles are derived from the research above and govern engineering decisions across the platform.

1. **Sensemaking before action** — Build a holistic frame (`DomainProfile`) before retrieving evidence or generating content. Never lock on the first keyword signal.

2. **Prompts are topic mixtures** — Model domains as weighted vectors, not single labels. Pairing rules and semantic cross-checks reinforce multidimensional classification.

3. **Match response to complexity** — Focused prompts get focused responses. Composite prompts get proportional multi-domain responses. Diffuse prompts trigger collaborative clarification.

4. **Taxonomy helps, never harms** — Domain knowledge structures (persona, depth, epistemic guidance, vertical prompts) help the model produce better output. They should never hard-exclude relevant content from a multi-domain prompt. Taxonomy blocks are injected at the tail of system prompts, preserving LLM prefix-cache efficiency.

5. **When uncertain, inquire** — In the Cynefin complex domain, probe before acting. Ask the user a guided question using what you already know, rather than proceeding with low confidence.

6. **Safety and success are one thing** — Quality, safety, and productivity emerge from the same adaptive processes. They are not separate concerns bolted onto each agent.

7. **Configuration is composable** — The ontology merge layer combines core intent weights with plugin YAML overlays into a single snapshot. Plugins add domain keywords, pairings, and vertical prompts without modifying the core.

8. **Trust is structural, not decorative** — Every piece of external content entering a prompt carries a versioned trust envelope (`TrustPacketV1`) with attribution metadata, scan status, and policy decisions. Trust is enforced at the schema level, not by convention.

9. **Evidence earns authority, not trust** — Human vetting and high-authority sources boost retrieval ranking, but all external content is always wrapped as untrusted in prompts. Vetting changes priority, never trust boundaries.

10. **Lateral intelligence over monolithic agents** — Domain agents stay lightweight and focused on their specialty. Shared infrastructure (taxonomy, retrieval, quality gates, trust) is accessed through MCP tool calls, not duplicated inside each agent.

---

## 8. Obsolete Terminology

### "Intent anchors"

Older documentation described a separate **two-tier intent anchor** pipeline (`SYNESIS_ANCHOR_*`, dedicated state fields). That subsystem is not in the codebase anymore; behavior lives in:

- **Frame extraction → `DomainProfile` → focused / composite / diffuse** and cohesion pre-seeding for focused frames.
- **Ontology merge → `ScoringEngine`**: `intent_weights.yaml` + `plugins/weights/*.yaml` merged into a `MergedOntologySnapshot` with intent classes, domain keywords, complexity/risk weights, pairings, and vertical prompts.
- **Taxonomy resolution**: `taxonomy-prompt-factory.ts` + optional `semantic-taxonomy.ts` embedding cross-check.

See [INTENT_ANCHORS.md](INTENT_ANCHORS.md) for the redirect and pointers to [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD).

---

## Related Documents

| Document | Description |
|----------|-------------|
| [AWESOME_PAPERS.MD](AWESOME_PAPERS.MD) | Curated arXiv and primary references (security, RAG, critic, sensemaking) |
| [DESIGN_THEORY.md](DESIGN_THEORY.md) | Cynefin domain mapping, clarify-first behavior, epistemic discipline |
| [SECURITY.md](SECURITY.md) | Trust envelopes, 9-layer prompt injection defense, attribution |
| [TAXONOMY_SHAPING.md](TAXONOMY_SHAPING.md) | Domain behavior configuration via YAML |
| [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD) | Full pipeline flow, router-governed evidence, anti-oscillation |
| [CRITIC_RESEARCH.md](CRITIC_RESEARCH.md) | Research basis for critic evaluation rubric |
| [INDEXERS.md](INDEXERS.md) | RAG indexer, schema v20 content graph, trust attribution fields |
| [ADMIN_QUALITY_UI.md](ADMIN_QUALITY_UI.md) | Feedback loops, quality signals, HITL review |
