# Synesis User Guide

How to get the behavior you want. Synesis uses a deterministic EntryClassifier before any LLM — your wording drives routing, depth, and modes. If the judgement layer misclassifies, you can override with explicit triggers.

**Scaling:** Complexity detection is driven by `intent_weights.yaml` (or `entry_classifier_weights.yaml`). Config uses split axes: **complexity** (steps/scope), **risk** (destructive, secrets), **domain** (k8s, aws — RAG only, never escalates). Domain vocabulary like "kubectl" stays trivial; risk words like "delete database" escalate.

---

## Quick Reference: Trigger Words

| What you want | Say this |
|---------------|----------|
| **Force full path** (see Supervisor + Planner even for trivial tasks) | `[STRICT]`, `/plan`, `/manual`, `/strict` at start of message |
| **Full planning / JCS prompt** (step-by-step breakdown, defensive code) | `@plan`, `plan first`, `break it down`, `I need a plan`, `step-by-step plan` |
| **Learn, not just code** (explanations, Learner's Corner) | `explain`, `how does it work`, `why`, `teach me`, `I'm learning`, `walk me through` |
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

## 2. Force Manual Override

**Problem:** You're a Senior Architect reviewing a "trivial" task. You want to see the Supervisor's plan and routing — not the fast path.

**Solution:** Prefix your message with one of:

- `[STRICT]`
- `/plan` (at the very start)
- `/manual`
- `/strict`

**Examples:**

```
[STRICT] hello world in python
```

```
/plan Create a simple script that prints "Hello"
```

**Effect:** Bypasses the trivial fast path. Your request runs through the Supervisor (and Planner if plan approval is needed). You see the full pipeline: Supervisor routing → optional plan approval → Worker → Critic.

---

## 3. Full Planning / Pro Advanced

When you want step-by-step breakdowns or the full JCS (Joint Cognitive System) prompt tier — even for small tasks — use these phrases:

- `@plan`, `#plan`
- `plan first`, `plan before`, `I need a plan`
- `break it down`, `break this down`
- `full planning`, `architecture review`, `design review`
- `scope:`, `multi-file:`, `walk through the steps`
- `step-by-step plan`, `execution plan`

**Effect:** Worker uses the **full** prompt tier (defensive code, JCS style) instead of the minimal or small tier.

---

## 4. Educational / Mentor Mode

When you want to **learn** — not just get code — use:

- `explain`
- `how does it work`, `why did`, `why do`, `why would`
- `walk me through`
- `teach me`
- `I'm learning`, `learning how`, `learning to`
- `what does this do`, `what does that mean`
- `can you explain`

**Effect:** `interaction_mode=teach`. The Worker produces a **Learner's Corner** with:
- `pattern` — what the code does
- `why` — why it's written that way
- `resilience` — failure modes
- `trade_off` — alternatives

Respond formats this as a "Learner's Corner" section in the output.

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
| **Force Manual** | `[STRICT]`, `/plan`, `/manual`, `/strict` at start | Route through Supervisor even for trivial |
| **Full Planning** | `@plan`, `plan first`, `break it down`, etc. | Worker prompt tier = full (JCS) |
| **Educational** | `explain`, `teach me`, `how does it work`, etc. | Learner's Corner in output |

Use overrides when the automatic classification is wrong. For example: *"The system treated this as trivial, but I want to see the plan"* → add `[STRICT]` or `/plan` at the start.

---

## 11. /why and /reclassify

**`/why`** — In a follow-up message, ask why the previous message was classified. Returns `complexity_score`, `risk_score`, reasons, and score breakdown. No graph run.

**`/reclassify small`** or **`/reclassify complex`** — Override the classification for your previous message. Send a task first, then use `/reclassify` to force small or complex for that run. Logged as a tuning candidate.

---

## 12. Tuning the Classifier

Config: `base/planner/intent_weights.yaml` (or `entry_classifier_weights.yaml`):

- **complexity_weights:** Steps, scope — single category capped ~10 so one word doesn't force complex.
- **risk_weights:** Destructive, secrets, compliance — can veto trivial to complex.
- **domain_keywords:** k8s, aws, etc. — RAG gravity only; never escalates.
- **thresholds:** `trivial_max`, `small_max`, `risk_high` — score thresholds.
- **overrides:** `force_manual`, `force_teach`, `force_pro_advanced`.

Override config path via `SYNESIS_ENTRY_CLASSIFIER_WEIGHTS`.

---

## 13. Feedback for Tuning

Thumbs up/down are stored via `POST /v1/feedback` with classification context. Use `GET /v1/feedback` to list feedback for tuning.

**Open WebUI dashboard:** Import the Synesis Feedback Pipe plugin (`integrations/openwebui-synesis-feedback/`). It adds a "Synesis Feedback" model — select it, send `show` or `show down` to view feedback with classification reasons. See [FEEDBACK_API.md](FEEDBACK_API.md).

---

## See Also

- [WORKFLOW.md](WORKFLOW.md) — Full graph, node roles, routing logic
- [FEEDBACK_API.md](FEEDBACK_API.md) — Thumbs up/down storage for classifier tuning
- [README.md](../README.md) — Deployment, configuration, quick start
