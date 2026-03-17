# Synesis User Guide

How to get the behavior you want. Synesis uses a deterministic EntryClassifier before any LLM — your wording drives routing, depth, and modes. If the judgement layer misclassifies, you can override with explicit triggers.

**Scaling:** Complexity detection is driven by `intent_weights.yaml` (or `entry_classifier_weights.yaml`). Config uses split axes: **complexity** (steps/scope), **risk** (destructive, secrets), **domain** (k8s, aws — RAG only, never escalates). Domain vocabulary like "kubectl" stays trivial; risk words like "delete database" escalate.

---

## Quick Reference: Trigger Words

| What you want | Say this |
|---------------|----------|
| **Force full path** (see Router + Planner even for trivial tasks) | `[STRICT]`, `/plan`, `/manual`, `/strict` at start of message |
| **Full planning / JCS prompt** (step-by-step breakdown, defensive code) | `@plan`, `plan first`, `break it down`, `I need a plan`, `step-by-step plan` |
| **Explanations** (explain-only path, no code) | `explain`, `how does it work`, `why`, `I'm learning`, `walk me through` |
| **Fast path** (trivial → straight to Executor) | `hello world`, `print X`, `basic unit test`, `parse json`, `simple fizzbuzz` |
| **Complex / escalation** (Router may ask, Planner runs) | `deploy`, `architecture`, `design`, `migrate`, `security`, `credentials`, `connect to AWS` |

---

## 1. Task Size and Routing

Synesis classifies your request into three tiers before any LLM runs:

| Tier | Path | When |
|------|------|------|
| **Trivial** | EntryClassifier → Writer → Scrubber → Respond | Regex matches (hello world, print X, basic unit test, parse json, fizzbuzz, etc.) |
| **Small** | EntryClassifier → **Router** → Writer → … | Default when not trivial or complex |
| **Complex** | EntryClassifier → **Router** → Planner → Writer → Critic → … | Matches: deploy, architecture, design, migrate, security, credentials, whole repo |

> **Note:** Code generation and editing is handled by the **Coder front door**
> (Qwen Coder via LiteLLM → IDE coding agents). The planner pipeline focuses on
> knowledge synthesis and can include code snippets in fenced markdown blocks.

**Trivial** gets minimal context from Router. **Small** and **Complex** run through the Router, which may suggest planning or ask clarification (within budget).

---

## 2. Plan Session

**Problem:** You want to see a structured plan and approve it before execution — even for tasks the system considers trivial.

**Solution:** Use any of these triggers:

- `[STRICT]`, `/plan`, `/manual`, `/strict` (prefix)
- `@plan`, `plan first`, `I need a plan`
- `break it down`, `break this down`, `step-by-step plan`
- `execution plan`, `full planning`, `scope:`

**Examples:**

```
/plan Create a simple script that prints "Hello"
```

```
plan first: write a hello script
```

**Effect:** Routes to the Planner node regardless of task complexity. You see a structured plan and are asked to approve before execution proceeds to the Executor.

---

## 4. Explanations and Educational Content

When you want an explanation rather than code, use natural language:

- `explain`, `how does it work`, `why did`, `why would`
- `walk me through`, `what does this do`, `can you explain`

**Effect:** The system routes to the explain-only path (`is_code_task=false`), producing
well-structured markdown with taxonomy-driven depth and tone. Domain-specific taxonomy
prompts enrich responses with gotchas, trade-offs, and discovery prompts where appropriate.

### Domain Vertical Coverage

The taxonomy currently covers 190 domain entries across these high-impact verticals:

| Cluster | Example Domains | What You Get |
|---------|----------------|--------------|
| **Software Engineering** | `software_architecture`, `api_design`, `testing_strategy`, `debugging`, `code_review`, `system_design`, `web_backend`, `web_frontend` | Architecture docs, API design rationale, test pyramid guidance, systematic debugging, constructive review feedback |
| **Platform / Cloud** | `kubernetes`, `terraform`, `devops`, `ci_cd`, `sre`, `cost_optimization`, `observability`, `aws`, `gcp`, `azure` | Platform guides with YAML snippets, pipeline design, SLO frameworks, FinOps analysis |
| **Data / AI** | `ai_ml`, `llm_rag`, `llm_evaluation`, `data_engineering`, `model_serving`, `ai_guardrails`, `data_science`, `ml_ops` | Pipeline architecture, serving optimization, guardrail design, evaluation frameworks |
| **Product / Operations** | `product_planning`, `incident_postmortem`, `runbook`, `decision_memo`, `project_management`, `stakeholder_comms` | PRDs, blameless postmortems, operational runbooks, ADRs, stakeholder updates |
| **Programming Languages** | `python`, `javascript`, `typescript`, `golang`, `rust`, `java`, `csharp`, `ruby`, `php`, `scala`, `elixir`, `haskell`, `perl`, `lua` | Idiomatic code with error handling, testing, and language-specific tips |
| **Writing / Communication** | `business_writing`, `technical_writing`, `summarization`, `translation`, `creative_writing` | Audience-matched drafts, docs-as-code, concise summaries |
| **Security / Compliance** | `cybersecurity`, `secops_hardening`, `ai_governance`, `healthcare_compliance`, `fintech_compliance` | Threat models, hardening guides, regulatory mapping |

Each domain entry shapes persona, depth, required sections, epistemic guidance, and web search scopes. The system selects the best-matching domain automatically based on your query.

---

## 5. Language Hints

Synesis infers language from your message. If ambiguous, mention it explicitly:

- `python`, `.py`, `pytest`
- `go`, `golang`, `.go`
- `typescript`, `javascript`, `.js`, `.ts`
- `rust`, `.rs`
- `java`, `.java`
- `bash`, `shell`, `.sh`

---

## 6. Complex Escalation Triggers

These phrases cause **complex** classification (plan_required, Router may ask clarification):

- `deploy`, `architecture`, `design`, `migrate`, `refactor across`
- `security`, `auth`, `payments`, `credentials`
- `connect to AWS`, `connect to GCP`, `connect to S3`
- `whole repo`, `entire codebase`, `add feature … across modules`
- `delete all`, `wipe`, `rotate keys`
- `fix my project`, `make this work` (ambiguous scope)

---

## 7. Trivial Triggers (Fast Path)

These typically use the fast path:

- `hello world`
- `print X`, `print "something"`
- `write a simple script that prints`
- `basic unit test`, `add a unit test for`, `unit test for this function`
- `parse json`, `parse this json`
- `read a file and print`, `read a file and count`
- `simple fizzbuzz`, `fizzbuzz`
- `basic script`, `minimal hello example`
- `create a simple python script that prints`

---

## 8. Knowledge Gaps and Backlog

When RAG retrieval finds no good match (max score < 0.6), Synesis:

- Sets `incomplete_knowledge` and `knowledge_gap_message`
- Publishes the gap to `synesis_knowledge_backlog`
- Respond appends: *"I've flagged this for update."*

### Gap Lifecycle

Knowledge gaps now support a full lifecycle managed from the Admin UI:

| Status | Meaning |
|--------|---------|
| **open** | New gap — retrieval confidence was low, content needed |
| **resolved** | Admin marked the gap as addressed (with optional resolution note) |
| **reopened** | Previously resolved gap that has resurfaced |

Admins can view, filter by status, resolve, reopen, or purge gaps from the **Knowledge Gaps** pages in both the Observability and Feedback sections of synesis-admin.

### Admin Actions

| Action | API | Effect |
|--------|-----|--------|
| Resolve | `POST /admin/observability/knowledge-gaps/{chunk_id}/resolve` | Marks gap as `resolved` with optional note |
| Reopen | `POST /admin/observability/knowledge-gaps/{chunk_id}/reopen` | Returns a resolved gap to `open` status |
| Purge | `DELETE /admin/observability/knowledge-gaps/{chunk_id}` | Permanently deletes the gap record |

Gaps can also be submitted via the planner API or admin form.

### Post-RAG-Load Validation

After loading new content into the RAG corpus, admins can validate whether open gaps are now satisfied:

```
POST /admin/observability/knowledge-gaps/validate
{"score_threshold": 0.6}
```

This re-queries RAG for each open gap and auto-resolves any where the top retrieval score exceeds the threshold. Run it after every indexer pipeline to close the feedback loop.

### Zero-Evidence Behavior

When both RAG and web search return zero results, the system:
- Publishes knowledge gaps for admin review (logged with `reason: "zero_results"`)
- Notifies the user: "No matching documents found -- responding from general knowledge"
- Relaxes the critic threshold to avoid wasting revision cycles without evidence

---

## 9. Pending Questions

When the Router, Planner, or Executor asks a question (e.g. "Which database?", "Reply to proceed with the plan"), your next message is routed back to the node that asked. Answer in context — no need to repeat the original task.

---

## 10. Override Summary

| Override | Triggers | Effect |
|----------|----------|--------|
| **Plan Session** | `[STRICT]`, `/plan`, `@plan`, `plan first`, `break it down`, etc. | Route through Planner, show plan for approval |
| **Educational** | `explain`, `how does it work`, etc. | Explain-only path with taxonomy enrichment |

Use overrides when the automatic classification is wrong. For example: *"The system treated this as trivial, but I want to see the plan"* → add `[STRICT]` or `/plan` at the start.

---

## 11. /why and /reclassify

**`/why`** — In a follow-up message, ask why the previous message was classified. Returns `complexity_score`, `risk_score`, reasons, and score breakdown. No graph run.

**`/reclassify small`** or **`/reclassify complex`** — Override the classification for your previous message. Send a task first, then use `/reclassify` to force small or complex for that run. Logged as a tuning candidate.

---

## 13. Tuning the Classifier

Config: `base/planner/intent_weights.yaml` (or `entry_classifier_weights.yaml`):

- **complexity_weights:** Steps, scope — single category capped ~10 so one word doesn't force complex.
- **risk_weights:** Destructive, secrets, compliance — can veto trivial to complex.
- **domain_keywords:** k8s, aws, etc. — RAG gravity only; never escalates.
- **thresholds:** `trivial_max`, `small_max`, `risk_high` — score thresholds.
- **overrides:** `plan_session`.

Override config path via `SYNESIS_ENTRY_CLASSIFIER_WEIGHTS`.

---

## 14. Feedback for Tuning

Thumbs up/down are stored via `POST /v1/feedback` with classification context. Use `GET /v1/feedback` to list feedback for tuning.

**Open WebUI dashboard:** Import the Synesis Feedback Pipe plugin (`integrations/openwebui-synesis-feedback/`). It adds a "Synesis Feedback" model — select it, send `show` or `show down` to view feedback with classification reasons. See [FEEDBACK_API.md](FEEDBACK_API.md).

---

## See Also

- [WORKFLOW.md](WORKFLOW.md) — Full graph, node roles, routing logic
- [FEEDBACK_API.md](FEEDBACK_API.md) — Thumbs up/down storage for classifier tuning
- [README.md](../README.md) — Deployment, configuration, quick start
