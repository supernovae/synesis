# Retrieval Modes

Synesis supports three retrieval modes that control **when** RAG evidence is gathered relative to the planner. The mode is visible in every trace for feedback-driven tuning.

## Modes

### Router (Pre-Hydration)

```
Entry Classifier → Router → Planner → Writer/Executor
```

The router gathers evidence **before** the planner runs. The planner receives pre-hydrated context and plans with evidence already available.

| Aspect | Detail |
|---|---|
| **Best for** | Simple/low-complexity tasks, FAQ, quick lookups |
| **Tradeoff** | Fast (single router pass), but evidence is a broad guess — planner can't influence what's retrieved |
| **When auto selects** | `difficulty < 0.3` |

### Hybrid (Router + Planner)

```
Entry Classifier → Router → Planner → Router (section_evidence) → Writer/Executor
```

The router pre-hydrates global context, then the planner produces targeted evidence requests. A second router pass fulfills those requests.

| Aspect | Detail |
|---|---|
| **Best for** | Medium-complexity tasks where broad context helps but specific evidence is also needed |
| **Tradeoff** | Balanced latency vs. precision; two router passes |
| **When auto selects** | `0.3 ≤ difficulty < 0.7` |

### Planner-Driven

```
Entry Classifier → Planner → Router (section_evidence) → Writer/Executor
```

The planner runs **first** with no initial evidence and explicitly requests what it needs. The router then retrieves targeted, plan-specific evidence.

| Aspect | Detail |
|---|---|
| **Best for** | Complex/correctness-critical tasks where the planner should drive evidence strategy |
| **Tradeoff** | Higher latency (planner runs without context), but evidence is precisely targeted to the plan |
| **When auto selects** | `difficulty ≥ 0.7` |

## Configuration

### Environment Variable

```yaml
SYNESIS_RETRIEVAL_MODE: "auto"  # auto | planner | router | hybrid
```

### Auto Mode Thresholds

When `retrieval_mode=auto` (default), the entry classifier resolves the effective mode based on difficulty:

```yaml
SYNESIS_RETRIEVAL_MODE_PLANNER_THRESHOLD: "0.7"  # difficulty >= this → planner
SYNESIS_RETRIEVAL_MODE_HYBRID_THRESHOLD: "0.3"    # difficulty >= this → hybrid (below → router)
```

Override these to tune the auto-selection boundaries.

### Trivial Tasks

Tasks classified as trivial (`difficulty < 0.15`) or with `rag_mode=disabled` always use `router` mode (which short-circuits to no retrieval). The retrieval mode only affects tasks that actually perform RAG.

## How It Works

### Auto Mode Resolution (Entry Classifier)

```
difficulty < hybrid_threshold (0.3)   → "router"
difficulty < planner_threshold (0.7)  → "hybrid"
difficulty >= planner_threshold (0.7) → "planner"
```

The resolved mode is stored in `GraphState.retrieval_mode` and flows through the entire pipeline.

### Graph Routing Changes

**`route_after_entry_pipeline`**: When mode is `"planner"`, routes directly to the planner node, skipping the initial router pass.

**`route_after_planner`**: When mode is `"planner"`, always routes to the router (for section_evidence) since the planner had no initial evidence.

**`_decide_next_node` (Router)**: After section_evidence in planner mode, routes to writer/executor as normal since the execution_plan is already set.

### Planner Prompt Adaptation

In planner mode with no evidence, a `<retrieval_mode>planner-driven</retrieval_mode>` directive is injected, instructing the planner to produce precise evidence requests per plan step.

## Observability

### Trace Visibility

Every trace records the **effective** `retrieval_mode`:
- Visible as an emerald badge in the trace detail header
- Appears alongside task_type, domain_tags, and other classification metadata
- Stored in the `full_record` JSON for querying

### Structured Logging

The `request_feedback` log and `entry_classifier_result` log both include `retrieval_mode` and `retrieval_mode_config` (the configured value before auto-resolution).

### Feedback Loop

Use traces to compare outcomes across modes:
1. Filter traces by retrieval mode in the admin UI
2. Compare critic scores, evidence packet counts, and avg_evidence_confidence
3. Adjust `SYNESIS_RETRIEVAL_MODE_PLANNER_THRESHOLD` and `SYNESIS_RETRIEVAL_MODE_HYBRID_THRESHOLD` based on observed patterns
4. If a specific mode consistently outperforms, set it as the fixed default

## Interaction with Other Settings

| Setting | Interaction |
|---|---|
| `rag_mode` | When `disabled`, retrieval_mode is forced to `router` (no-op fast path) |
| `task_is_trivial` | Trivial tasks bypass both router and planner regardless of retrieval_mode |
| `skip_section_evidence_when_sufficient` | In hybrid/router mode, strong initial evidence can skip the second router pass. In planner mode, section_evidence always runs. |
| `evidence_sufficiency_*` | Only checked in hybrid/router mode; planner mode bypasses the sufficiency check |
| `critic_background` | Unaffected — critic runs independently of retrieval mode |
