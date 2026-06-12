# Prompt Layering and Calibration

This document records how Synesis composes prompt instructions across planner
nodes: what is universal, what is taxonomy-steered, how regulated domains are
handled, and how calibration guidance reaches the writer and critic. It
complements [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD) for graph flow and
[performance.md](performance.md) for prefix-cache ordering.

## Terminology

- **Taxonomy** means the domain metadata in
  `taxonomy_prompt_config.yaml` and `taxonomy_domains.raw_config`: domain path,
  complexity, required elements, output style, calibration guidance, and
  regulated-domain blocks.
- **Ontology** is used only for the planner's merge layer in
  [`base/planner-ts/src/ontology/merge-plugins.ts`](../base/planner-ts/src/ontology/merge-plugins.ts),
  which combines intent weights, domain keywords, pairings, and vertical prompt
  plugin overlays into one scoring snapshot.
- **Calibration guidance** is a deliberate runtime field name. In Synesis docs it
  means practical calibration: evidence strength, uncertainty, assumptions,
  limits, and when to avoid overclaiming. It is not a claim that the system is
  doing philosophy of knowledge.

## Goals

- **Keep universal prompts thin:** Writer, critic, and planner prompts should
  not encode product-specific checklists or domain playbooks.
- **Make uncertainty visible:** Stable rules about calibration, scope,
  evidence vs inference, and honest limits apply across arbitrary user prompts.
- **Let taxonomy own domain shape:** Framing, depth, output style, and
  high-stakes-domain strictness apply when the system resolves a matching
  taxonomy key or vertical. They are not controlled by a user's free-text claim
  that a request is or is not in a domain.
- **Preserve trust boundaries:** Injection resistance, authority tiers, and
  appropriate reliance stay in the universal layer and are not weakened by
  taxonomy config.

## Three Layers

| Layer | Role | Source of truth | User can override? |
|-------|------|-----------------|-------------------|
| **L0** | Universal trust, calibration, and non-bypassable safety floors | Planner/writer/critic constants and trust prompts | **No** |
| **L1** | Node contract: schemas, JSON format, rubric shape, retrieval mechanics | TypeScript node modules | **No** |
| **L2** | Domain depth, output style, regulated overlays, query hints, vertical prompt fragments | Taxonomy YAML, Admin taxonomy DB, vertical plugin config | **Admin / deploy-time only** |

Composition order inside a single LLM call:

1. **L0** static prefix, kept first for prefix-cache reuse.
2. **L1** role instructions such as planner JSON shape or critic rubric.
3. **L2** request-specific suffix: `depth_instructions`,
   `output_style_guidance`, `calibration_guidance`, regulated blocks, vertical
   persona/critic fragments, query hints, and frame/routing metadata.

Taxonomy extends node behavior. It does not sit above L0, and L2 must never
instruct the model to ignore L0 trust or safety constraints.

## Taxonomy Selection

`taxonomy_metadata` and `taxonomy_key` are produced by the entry classifier plus
[`resolveTaxonomyMetadata`](../base/planner-ts/src/taxonomy/taxonomy-prompt-factory.ts).
The resolver uses system-side signals from the user message and configured
taxonomy data. User text such as "ignore taxonomy" or "treat this as medical"
does not directly set the taxonomy key.

That means:

- A user cannot opt out of a regulated overlay if classification still resolves
  a regulated taxonomy key.
- A user cannot opt in to weaker rules for a regulated topic solely by asking.
- Untrusted RAG/web/tool content is still wrapped by the trust policy and cannot
  override system behavior.

## Regulated Domains

Detailed high-stakes-domain guidance belongs in L2 taxonomy fields rather than
large universal prompt text. The universal L0 floor stays small and
non-bypassable:

- Do not provide personalized medical diagnosis, treatment, or dosing.
- Do not provide personalized legal advice.
- Do not assist illegal or high-harm requests.

The domain playbooks live in taxonomy fields such as
`writer_regulated_block` and `critic_regulated_block`.

## Current Field Status

| Field | Status | Evidence |
|-------|--------|----------|
| `depth_instructions` | Implemented | Resolved in `taxonomy-prompt-factory.ts`; injected into planner, writer, critic hints, and traces. |
| `output_style_guidance` | Implemented | Resolved and injected into writer prompts for model tiers that use taxonomy style guidance. |
| `calibration_guidance` | Implemented | Resolved and injected into planner/writer prompts; visible in trace steering. |
| `regulated_domain` | Metadata implemented | Resolved as a boolean. Behavior is controlled by the explicit writer/critic regulated blocks. |
| `writer_regulated_block` | Implemented | Injected by `writer-compose.ts` as `REGULATED CONTEXT (taxonomy)`. |
| `critic_regulated_block` | Implemented | Injected by `critic-evaluator.ts` into the dynamic critic suffix. |
| `critic_assistant_systems_block` | Implemented | Injected by `critic-evaluator.ts` for assistant-system review guidance. |
| `query_expansion_hints` / `preferred_web_scopes` | Implemented as metadata helpers | Resolved and tested in `taxonomy.test.ts`; consumers can call the typed helpers. |
| `router_summarizer_tone` | Partial | Resolved and exposed through `getRouterSummarizerTone()`, but no router summarizer consumer currently uses it. |
| Admin taxonomy editing for all fields | Partial | Admin API/UI edits required elements, depth, output style, and calibration guidance; regulated blocks and router tone still require YAML/sync workflows. |

## Remaining Work

These are the only backlog items still worth tracking from the old design note:

1. Wire `router_summarizer_tone` into the retrieval/evidence summarization path.
   Add tests that the tone is present only when taxonomy metadata includes it and
   that it cannot override trust policy language.
2. Extend the Admin taxonomy API/UI to edit regulated-domain fields:
   `regulated_domain`, `writer_regulated_block`, `critic_regulated_block`,
   `critic_assistant_systems_block`, `query_expansion_hints`,
   `preferred_web_scopes`, and `router_summarizer_tone`. Update
   `base/admin/tests/test_taxonomy_schemas.py` and frontend mutation types.
3. Add a trace assertion test that `steering_applied` records regulated and
   calibration blocks when they are injected.

Do not add a generic `regulated_compliance_block`; the current split
writer/critic fields are clearer and already implemented.

## Router and Evidence Packets

Retrieval summaries should expose practical calibration signals: what was
found, what was not found, source confidence, and important limits. This should
be done through structured evidence metadata and concise summarization, not by
bloating L0 universal prompts.

## Caching

Keep L0 and stable L1 text first. L2 varies by request and should remain near
the end of the system message. See [performance.md](performance.md)
"Prefix-aware prompts".

## Related Documents

- [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD) — graph nodes and routing.
- [TAXONOMY_DRIVEN_INJECTION.md](TAXONOMY_DRIVEN_INJECTION.md) — taxonomy field flow.
- [.cursor/rules/planner-prompt-hygiene.mdc](../.cursor/rules/planner-prompt-hygiene.mdc)
  — what not to encode in generic planner nodes.
- [.cursor/rules/prefix-cache-prompt-ordering.mdc](../.cursor/rules/prefix-cache-prompt-ordering.mdc)
  — static-before-dynamic ordering.

## External Audit References

- NIST AI RMF
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- RAG evaluation tooling for measurement, not prompt bloat
- Principle-based safety framing as inspiration for keeping L0 short
- Joint cognitive systems and appropriate reliance work for human-AI handoff language

---

Update this file when L0/L1/L2 boundaries or taxonomy prompt fields change.
