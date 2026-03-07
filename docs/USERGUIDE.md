# Synesis User Guide

How to get the behavior you want. Synesis uses a deterministic EntryClassifier before any LLM — your wording drives routing, depth, and modes. If the judgement layer misclassifies, you can override with explicit triggers.

**Scaling:** Complexity detection is driven by `intent_weights.yaml` (or `entry_classifier_weights.yaml`). Config uses split axes: **complexity** (steps/scope), **risk** (destructive, secrets), **domain** (k8s, aws — RAG only, never escalates). Domain vocabulary like "kubectl" stays trivial; risk words like "delete database" escalate.

---

## Quick Reference: Trigger Words

| What you want | Say this |
|---------------|----------|
| **Force full path** (see Supervisor + Planner even for trivial tasks) | `[STRICT]`, `/plan`, `/manual`, `/strict` at start of message |
| **Full planning / JCS prompt** (step-by-step breakdown, defensive code) | `@plan`, `plan first`, `break it down`, `I need a plan`, `step-by-step plan` |
| **Explanations** (explain-only path, no code) | `explain`, `how does it work`, `why`, `I'm learning`, `walk me through` |
| **Fast path** (trivial → straight to Worker) | `hello world`, `print X`, `basic unit test`, `parse json`, `simple fizzbuzz` |
| **Complex / escalation** (Supervisor may ask, Planner runs) | `deploy`, `architecture`, `design`, `migrate`, `security`, `credentials`, `connect to AWS` |

---

## 1. Task Size and Routing

Synesis classifies your request into three tiers before any LLM runs:

| Tier | Path | When |
|------|------|------|
| **Trivial** | EntryClassifier → Context Curator → Worker → Gate → Sandbox → Critic → Respond | Regex matches (hello world, print X, basic unit test, parse json, fizzbuzz, simple script, etc.) |
| **Small** | EntryClassifier → **Supervisor** → Context Curator → Worker → … | Default when not trivial or complex |
| **Complex** | EntryClassifier → **Supervisor** → Planner (plan approval) → Context Curator → Worker → … | Matches: deploy, architecture, design, migrate, security, credentials, whole repo, destructive ops |

**Trivial** skips the Supervisor — you go straight to the Worker with minimal context. **Small** and **Complex** run through the Supervisor, which may suggest planning or ask clarification (within budget).

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

**Effect:** Routes to the Planner node regardless of task complexity. You see a structured plan and are asked to approve before execution proceeds to the Worker.

---

## 4. Explanations and Educational Content

When you want an explanation rather than code, use natural language:

- `explain`, `how does it work`, `why did`, `why would`
- `walk me through`, `what does this do`, `can you explain`

**Effect:** The system routes to the explain-only path (`is_code_task=false`), producing
well-structured markdown with taxonomy-driven depth and tone. Domain-specific taxonomy
prompts enrich responses with gotchas, trade-offs, and discovery prompts where appropriate.

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

These phrases cause **complex** classification (plan_required, Supervisor may ask clarification):

- `deploy`, `architecture`, `design`, `migrate`, `refactor across`
- `security`, `auth`, `payments`, `credentials`
- `connect to AWS`, `connect to GCP`, `connect to S3`
- `whole repo`, `entire codebase`, `add feature … across modules`
- `delete all`, `wipe`, `rotate keys`
- `fix my project`, `make this work` (ambiguous scope)

---

## 7. Trivial Triggers (Fast Path)

These typically skip the Supervisor:

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

Admins can view gaps in the **Knowledge Gaps** page and submit new content via the planner API or admin form. See [PLAN-domain-aligner-universal-expertise.md](PLAN-domain-aligner-universal-expertise.md).

---

## 9. Pending Questions

When the Supervisor, Planner, or Worker asks a question (e.g. "Which database?", "Reply to proceed with the plan"), your next message is routed back to the node that asked. Answer in context — no need to repeat the original task.

---

## 10. Override Summary

| Override | Triggers | Effect |
|----------|----------|--------|
| **Plan Session** | `[STRICT]`, `/plan`, `@plan`, `plan first`, `break it down`, etc. | Route through Planner, show plan for approval |
| **Educational** | `explain`, `how does it work`, etc. | Explain-only path with taxonomy enrichment |

Use overrides when the automatic classification is wrong. For example: *"The system treated this as trivial, but I want to see the plan"* → add `[STRICT]` or `/plan` at the start.

---

## 11. /test (Force Sandbox Execution)

**`/test`** — Prefix your message with `/test` to force sandbox execution on the generated code, even if the system would normally skip it (e.g., for explain-only or trivial tasks).

**Example:**

```
/test Write a Python function that reverses a string
```

**Effect:** The code goes through the full sandbox pipeline (lint, security scan, execution) regardless of task classification. Useful for validating code quality or catching runtime errors.

---

## 12. /why and /reclassify

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
