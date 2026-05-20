# Taxonomy-Driven Contextual Injection

How the Entry Classifier identifies a topic's complexity and uses taxonomy metadata
to shape prompts for the Planner, Writer, and Critic. No new LLM — deterministic
lookup from `taxonomy_prompt_config.yaml` (190 entries, compiled at startup).

---

## Overview

| Component | Role |
|-----------|------|
| **Entry Classifier** | Deterministic scoring engine. Outputs `active_domain_refs`, `task_size`, `intent_class`, `complexity_score`. |
| **TaxonomyResolver** | `resolve_taxonomy_metadata()` — maps domain to full metadata dict. Forwards all YAML fields automatically. No LLM. |
| **Planner** | Taxonomy-aware. Reads `required_elements` and `planner_decomposition_rules`; injects depth instructions when complexity > 0.55. |
| **Writer** | Receives `depth_instructions`, `output_style_guidance`, and `epistemic_guidance` as system prompt blocks. Evidence trimmed to `evidence_budget_chars`. |
| **Critic** | Uses universal principles + taxonomy hints. For complexity >= 0.8, `required_elements` are soft mandates. |

---

## TaxonomyNode Schema (State)

All raw YAML fields are forwarded via `dict(node_cfg)` in `resolve_taxonomy_metadata()`.
Computed fields are overlaid on top. Adding a new field to YAML makes it immediately
available in `state["taxonomy_metadata"]` — no code changes required.

**Computed fields (overlaid):**

```
path: str                    # e.g. "Science > Physics"
complexity_score: float      # Blended: 40% domain baseline + 60% prompt difficulty
persona_instructions: str    # Persona + depth guidance (when complexity > 0.55)
required_bullets: int        # len(required_elements), capped at 2 for trivial queries
taxonomy_key: str            # e.g. "physics", "generic"
```

**Raw YAML fields (forwarded as-is):**

```
complexity: float            # Raw domain baseline (0.0-1.0)
persona: str                 # Base persona label
depth_instructions: str      # Injected as DOMAIN DEPTH block
required_elements: list[str] # e.g. ["Theoretical Basis", "Mathematical Context"]
output_style: str            # Short label for output format
output_style_guidance: str   # Injected as OUTPUT STYLE block
epistemic_guidance: str      # Injected as EPISTEMIC DISCIPLINE block
planner_decomposition_rules: str  # Domain-specific planning rules
worker_explain_tone: str     # Role/style for text mode prompts
discovery_prompt: str        # Enrichment instruction
query_expansion_hints: list  # Terms for retrieval query expansion
preferred_web_scopes: list   # Steer web search to authoritative sites
```

---

## Flow

1. **Entry Classifier** produces `active_domain_refs` (e.g. `["physics"]`), `task_size`, `intent_class`, `complexity_score`.
2. **TaxonomyResolver** looks up first matching domain in pre-cached `_cached_taxonomies` → full metadata dict (O(1) dict access, no YAML parsing).
3. **Complexity blending**: 40% domain baseline (from YAML) + 60% prompt-specific difficulty (from ScoringEngine). Simple questions in complex domains stay simple.
4. **State** receives `taxonomy_metadata` dict. Flows through all nodes.
5. **Document + high-depth**: `plan_required=true` when domain in `deep_dive_domains` and `complexity > 0.6`.
6. **Planner** appends `get_planner_system_prompt_append(metadata)` to system prompt. Uses `planner_decomposition_rules` from taxonomy if present.
7. **Writer** injects three taxonomy blocks into system prompt:
   - `DOMAIN DEPTH:` from `depth_instructions` (when complexity > 0.55)
   - `OUTPUT STYLE:` from `output_style_guidance`
   - `EPISTEMIC DISCIPLINE:` from `epistemic_guidance`
8. **Evidence budget**: Compiled evidence trimmed to `evidence_budget_chars` (default 24,000) to prevent token-budget fading.
9. **Critic**: For complexity >= 0.8, `required_elements` are "Expected sections" (soft mandates). For lower complexity, advisory hints. Critic generates per-query evaluation criteria using taxonomy hints.

---

## Example: "What is the speed of light?"

1. Entry Classifier: `knowledge_style` match → `intent_class=knowledge`. Domain keywords → `active_domain_refs=["physics"]`.
2. TaxonomyResolver: `physics` → full metadata with `complexity=0.9`, `required_elements=[Theoretical Basis, Mathematical Context, Real-world Implications, Historical Context, Key Constants & Formulas]`, `epistemic_guidance="Distinguish established laws from approximations..."`.
3. `should_plan_for_document(metadata, ["physics"])` → true (complexity > 0.6).
4. `plan_required=true` → route to Planner.
5. Planner: System prompt includes required_elements + depth_instructions.
6. Writer: System prompt receives DOMAIN DEPTH, OUTPUT STYLE, and EPISTEMIC DISCIPLINE blocks. Evidence trimmed to budget.
7. Critic: complexity >= 0.8 → required_elements are soft mandates. Validates coverage of Theoretical Basis, Mathematical Context, etc. If insufficient → revision loop.
8. Final Scrubber → Respond.

---

## Config: taxonomy_prompt_config.yaml

**Location:** `base/planner-ts/config/taxonomy_prompt_config.yaml`

**Size:** 190 domain entries across 28 top-level categories (Engineering, Science,
Lifestyle, Writing, etc.).

**Full entry example:**

```yaml
physics:
  path: "Science > Physics"
  complexity: 0.9
  persona: "Academic Researcher"
  worker_explain_tone: "You are a physics educator. Default to thorough, principled explanations."
  depth_instructions: >-
    Derive from first principles. Use equations within prose paragraphs.
    State approximations and their validity ranges.
  required_elements:
    - "Theoretical Basis"
    - "Mathematical Context"
    - "Real-world Implications"
    - "Historical Context"
    - "Key Constants & Formulas"
  output_style: "scientific_explanation"
  output_style_guidance: >-
    State the principle, derive the math, connect to physical intuition.
  epistemic_guidance: >-
    Distinguish established laws from approximations and their validity ranges.
    Flag active research frontiers separately from textbook material.
  discovery_prompt: "End with a 'Discover More' note connecting this topic to adjacent physics."
  query_expansion_hints:
    - "first principles"
    - "derivation"
  preferred_web_scopes:
    - "site:arxiv.org"
```

**Minimum valid entry:**

```yaml
my_domain:
  path: "Category > My Domain"
  complexity: 0.6
```

All other fields are optional. The taxonomy linter validates required fields at startup.

---

## Startup Compilation

Taxonomy config is compiled once at startup in `lifespan()`:

1. `_load_config()` parses YAML into `_cached` (module global)
2. `_cached_taxonomies` is pre-built (filtered dict of entries with `path` key)
3. `lint_taxonomy_config()` validates all entries via Pydantic:
   - Required fields: `path` (str), `complexity` (float 0.0-1.0)
   - Type validation for all known fields
   - Duplicate path detection
   - Orphan domain detection (cross-refs routing YAML)
   - Alias collision detection (`query_expansion_hints` overlap)

Per-request cost is O(1) dict access. No YAML parsing, no disk I/O on the hot path.

---

## Adding a New Taxonomy

1. Add `domain_keywords.<key>` in `intent_weights.yaml` or a plugin YAML so Entry Classifier produces the key in `active_domain_refs`.
2. Add the key and schema to `taxonomy_prompt_config.yaml` (minimum: `path` + `complexity`).
3. The taxonomy linter will validate the entry at next startup.
4. Any new YAML fields are automatically forwarded to `taxonomy_metadata` — no code changes needed.

---

## Design Decisions

- **No new LLM**: TaxonomyResolver is deterministic lookup. Entry Classifier (YAML scoring) + cached config = fast.
- **Forward-all passthrough**: `resolve_taxonomy_metadata()` uses `dict(node_cfg)` to forward all raw YAML fields. New fields added to YAML are available in `state["taxonomy_metadata"]` immediately.
- **Startup fail-fast**: Schema validation catches invalid entries before the first request. Orphan detection catches routing YAML that references missing taxonomy keys.
- **Evidence budget control**: Writer trims evidence to prevent token-budget fading. The budget (24k chars default) is set in `config.py`, not per-taxonomy.
- **Epistemic guidance**: 22 high-complexity entries include `epistemic_guidance` to separate facts/assumptions/recommendations. Injected as a dedicated EPISTEMIC DISCIPLINE block in the writer prompt.
- **Critic enforcement**: For domains with complexity >= 0.8, `required_elements` are promoted to soft mandates. The critic flags missing sections as `insufficient_depth`.
- **Code path unchanged**: Taxonomy shapes prompts but the graph structure (Executor → PIG → Critic) is unaffected. Document path gains optional Planner when taxonomy requests deep-dive.

---

## See Also

- [TAXONOMY.md](TAXONOMY.md) — Intent taxonomy, verticals, coverage status
- [TAXONOMY_SHAPING.md](TAXONOMY_SHAPING.md) — Extension points by role, examples
- [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD) — Graph flow, routing, startup compilation details
- `base/planner-ts/src/taxonomy/taxonomy-prompt-factory.ts` — `resolveTaxonomyMetadata`, YAML loading, TTL cache
- `base/planner-ts/tests/taxonomy.test.ts` — schema/behavior coverage
- `base/planner-ts/config/taxonomy_prompt_config.yaml` — 190 taxonomy definitions
