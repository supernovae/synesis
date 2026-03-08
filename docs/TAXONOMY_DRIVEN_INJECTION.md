# Taxonomy-Driven Contextual Injection

How the Router (Entry Classifier) identifies a topic's complexity and uses taxonomy metadata to shape prompts for the Planner and Executor. No new LLM — deterministic lookup from `taxonomy_prompt_config.yaml`.

---

## Overview

| Component | Role |
|-----------|------|
| **Entry Classifier** | Router. Outputs `active_domain_refs`, `task_size`, `intent_class`, `complexity_score`. |
| **TaxonomyResolver** | `resolve_taxonomy_metadata()` — maps domain + task_size to TaxonomyNode. No LLM. |
| **Planner** | Taxonomy-aware. Reads `taxonomy_metadata.required_elements`; injects depth instructions when `complexity > 0.7`. |
| **Executor (Worker)** | Uses `get_executor_depth_block(metadata)` to append depth instructions. |
| **Critic** | For `explain_only` + `taxonomy_metadata` (complexity > 0.6), validates that the response is "science-y" enough: required_elements covered, depth meets complexity. Routes to Supervisor for revision when insufficient. |

---

## TaxonomyNode Schema

```
path: str              # e.g. "Science > Physics"
complexity_score: float # 0.0–1.0 — drives required_bullets, depth_instructions
persona_instructions: str  # Persona label + depth guidance (when complexity > 0.7)
required_bullets: int  # Derived from len(required_elements)
required_elements: list[str]  # e.g. ["Theoretical Basis", "Mathematical Context"]
depth_instructions: str  # Appended to prompt when complexity > 0.7
taxonomy_key: str       # e.g. "physics", "general_greeting"
```

---

## Flow

1. **Entry Classifier** produces `active_domain_refs` (e.g. `["physics"]`), `task_size`, `intent_class`, `complexity_score`.
2. **TaxonomyResolver** looks up first matching domain in `taxonomy_prompt_config.yaml` → TaxonomyNode.
3. **task_size modifier**: `complex` → boost complexity; `trivial` → dampen, cap `required_bullets` at 2.
4. **State** receives `taxonomy_metadata` (TaxonomyNode dict). Flows through all nodes until context pivot.
5. **Document + high-depth**: When `output_type=document` and domain in `deep_dive_domains` and `complexity > 0.6` → `plan_required=true`. Route to Planner for structured bullets.
6. **Planner** appends `get_planner_system_prompt_append(metadata)` to system prompt (required_elements + depth_instructions).
7. **Worker** appends `get_executor_depth_block(metadata)` when present.
8. **Plan steps stream to UI** via existing SSE status events (main.py emits each step as `status`).
9. **Critic (document path):** When `explain_only` + `taxonomy_metadata`, the critic uses universal principles + taxonomy-as-hints to evaluate whether the response meets required depth. If insufficient → `approved=false` → Supervisor → Worker revision loop.

---

## Example: "What is the speed of light?"

1. Entry Classifier: `knowledge_style` match → `output_type=document`, `intent_class=knowledge`. Domain keywords match "speed of light" / "light" → `active_domain_refs=["physics"]`.
2. TaxonomyResolver: `physics` → TaxonomyNode with `complexity_score=0.9`, `required_elements=[Theoretical Basis, Mathematical Context, Real-world Implications, Historical Context, Key Constants & Formulas]`.
3. `should_plan_for_document(metadata, ["physics"])` → true (physics in deep_dive_domains, complexity > 0.6).
4. `plan_required=true` → route to Planner.
5. Planner: System prompt includes "Your plan MUST include these sections: Theoretical Basis; Mathematical Context; …" + depth_instructions (c, relativity).
6. Planner produces 5 steps; each step streams as status to Open WebUI.
7. Worker: Receives execution_plan; appends taxonomy depth block. Produces markdown structured by the plan.
8. Patch Integrity Gate: explain_only + taxonomy complexity > 0.6 → route to Critic (not Respond).
9. Critic: Validates response covers required_elements (Theoretical Basis, Mathematical Context, etc.) and scientific rigor. If insufficient → revision loop; else → Respond.

---

## Config: taxonomy_prompt_config.yaml

**Location:** `base/planner/taxonomy_prompt_config.yaml`

**Schema per taxonomy key:**

```yaml
physics:
  path: "Science > Physics"
  complexity: 0.9
  persona: "Academic Researcher"
  depth_instructions: "Provide a response with scientific rigor. Mention c as a constant..."
  required_elements:
    - "Theoretical Basis"
    - "Mathematical Context"
    - "Real-world Implications"
    - "Historical Context"
    - "Key Constants & Formulas"

# Deep-dive domains: document questions in these get plan_required=true
deep_dive_domains:
  - physics
  - astronomy
  - mathematics
  - chemistry
  - bioinformatics
```

**Keys** align with `active_domain_refs` from Entry Classifier (e.g. `physics`, `astronomy`). Add domain keywords in plugins (`vertical_scientific.yaml`, etc.) so queries like "speed of light" match `physics`.

---

## Adding a New Taxonomy

1. Add `domain_keywords.<key>` in a plugin (e.g. `vertical_scientific.yaml`) so Entry Classifier produces the key in `active_domain_refs`.
2. Add the key and schema to `taxonomy_prompt_config.yaml`.
3. Optionally add to `deep_dive_domains` if knowledge questions in that domain should use Planner for structured bullets.

---

## Design Decisions

- **No new LLM**: TaxonomyResolver is deterministic lookup. Entry Classifier (YAML scoring) + config = fast.
- **Router sets "Vibe" and "Depth"** before heavy lifting. Planner plans to the budget; Executor writes to the outline.
- **taxonomy_metadata** persists until context pivot (language/domain switch). Single source for depth/persona.
- **Code path** survives: taxonomy shapes prompts but code decomposition (Planner) and execution (Worker) remain unchanged. Document path gains optional Planner when taxonomy requests deep-dive.

---

## See Also

- [TAXONOMY.md](TAXONOMY.md) — Intent taxonomy, verticals, document vs code
- [WORKFLOW.md](WORKFLOW.md) — Graph flow, routing
- [nodes.md](nodes.md) — Node prompts, Taxonomy-Driven Injection references
- `base/planner/app/taxonomy_prompt_factory.py` — `resolve_taxonomy_metadata`, `get_planner_system_prompt_append`, `get_executor_depth_block`, `should_plan_for_document`
- `base/planner/taxonomy_prompt_config.yaml` — Taxonomy definitions
