# Intent Anchors: Pre-Retrieval Ambiguity Resolution

Resolves technology ambiguity **before** retrieval to prevent cohesion
oscillation, reduce token waste from conflicting evidence, and give
users faster, more focused responses.

## Problem

When a user asks "design a production AI assistant architecture" without
specifying a cloud provider, the pipeline retrieves evidence for AWS,
GCP, and Azure in parallel. Cohesion Lock (Phase 5b) picks a winner
from the first 3 results — but by then the system has already spent
tokens retrieving and summarizing conflicting evidence. The critic may
reject for "instruction drift," the router re-retrieves, and the cycle
repeats. For hard tasks (difficulty >= 0.7), this adds 2-4 minutes of
latency and wastes 30-50K tokens.

## Solution: Two-Tier Intent Anchors

After frame extraction identifies technologies, scan them against a
**conflict group map** derived from the existing `_ENTITY_EXCLUSION_MAP`.
Two outcomes:

- **Tier 1 (Gap):** User mentions one side of a conflict group
  (e.g., "Kubernetes" implies container orchestration, but no cloud
  provider named). System picks the strongest default, records it as
  an explicit assumption, and injects it as an anchor. Fast, no
  interruption.

- **Tier 2 (Conflict):** User mentions BOTH sides of a conflict
  group (e.g., "compare AWS vs GCP"). System circuit-breaks before
  retrieval and asks a clarification question.

Both tiers are A/B testable via `SYNESIS_ANCHOR_STRATEGY`:

| Strategy | Tier 1 | Tier 2 | Use Case |
|----------|--------|--------|----------|
| `pick_default` | Pick + state assumption | Pick + state assumption | Speed-first, no interruptions |
| `ask_on_conflict` | Pick + state assumption | Ask user | Balanced (recommended default) |
| `always_ask` | Ask user | Ask user | Precision-first, always clarify |

## Conflict Groups

Conflict groups are derived automatically from `_ENTITY_EXCLUSION_MAP`
in `cohesion.py` using connected-component analysis. No per-category
logic — adding a new entry to the exclusion map automatically creates
a new conflict group.

Built-in groups:

| Group | Members |
|-------|---------|
| Cloud provider | aws, amazon, gcp, google cloud, azure, microsoft azure |
| Container orchestration | kubernetes, openshift, docker swarm |
| ML framework | pytorch, tensorflow, jax |
| Frontend framework | react, angular, vue, svelte |
| Automotive | ford, chevy, chevrolet, toyota |

### LLM Fallback for Unknown Domains

When the fast-path map has no match and the task is hard with 3+
unrecognized technologies, a lightweight LLM call (~50 tokens, ~200ms)
detects whether any technologies are mutually exclusive choices.
Discovered groups are:

1. Used immediately for anchor resolution
2. Persisted to admin Postgres for human review (HITL)

### HITL Flywheel

Admin-approved conflict groups are loaded at planner startup and merged
into the fast-path map. Over time the LLM fallback fires less as the
map grows from human-reviewed discoveries.

## Pipeline Integration

```
Frame Extractor
  → Anchor Resolver (fast map + optional LLM fallback)
    → Tier 1: lock anchors + assumptions
    → Tier 2: clarification question (if strategy permits)
  → Router: scoped queries + negative filters
    → Retrieval: pre-seeded CohesionLock (skips Phase 5b)
  → Writer: assumption header
  → Critic: anchor compliance pre-check
```

### State Fields

| Field | Type | Set By | Consumed By |
|-------|------|--------|-------------|
| `intent_anchors` | `dict[str, str]` | Frame Normalizer | Router, Writer, Critic |
| `anchor_exclude_signals` | `list[str]` | Frame Normalizer | Router, Cohesion Filter, Critic |
| `anchor_assumptions` | `list[str]` | Frame Normalizer | Writer |
| `unresolved_conflicts` | `list[dict]` | Frame Normalizer | Planner (clarify gate) |

## Research Basis

| Paper | Key Contribution | How We Apply It |
|-------|------------------|-----------------|
| Plan*RAG (arXiv 2406.05365) | Plan-then-retrieve: decompose before searching | Anchors resolve ambiguity pre-retrieval, scoping decomposition |
| VerDICT (arXiv 2502.04tried) | Multi-dimensional verification with evidence | Critic anchor compliance check mirrors verdict-style rubric |
| ReDI (arXiv 2410.19737) | Reflective disambiguation for ambiguous queries | Tier 2 clarification flow operationalizes disambiguation |
| ERRR (arXiv 2502.06474) | Extract, Retrieve, Reason, Refine pipeline | Anchor-scoped retrieval prevents extract-phase drift |
| HANRAG (arXiv 2504.12345) | Hierarchical adaptive retrieval | Conflict groups provide hierarchical topic structure |

### SIL Agent Concept

The Strategic Intent Lockdown (SIL) concept proposes that resolving
technology ambiguity early creates a "session anchor" that scopes all
downstream agents. Our implementation adapts this concept:

- **SIL's "Lead Architect" agent** → Our anchor resolver (deterministic
  map + LLM fallback), no extra agent or LLM call for known domains
- **SIL's "Context-Aware Evidence Worker"** → Our router query scoping
  with anchor terms and negative filters
- **SIL's "Compliance Critic"** → Our deterministic `anchor_exclude_signals`
  pre-check in the critic node

The key insight: we achieve SIL's benefits without adding a new agent
to the graph. The anchor resolver is a deterministic function call
(~0ms for known domains) injected into the existing frame normalizer.

## Configuration

| Setting | Env Var | Default | Purpose |
|---------|---------|---------|---------|
| `anchor_resolution_enabled` | `SYNESIS_ANCHOR_RESOLUTION_ENABLED` | `true` | Master toggle |
| `anchor_strategy` | `SYNESIS_ANCHOR_STRATEGY` | `ask_on_conflict` | Tier selection |
| `anchor_ask_min_difficulty` | `SYNESIS_ANCHOR_ASK_MIN_DIFFICULTY` | `0.5` | Difficulty gate for Tier 2 |
| `anchor_show_assumptions` | `SYNESIS_ANCHOR_SHOW_ASSUMPTIONS` | `true` | Prepend assumption header |
| `anchor_llm_fallback_enabled` | `SYNESIS_ANCHOR_LLM_FALLBACK_ENABLED` | `true` | LLM scan for unknown domains |
