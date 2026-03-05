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

## Architecture

```
YAML Layer                    Factory Layer              Model Roles
─────────────                 ─────────────              ───────────
entry_classifier_weights ──→  ScoringEngine         ──→  EntryClassifier
intent_weights.yaml      ──→  (deterministic)            (no LLM)
                                    │
                                    ▼
taxonomy_prompt_config   ──→  TaxonomyPromptFactory ──→  Router (Qwen3-8B)
intent_prompts.yaml      ──→  (deterministic lookup)     Planner (router model)
vertical_*.yaml plugins  ──→                             Worker (general model)
                                                         Critic (R1)
```

The `TaxonomyPromptFactory` resolves domain metadata once per request and
injects it into each node's prompt. No additional LLM calls are needed for
this injection.

## Extension Points by Role

### EntryClassifier (deterministic, no LLM)

The EntryClassifier runs first on every request. It produces the
`IntentEnvelope` that drives all downstream routing.

| What to change | File | Key |
|---|---|---|
| Difficulty scoring keywords | `entry_classifier_weights.yaml` | `complexity_weights`, `risk_weights` |
| Domain detection | `intent_weights.yaml` | `domain_keywords` |
| Keyword pairings (compound complexity) | vertical plugins | `pairings` |
| Routing thresholds | `intent_weights.yaml` | `routing_thresholds.bypass_supervisor_below`, `plan_required_above` |

**Example**: Make all Kubernetes tasks route through the Planner:

```yaml
# intent_weights.yaml
routing_thresholds:
  plan_required_above: 0.5   # lower threshold → more tasks hit Planner
```

### Router (Qwen3-8B)

The Router returns a minimal `RouterDecision` JSON:

```json
{"route": "worker|planner|respond", "rag_mode": "disabled|light|normal", "reasoning": "..."}
```

The Router prompt is intentionally static and minimal. **To change routing
behavior, tune the scoring thresholds in YAML, not the prompt.** The Router
only fires when EntryClassifier doesn't bypass it (easy tasks and
knowledge queries skip the Router entirely).

### Worker (General model: Qwen3.5-35B-A3B)

The Worker generates the actual response. Its prompt is shaped by taxonomy
metadata injected from YAML.

| What to change | File | Key |
|---|---|---|
| Domain tone/persona | `taxonomy_prompt_config.yaml` | `worker_explain_tone` |
| Persona label | `taxonomy_prompt_config.yaml` | `persona` |
| Depth instructions | `taxonomy_prompt_config.yaml` | `depth_instructions` |
| Required output sections | `taxonomy_prompt_config.yaml` | `required_elements` |
| Discovery/enrichment prompts | `taxonomy_prompt_config.yaml` | `discovery_prompt` |
| Vertical-specific persona block | vertical plugins | `vertical_prompt.worker_persona_block` |

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
the Worker's response covers those elements. No additional YAML needed.

**Layer 4: Thinking budget** (code-controlled)

R1 thinking tokens scale with `task_size`: easy=256, medium=1024, hard=2048.
This is set in code (`_CRITIC_THINKING_BUDGETS` in `critic.py`) and maps
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
```

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
  worker_persona_block: |
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
  worker_persona_block: |
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
4. Worker gets safety engineer persona and IEC 61508 depth instructions
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
  worker_persona_block: |
    VERTICAL: Education. Pedagogy-first.
    - Always include a Learner's Corner with pattern, why, and trade-off.
    - Encourage exploration, never dismiss questions.
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
| `intent_weights.yaml` | Domain keywords, routing thresholds, intent detection | EntryClassifier |
| `taxonomy_prompt_config.yaml` | Domain metadata (tone, depth, elements, persona) | Worker, Planner, Critic |
| `intent_prompts.yaml` | Intent-specific critic behavior overlays | Critic |
| `plugins/weights/vertical_*.yaml` | Vertical plugins (keywords, risk, prompts, critic tiers) | All roles |

## Precedence

When multiple YAML sources provide the same field:

1. Vertical plugin (`vertical_*.yaml`) takes precedence
2. `taxonomy_prompt_config.yaml` is the fallback
3. `intent_prompts.yaml` is additive (critic overlays compose with domain)

The intent overlay and domain vertical are orthogonal: a `knowledge` intent
in the `industrial` domain gets both the hallucination-sensitive critic
behavior AND the industrial safety checks.
