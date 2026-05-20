# Synesis Taxonomy & Prompt Shaping Guide

## Overview

Synesis uses YAML-driven configuration to shape how each model role behaves,
without requiring code changes. The prompt architecture follows this principle:

- **Hardcoded prompts** are minimal role descriptions (~5 lines) that define
  *what* each model does (route, plan, generate, critique)
- **YAML configuration** provides all domain-specific, intent-specific, and
  vertical-specific customization that defines *how* each model behaves in
  context

This document maps every extension point to its YAML file so you can build
custom configurations (safety-critical systems, educational platforms, domain
experts) by editing YAML alone.

> **planner-ts v1 note:** The active runtime (`base/planner-ts/`) implements
> entry classification via the `ScoringEngine` with embedded weights from
> `intent_weights.yaml`. Full L2 taxonomy resolution (runtime YAML compilation,
> `TaxonomyPromptFactory`, Pydantic validation) is tracked as a parity item in
> [development/chat-planner-ts-feature-tracker.md](development/chat-planner-ts-feature-tracker.md).
> The YAML schema and extension points documented below remain the target
> contract for both runtimes.

## Architecture

```
YAML Layer                    Factory Layer              Model Roles
─────────────                 ─────────────              ───────────
entry_classifier_weights ──→  ScoringEngine         ──→  EntryClassifier
intent_weights.yaml      ──→  (deterministic)            (no LLM)
                                    │
                                    ▼
taxonomy_prompt_config   ──→  TaxonomyPromptFactory ──→  Router (Qwen2.5-14B)
intent_prompts.yaml      ──→  (deterministic lookup)     Planner (router model)
vertical_*.yaml plugins  ──→                             Writer
                                                         Critic (R1)
```

The `TaxonomyPromptFactory` resolves domain metadata once per request and
injects it into each node's prompt. No additional LLM calls are needed for
this injection.

## Extension Points by Role

### Query Normalizer (deterministic, no LLM)

Runs **before** the EntryClassifier. Corrects typos using a domain
lexicon compiled from `intent_weights.yaml` and `taxonomy_prompt_config.yaml`
at startup. Protected tokens (code identifiers, URLs, versions, jargon)
are never corrected.

| What to change | File | Key |
|---|---|---|
| Extra jargon (never correct) | `query_normalizer_config.yaml` | `extra_jargon` |
| Extra protected patterns | `query_normalizer_config.yaml` | `extra_protected_patterns` |
| Enable/disable | planner config | `query_normalizer_enabled` |
| Confidence threshold | planner config | `query_normalizer_confidence_threshold` |
| Search both original + corrected | planner config | `query_normalizer_search_both` |

The normalizer enriches domain coverage automatically: adding new
`domain_keywords` or `query_expansion_hints` to taxonomy/intent configs
grows the correction lexicon at next startup.

### EntryClassifier (deterministic, no LLM)

The EntryClassifier runs first on every request (after query normalization).
It produces the `IntentEnvelope` that drives all downstream routing.

| What to change | File | Key |
|---|---|---|
| Difficulty scoring keywords | `entry_classifier_weights.yaml` | `complexity_weights`, `risk_weights` |
| Domain detection | `intent_weights.yaml` | `domain_keywords` |
| Keyword pairings (compound complexity) | vertical plugins | `pairings` |
| Routing thresholds | `intent_weights.yaml` | `routing_thresholds.plan_required_above` (all requests go through Router) |

**Example**: Make all Kubernetes tasks route through the Planner:

```yaml
# intent_weights.yaml
routing_thresholds:
  plan_required_above: 0.5   # lower threshold → more tasks hit Planner
```

### Router (Qwen2.5-14B)

The Router returns a minimal `RouterDecision` JSON:

```json
{"route": "executor|planner|respond", "rag_mode": "disabled|light|normal", "reasoning": "..."}
```

The Router prompt is intentionally static and minimal. **To change routing
behavior, tune the scoring thresholds in YAML, not the prompt.** All requests
go through the Router; routing is based on task complexity from EntryClassifier.

### Router (Retrieval Enrichment)

The Router uses taxonomy metadata to enrich retrieval queries and steer
web search toward authoritative sources.

| What to change | File | Key |
|---|---|---|
| Query expansion terms (ADR, RFC, etc.) | `taxonomy_prompt_config.yaml` | `query_expansion_hints` |
| Preferred web search scopes | `taxonomy_prompt_config.yaml` | `preferred_web_scopes` |

**Example**: Software architecture queries automatically expand with terms like
"ADR", "architecture decision record", "tradeoff analysis" and steer web search
toward `site:martinfowler.com` and `site:microservices.io`.

### Writer (Style-Driven Generation)

The Writer uses taxonomy metadata to shape output format, structure, and epistemic discipline.
Three taxonomy blocks are injected into the system prompt:

1. **DOMAIN DEPTH** (from `depth_instructions`) — when complexity > 0.55
2. **OUTPUT STYLE** (from `output_style_guidance`) — always when present
3. **EPISTEMIC DISCIPLINE** (from `epistemic_guidance`) — always when present

Evidence is trimmed to `evidence_budget_chars` (default 24,000) before injection
to prevent token-budget fading in long responses.

| What to change | File | Key |
|---|---|---|
| Output document style | `taxonomy_prompt_config.yaml` | `output_style` |
| Output structure guidance | `taxonomy_prompt_config.yaml` | `output_style_guidance` |
| Domain tone/persona | `taxonomy_prompt_config.yaml` | `worker_explain_tone` |
| Depth instructions | `taxonomy_prompt_config.yaml` | `depth_instructions` |
| Epistemic discipline | `taxonomy_prompt_config.yaml` | `epistemic_guidance` |
| Discovery/enrichment prompts | `taxonomy_prompt_config.yaml` | `discovery_prompt` (scoped to cohesion entity when lock active) |
| Domain coverage checklist | `taxonomy_prompt_config.yaml` | `required_elements` (secondary to Document Outline) |
| Evidence budget | planner config | `evidence_budget_chars` (default 24000, capped relative to `compiler_model_context`) |
| Vertical-specific persona block | vertical plugins | `vertical_prompt.executor_persona_block` |

**Example**: When the domain is `software_architecture`, the Writer receives
`output_style_guidance` that says "Structure like a technical architecture
document: design goals, components, technology choices with rationale, implementation
path, key risks." It also receives `epistemic_guidance` that says "Separate
established patterns from assumptions and recommendations." This produces
ADR-shaped output with clear epistemic framing.

### Executor (General model: Qwen3-32B FP8)

The Executor generates code responses. Its prompt is shaped by taxonomy
metadata injected from YAML.

| What to change | File | Key |
|---|---|---|
| Domain tone/persona | `taxonomy_prompt_config.yaml` | `worker_explain_tone` |
| Persona label | `taxonomy_prompt_config.yaml` | `persona` |
| Depth instructions | `taxonomy_prompt_config.yaml` | `depth_instructions` |
| Domain coverage checklist | `taxonomy_prompt_config.yaml` | `required_elements` (secondary to Document Outline) |
| Discovery/enrichment prompts | `taxonomy_prompt_config.yaml` | `discovery_prompt` (scoped to cohesion entity when lock active) |
| Vertical-specific persona block | vertical plugins | `vertical_prompt.executor_persona_block` |

**Example**: Add a cybersecurity domain with strict output requirements:

```yaml
# taxonomy_prompt_config.yaml
cybersecurity:
  path: "Engineering > Cybersecurity"
  complexity: 0.9
  persona: "Security Engineer"
  worker_explain_tone: "You are a cybersecurity analyst. Prioritize defense-in-depth and assume breach."
  depth_instructions: "Cite CVEs and CWEs where applicable. Reference NIST/OWASP frameworks."
  discovery_prompt: "End with a brief note on related attack surfaces or emerging threats."
  required_elements:
    - "Threat Model"
    - "Attack Vectors"
    - "Mitigations"
    - "Detection Strategy"
```

### Planner (Router model)

The Planner decomposes tasks into atomic, verifiable steps. Its prompt is
shaped by taxonomy metadata and vertical decomposition rules.

| What to change | File | Key |
|---|---|---|
| Required plan sections | `taxonomy_prompt_config.yaml` | `required_elements` |
| Domain decomposition rules | vertical plugins | `vertical_prompt.planner_decomposition_rules` |
| Domain decomposition rules (fallback) | `taxonomy_prompt_config.yaml` | `planner_decomposition_rules` |

**Example**: Add protocol-specific planning rules:

```yaml
# taxonomy_prompt_config.yaml
protocols:
  planner_decomposition_rules: |
    For protocol tasks (ActivityPub, OAuth, SAML):
    - FIRST step = discovery/handshake only.
    - Each step must verify protocol compliance before proceeding.
```

### Critic (DeepSeek R1)

The Critic has the richest YAML shaping with three independent layers
that compose together:

**Layer 1: Intent overlays** (orthogonal to domain)

| What to change | File | Key |
|---|---|---|
| Per-intent review behavior | `intent_prompts.yaml` | `intent_classes.<name>.critic_behavior_block` |

Available intents: `knowledge`, `writing`, `code`, `debugging`, `review`,
`planning`, `data_transform`, `tool_orchestrated`, `personal_guidance`,
`creative_ideation`.

**Layer 2: Vertical tiered review** (domain-specific)

| What to change | File | Key |
|---|---|---|
| Critic mode | vertical plugins | `vertical_prompt.critic_mode` |
| Tiered prompts | vertical plugins | `vertical_prompt.critic_tiers.{basic,advanced,research}` |

Modes: `safety_ii` (full evidence-gated), `tiered` (basic/advanced/research
by difficulty), `advisory` (gentle, nonblocking).

**Layer 3: Taxonomy depth validation** (automatic)

When `taxonomy_prompt_config.yaml` defines `required_elements` and
`complexity > 0.6` for a domain, the Critic automatically validates that
the Executor's response covers those elements. No additional YAML needed.

**Layer 4: Thinking budget** (code-controlled)

R1 thinking tokens scale with `task_size`: easy=256, medium=1024, hard=2048.
This is set in code (planner-ts: `critic-evaluator.ts`; Python legacy: `critic.py`) and maps
from the YAML-driven difficulty score.

## How to Add a New Domain

1. Add a domain key to `taxonomy_prompt_config.yaml`:

```yaml
your_domain:
  path: "Category > Your Domain"
  complexity: 0.7
  persona: "Domain Expert"
  worker_explain_tone: "You are a domain expert. ..."
  depth_instructions: "..."
  required_elements:
    - "Section 1"
    - "Section 2"
  query_expansion_hints:       # Terms to expand retrieval queries with
    - "related term 1"
    - "related term 2"
  preferred_web_scopes:        # Steer web search to authoritative sites
    - "site:example.com"
  output_style: "domain_doc"   # Short label for the output format
  output_style_guidance: >-    # Injected into writer as OUTPUT STYLE block
    Structure the response as a domain document with specific
    formatting and section requirements.
  epistemic_guidance: >-       # Injected into writer as EPISTEMIC DISCIPLINE block
    Separate established patterns from assumptions. Note when
    recommendations are opinion vs evidence-backed.
  planner_decomposition_rules: >-  # Domain-specific planning rules
    For this domain: first step is always X.
```

**Minimum valid entry** (only `path` and `complexity` are required):

```yaml
your_domain:
  path: "Category > Your Domain"
  complexity: 0.6
```

All raw YAML fields are forwarded to `taxonomy_metadata` automatically.
The taxonomy linter validates entries at startup — no manual verification needed.

2. Add keywords to `intent_weights.yaml` so EntryClassifier detects it:

```yaml
domain_keywords:
  your_domain:
    domain: your_domain
    keywords:
      - keyword1
      - keyword2
```

3. (Optional) For advanced customization, create a vertical plugin at
   `plugins/weights/vertical_your_domain.yaml` with `vertical_prompt`:

```yaml
vertical_prompt:
  name: your_domain
  active_domain_refs:
    - your_domain
  executor_persona_block: |
    VERTICAL: Your Domain. Specific instructions here.
  planner_decomposition_rules: |
    Domain-specific step rules.
  critic_mode: tiered
  critic_tiers:
    basic: |
      Approve if correct. Brief check.
    advanced: |
      Full review with domain-specific checks.
    research: |
      Deep analysis with edge cases.
```

## Config Pattern: Building a Safety-Critical System

The JCS (Joint Cognitive System) pattern that was previously hardcoded
can now be implemented entirely through YAML configuration. Here is how
to compose the layers:

### Example: Safety-Critical Industrial Configuration

**Goal**: All industrial/SCADA tasks get full evidence-gated review,
mandatory planning, and strict output requirements.

**Step 1**: High risk weights trigger `hard` task_size

```yaml
# plugins/weights/vertical_industrial.yaml
risk_weights:
  safety_critical:
    weight: 25
    keywords:
      - scada
      - plc
      - safety instrumented
      - iec 61508
      - sil rating
```

**Step 2**: Vertical prompt with safety_ii critic mode

```yaml
# plugins/weights/vertical_industrial.yaml
vertical_prompt:
  name: industrial
  active_domain_refs:
    - industrial
    - manufacturing
  critic_mode: safety_ii
  executor_persona_block: |
    VERTICAL: Industrial/SCADA. IEC 61508 compliance required.
    - All code MUST handle fail-safe states explicitly.
    - No silent error swallowing in control loops.
  planner_decomposition_rules: |
    Safety-critical: Each step must include a rollback/fail-safe verification.
    First step is always: identify safety boundaries and interlocks.
  critic_tiers:
    basic: |
      Check: fail-safe handling, no unbounded loops, error propagation.
    advanced: |
      Full IEC 61508 review: SIL classification, diagnostic coverage,
      common cause failure analysis. Block on missing safety boundaries.
    research: |
      Architecture-level: redundancy patterns, watchdog timers, graceful
      degradation. Cite relevant standards sections.
```

**Step 3**: Taxonomy depth validation

```yaml
# taxonomy_prompt_config.yaml
industrial:
  path: "Engineering > Industrial"
  complexity: 0.95
  persona: "Safety Engineer"
  worker_explain_tone: "You are an industrial safety engineer. IEC 61508 compliance is mandatory."
  depth_instructions: "All responses must address fail-safe behavior. Cite standards."
  required_elements:
    - "Safety Boundaries"
    - "Fail-Safe Behavior"
    - "Error Handling"
    - "Compliance References"
```

**Step 4**: Intent-level critic overlay

```yaml
# intent_prompts.yaml
intent_classes:
  code:
    critic_behavior_block: ""  # default for code
  # Add a new intent or modify existing:
  safety_review:
    critic_behavior_block: |
      SAFETY GATE: Block on any code path that lacks explicit error handling.
      Block on missing watchdog/timeout. Cite IEC 61508 SIL requirements.
```

**Result**: When a user asks about SCADA programming, the system automatically:
1. EntryClassifier detects `industrial` domain, sets `task_size=hard`
2. Router sends to Planner (hard + plan_required)
3. Planner gets industrial decomposition rules (safety boundaries first)
4. Executor gets safety engineer persona and IEC 61508 depth instructions
5. Critic runs in `safety_ii` mode with full evidence-gated review
6. Critic validates all `required_elements` are covered

No code changes. The same LLM models, the same graph, the same nodes --
just different YAML configuration.

### Example: Educational Platform Configuration

**Goal**: Friendly, pedagogical responses with gentle review and
exploration prompts.

```yaml
# taxonomy_prompt_config.yaml
education_stem:
  path: "Education > STEM"
  complexity: 0.6
  persona: "STEM Tutor"
  worker_explain_tone: "You are a patient STEM tutor. Build understanding step by step."
  depth_instructions: "Use analogies and worked examples. Define jargon before using it."
  discovery_prompt: "End with a 'Try This' exercise the learner can attempt."
  required_elements:
    - "Core Concept"
    - "Worked Example"
    - "Common Misconceptions"
```

```yaml
# plugins/weights/vertical_education.yaml
vertical_prompt:
  name: education
  active_domain_refs:
    - education_stem
    - education_learning
  critic_mode: advisory
  executor_persona_block: |
    VERTICAL: Education. Pedagogy-first.
    - Encourage exploration, never dismiss questions.
    - Include gotchas and trade-offs where relevant.
  critic_tiers:
    basic: |
      Approve if explanation is clear and correct. Note missing analogies.
    advanced: |
      Check: age-appropriate language, scaffolded complexity, no jargon bombs.
```

**Result**: Educational queries get gentle review, exploration prompts,
and pedagogical structure -- all from YAML.

## File Reference

| File | Purpose | Affects |
|---|---|---|
| `entry_classifier_weights.yaml` | Base scoring keywords and thresholds | EntryClassifier |
| `intent_weights.yaml` | Domain keywords, routing thresholds, intent detection | EntryClassifier, Query Normalizer lexicon |
| `taxonomy_prompt_config.yaml` | 190 domain entries (persona, depth, epistemic, output style, planner rules, query hints) | Router, Writer, Planner, Critic, Query Normalizer lexicon |
| `query_normalizer_config.yaml` | Extra jargon, protected patterns for typo correction | Query Normalizer |
| `intent_prompts.yaml` | Intent-specific critic behavior overlays | Critic |
| `plugins/weights/vertical_*.yaml` | 41 vertical plugins (keywords, risk, prompts, critic tiers) | All roles |

**planner-ts implementations:**

| File | Purpose |
|---|---|
| `base/planner-ts/src/nodes/scoring-engine.ts` | YAML-driven `ScoringEngine` (BM25 intent, split-axis scoring) |
| `base/planner-ts/src/nodes/entry-classifier.ts` | Entry classification with difficulty/domain routing |
| `base/planner-ts/src/nodes/critic-evaluator.ts` | Critic thinking budget + quality scoring |
| `base/planner-ts/src/nodes/writer-compose.ts` | Writer with taxonomy-shaped prompts |

**Python planner (legacy reference — being removed):**

| File | Purpose |
|---|---|
| `base/planner-ts/config/query_normalizer_config.yaml` | Deterministic typo/protected-token source config |
| `base/planner-ts/tests/taxonomy.test.ts` | Taxonomy validation coverage |
| `base/planner-ts/src/taxonomy/taxonomy-prompt-factory.ts` | Taxonomy resolver — cached YAML load, all fields forwarded |

## Precedence

When multiple YAML sources provide the same field:

1. Vertical plugin (`vertical_*.yaml`) takes precedence
2. `taxonomy_prompt_config.yaml` is the fallback
3. `intent_prompts.yaml` is additive (critic overlays compose with domain)

The intent overlay and domain vertical are orthogonal: a `knowledge` intent
in the `industrial` domain gets both the hallucination-sensitive critic
behavior AND the industrial safety checks.
