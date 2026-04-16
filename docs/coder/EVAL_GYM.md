# Yarn Eval Gym

Integrated exerciser, session observer, and training data pipeline for
testing, improving, and fine-tuning the Yarn coding agent.

---

## Table of Contents

1. [Overview](#overview)
2. [Quickstart](#quickstart)
3. [Scenario Authoring Guide](#scenario-authoring-guide)
4. [CLI Reference](#cli-reference)
5. [API Reference](#api-reference)
6. [Session Observer Guide](#session-observer-guide)
7. [Training Data Pipeline](#training-data-pipeline)
8. [Continuous Improvement Playbook](#continuous-improvement-playbook)
9. [Troubleshooting](#troubleshooting)
10. [Architecture Reference](#architecture-reference)

---

## Overview

### Why This Exists

Before the eval gym, testing governor behavior required manually using
Claude Code, waiting for waffling to occur, pasting transcripts, and
guessing at fixes. The existing scripts (`tier-compare.ts`,
`ab-reducer-compare.ts`) only test single-turn latency and reduction
— not multi-turn agent loops where waffling happens.

The eval gym closes this loop:

1. **Exercise** — send canned multi-turn scenarios to any OpenAI-compatible API
2. **Observe** — record and analyze live sessions in real-time
3. **Score** — detect anomalies (waffling, loops, drift) with heuristic checks
4. **Train** — feed scored results directly into the feedback loop as SFT/DPO/RLAIF data

### How It Fits

```
 Governor Harness        Eval Gym             Feedback Loop
 ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
 │ Rules fire   │────>│ Scenarios    │────>│ Export JSONL     │
 │ Telemetry    │     │ Observer     │     │ SFT / DPO / RLAIF│
 │ Recovery     │     │ Turn scorer  │     │ Training pipeline│
 └─────────────┘     └──────────────┘     └─────────────────┘
        ^                    │                      │
        └────────────────────┴──────────────────────┘
                    Continuous improvement
```

---

## Quickstart

### Prerequisites

- Node.js 24+ and `tsx` (already in devDependencies)
- A target API endpoint (Yarn, OpenRouter, or any OpenAI-compatible server)
- A bearer token / API key for the target

### Run Your First Scenario (5 minutes)

```bash
# 1. Set environment
export SYNESIS_EVAL_TARGET_URL=http://yarn.synesis-yarn.svc.cluster.local:8000
export SYNESIS_TEST_PAT_TOKEN=your-pat-token

# 2. List available scenarios
cd base/yarn-ts
npm run eval:list

# 3. Run a single governor regression scenario
npx tsx scripts/eval-gym.ts --scenario plan-load-exploration-drift

# 4. Run all governor regression scenarios
npm run eval:regression
```

### Reading the Output

```
  Scenario                               Status  Score  Turns  Anomalies  Time
  ---------------------------------------------------------------------------------
  plan-load-exploration-drift            PASS    1.00   1      0          1234ms
  plan-update-amnesia-loop               PASS    0.90   1      1          890ms
  verification-stall-no-edit             FAIL    0.60   1      3          2100ms
    FAIL: Forbidden governor rules fired: verification_stall_no_edit
    ANOMALY: Tool "Bash" called with same args 3 times

  2/3 passed | avg score: 0.833 | total time: 4224ms
```

- **PASS/FAIL** — whether the scenario met all its scoring criteria
- **Score** — 0.0 to 1.0, deducted for anomalies, assertion failures, and governor violations
- **Turns** — number of model response turns
- **Anomalies** — heuristic issues detected (waffling, tool repetition, etc.)

---

## Scenario Authoring Guide

### Anatomy of a Scenario

Every scenario is a TypeScript object implementing `EvalScenario`:

```typescript
import type { EvalScenario } from "../types.js";

export const myScenario: EvalScenario = {
  id: "my-scenario-id",              // unique kebab-case identifier
  name: "Human-readable name",       // shown in output tables
  category: "governor_regression",   // governor_regression | e2e_build | recovery | plan_management
  description: "What this tests",    // documentation
  target: { model: "auto" },         // optional model/conversation_id override
  systemPrompt: "You are...",        // optional system message
  turns: [/* ... */],                // the conversation turns
  scoring: {/* ... */},              // pass/fail criteria
};
```

### Turns

Each turn represents one user message and the expected model interaction:

```typescript
{
  messages: [
    { role: "user", content: "Implement the feature." }
  ],
  simulatedToolResults: {
    // When the model calls tool X, inject this simulated result
    "Write": "File written successfully.",
    "Bash": "ok  synesis.sh/synesis  (cached)",
    "Read": "package main\n\nfunc main() {}",
  },
  maxToolRounds: 3,    // cap tool-call loops (default 3)
  assertions: [        // per-turn checks
    { type: "contains_edit" },
    { type: "no_waffling_markers" },
    { type: "tool_count_lte", params: { max: 8 } },
  ],
}
```

The runner sends `messages`, receives the model's response. If the model
makes tool calls and `simulatedToolResults` has a matching tool name,
the runner injects the result and re-sends — up to `maxToolRounds` times.

### Assertion Types Reference

| Type | Description | Params |
|------|-------------|--------|
| `governor_paused` | At least one non-allow governor rule fired | — |
| `governor_not_paused` | No governor rules fired | — |
| `contains_edit` | Model called Write/Edit/ApplyPatch/FileWrite/StrReplace | — |
| `no_repeated_tool` | No tool called with identical args more than once | — |
| `recovery_block_present` | Response contains governor recovery guidance | — |
| `annotation_present` | Response contains a specific annotation | `{ marker: "SYNESIS_PLAN_LOADED" }` |
| `tool_count_lte` | Total tool calls within limit | `{ max: 8 }` |
| `no_stub_content` | No "unchanged since last read" or cache stubs in tool results | — |
| `content_matches` | Assistant response matches regex | `{ pattern: "file written" }` |
| `no_waffling_markers` | No "I'll implement…" / "Let me check…" without edits | — |
| `tool_name_present` | A specific tool was called | `{ name: "Write" }` |
| `tool_name_absent` | A specific tool was NOT called | `{ name: "Glob" }` |

### Scoring Criteria

```typescript
{
  maxTotalTurns: 3,                    // hard limit on response turns
  maxGovernorInterventions: 0,         // fail if governor pauses more than N times
  requiredOutcome: "completed",        // expected terminal state
  failIfRules: ["verification_stall_no_edit"],  // fail if these governor rules fire
  passIfRules: ["exploration_stall_no_edit"],    // pass only if these rules fire
}
```

### Adding a New Governor Regression Scenario

1. Open `base/yarn-ts/src/eval/scenarios/governor-regression.ts`
2. Add a new exported `EvalScenario` object (use existing ones as templates)
3. Add it to the `GOVERNOR_REGRESSION_SCENARIOS` array at the bottom
4. Run: `npx tsx scripts/eval-gym.ts --scenario your-new-id`

**Template for a new regression scenario:**

```typescript
export const myRegression: EvalScenario = {
  id: "my-regression-name",
  name: "Description of the waffling pattern",
  category: "governor_regression",
  description: "What happened: ... What should happen: ...",
  target: {},
  systemPrompt: "You are a coding assistant.",
  turns: [{
    messages: [
      { role: "user", content: "The prompt that triggers the waffling" },
    ],
    simulatedToolResults: {
      // Tool results that feed the loop
    },
    maxToolRounds: 3,
    assertions: [
      { type: "contains_edit" },
      { type: "no_repeated_tool" },
    ],
  }],
  scoring: {
    maxTotalTurns: 2,
    failIfRules: ["the_governor_rule_that_should_not_fire"],
  },
};
```

### Adding a New E2E Scenario

1. Open `base/yarn-ts/src/eval/scenarios/e2e-builds.ts`
2. Define a realistic coding task with expected tool interactions
3. Add it to `E2E_BUILD_SCENARIOS`
4. Run: `npx tsx scripts/eval-gym.ts --scenario your-new-id`

### Extracting Scenarios from Real Waffle Transcripts

When you observe a new waffling pattern in a live session:

1. Note the user message that started the loop
2. Note the tool calls and results in the loop
3. Note which governor rule should have fired (or does fire now)
4. Create a scenario that replays steps 1-2 and asserts step 3

### Capture -> Sanitize -> Materialize -> Replay

Use this flow to convert real incidents into deterministic regressions without
running full user workloads:

1. **Capture** live events (`eval_transcript_v1`, `live_eval_v1`, `execution_governor_evaluated`)
   via admin API or SQL.
2. **Sanitize** session payloads (remove user identifiers, secrets, absolute paths),
   then save as a local JSON export.
3. **Materialize** candidate scenarios:

```bash
cd base/yarn-ts
npm run eval:materialize:governor -- \
  --input /path/to/session-events.json \
  --out governor-regression-candidates.json \
  --limit 25
```

4. **Replay** deterministically in unit tests by adding/adjusting fixtures under
   `tests/fixtures/governor-replay/` and running:

```bash
npm run test:governor:unit
```

5. **Promote** durable cases to `src/eval/scenarios/governor-regression.ts` for
   live Eval Gym coverage.

---

## CLI Reference

### Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--list` | List all available scenarios | `--list` |
| `--scenario <id>` | Run a single scenario by ID | `--scenario plan-load-exploration-drift` |
| `--category <cat>` | Run all scenarios in a category | `--category governor_regression` |
| `--all` | Run all scenarios | `--all` |
| `--model <name>` | Override model for all scenarios | `--model qwen/qwen3-coder` |
| `--export <format>` | Export training data (sft, dpo, rlaif) | `--export sft` |
| `--out <path>` | Output file path | `--out results.jsonl` |
| `--json` | Write full results as JSON | `--json --out results.json` |
| `--verbose` | Show detailed output for all scenarios | `--verbose` |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNESIS_EVAL_TARGET_URL` | Yes | Base URL of the target API |
| `SYNESIS_EVAL_TARGET_KEY` | Yes* | API key / bearer token |
| `SYNESIS_TEST_PAT_TOKEN` | Yes* | Alternative auth token |
| `SYNESIS_EVAL_MODEL` | No | Default model override |
| `SYNESIS_EVAL_ADMIN_URL` | No | Admin API for governor telemetry (Yarn-only) |
| `SYNESIS_EVAL_ADMIN_TOKEN` | No | Admin bearer token |
| `SYNESIS_EVAL_TIMEOUT_MS` | No | Per-turn timeout (default 120000) |

*One of `SYNESIS_EVAL_TARGET_KEY` or `SYNESIS_TEST_PAT_TOKEN` is required.

### npm Scripts

```bash
npm run eval              # Run with flags (pass args after --)
npm run eval:list         # List scenarios
npm run eval:regression   # Run governor regression scenarios
npm run eval:e2e          # Run e2e build scenarios
npm run eval:export       # Run all and export SFT training data
```

### Running Against Different Targets

```bash
# Against Yarn (full scoring with governor telemetry)
SYNESIS_EVAL_TARGET_URL=http://yarn:8000 \
SYNESIS_TEST_PAT_TOKEN=... \
npm run eval:regression

# Against OpenRouter
SYNESIS_EVAL_TARGET_URL=https://openrouter.ai/api/v1 \
SYNESIS_EVAL_TARGET_KEY=sk-or-... \
npx tsx scripts/eval-gym.ts --all --model qwen/qwen3-coder

# Against local vLLM
SYNESIS_EVAL_TARGET_URL=http://localhost:8000 \
SYNESIS_EVAL_TARGET_KEY=dummy \
npx tsx scripts/eval-gym.ts --category e2e_build

# Against Ollama
SYNESIS_EVAL_TARGET_URL=http://localhost:11434/v1 \
SYNESIS_EVAL_TARGET_KEY=dummy \
npx tsx scripts/eval-gym.ts --scenario fresh-go-cli --model qwen3-coder
```

---

## API Reference

Eval endpoints are registered on Yarn when `SYNESIS_YARN_EVAL_API_ENABLED`
is not `false` (default: enabled).

### `GET /v1/eval/scenarios`

List all available scenarios.

**Response:**
```json
{
  "scenarios": [
    { "id": "plan-load-exploration-drift", "name": "Plan-load exploration drift", "category": "governor_regression", "description": "..." },
    ...
  ],
  "total": 11
}
```

### `POST /v1/eval/run`

Execute one or more scenarios.

**Request body:**
```json
{
  "scenario_id": "plan-load-exploration-drift",
  "target_url": "http://localhost:8000",
  "api_key": "...",
  "model": "auto"
}
```

Or run by category:
```json
{
  "category": "governor_regression"
}
```

**Response:**
```json
{
  "summary": { "total": 7, "passed": 6, "failed": 1, "avgScore": 0.912 },
  "results": [/* ScenarioResult[] */]
}
```

### `GET /v1/eval/results`

Query past eval results (delegates to admin session events API).

### `POST /v1/eval/observe/start`

Enable the session observer.

**Request body:**
```json
{ "session_key_filter": ["synesis:user123:"] }
```

### `POST /v1/eval/observe/stop`

Disable the session observer.

### `GET /v1/eval/observe/status`

Check observer state.

### `POST /v1/eval/export`

Materialize training data from scenario results.

**Request body:**
```json
{
  "results": [/* ScenarioResult[] from /v1/eval/run */],
  "format": "sft"
}
```

---

## Session Observer Guide

The session observer records full turn-by-turn data from live Yarn
sessions and runs heuristic anomaly detection on each turn.

### Enabling

**Via environment variable (startup):**
```bash
SYNESIS_YARN_EVAL_OBSERVER_ENABLED=true
```

**Via API (runtime, no restart needed):**
```bash
curl -X POST http://yarn:8000/v1/eval/observe/start \
  -H "Content-Type: application/json" \
  -d '{"session_key_filter": []}'
```

An empty `session_key_filter` observes all sessions. Provide prefixes
to observe specific users or sessions.

### What Gets Recorded

For each request that completes through `persistAndEmitDecisionTelemetry`:

1. **`eval_transcript_v1`** — always emitted when observer is active:
   - Input message count, response role, tool call count
   - Governor decision (pause, rules, telemetry)
   - Annotations present (PLAN_LOADED, PLAN_UPDATED, etc.)
   - Anomaly count and details

2. **`live_eval_v1`** — emitted only when anomalies are detected OR governor paused:
   - Error and warning anomaly breakdown
   - Governor telemetry snapshot
   - Annotations present

### Querying Observer Data

```sql
-- All anomalies from live sessions in the last 24 hours
SELECT
  session_key,
  metadata_json->'anomaly_count' AS anomalies,
  metadata_json->'governor_pause' AS paused,
  metadata_json->'annotations_present' AS annotations,
  created_at
FROM yarn_session_events
WHERE event_kind = 'live_eval_v1'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Full transcripts for a specific session
SELECT metadata_json
FROM yarn_session_events
WHERE event_kind = 'eval_transcript_v1'
  AND session_key LIKE 'synesis:user123:%'
ORDER BY created_at;
```

Or via the admin API:
```bash
curl "http://admin:8080/api/v1/feedback-loop/eval-gym/events?event_kind=live_eval_v1&limit=50"
```

### Performance

The observer is guarded by a simple boolean check at the top of
`persistAndEmitDecisionTelemetry`. When disabled (the default),
the cost is a single `if (false)` comparison per request — zero
overhead. When enabled, the main cost is building the `ObservedTurn`
object and enqueueing 1-2 session events, which is async and
non-blocking via the existing `UsageWriter` queue.

---

## Training Data Pipeline

### End-to-End Walkthrough: Scenario Run to Training JSONL

```
1. Run scenarios
   npx tsx scripts/eval-gym.ts --all --export sft --out training-sft.jsonl

2. Results are also emitted as yarn_session_events:
   - scenario_eval_v1 (when targeting Yarn)
   - request_trajectory_v1 (standard trajectory)

3. Pull from feedback loop:
   python scripts/feedback-loop-runner.py export \
     --run-id latest --dataset_type eval_gym --format jsonl --out eval-data.jsonl

4. Or export directly:
   npx tsx scripts/eval-gym.ts --all --export dpo --out training-dpo.jsonl
```

### Dataset Types

| Type | Description | When to Use |
|------|-------------|-------------|
| `sft` | Supervised fine-tuning examples (messages + quality label) | Teaching the model correct behavior |
| `dpo` | Direct preference optimization pairs (chosen/rejected) | Teaching the model to prefer good actions over waffling |
| `rlaif` | Reward-labeled examples (messages + reward score) | Reward model training |
| `trajectory` | Canonical trajectory rows (full operational telemetry) | Analysis and custom training pipelines |
| `eval_gym` | Raw eval gym events from session_events table | Admin feedback loop integration |

### SFT Data Generation

Positive examples come from scenarios where:
- The scenario passed (`score >= 0.7`)
- The turn had no error-severity anomalies
- The model completed the task efficiently

Negative examples come from:
- Failed scenarios
- Turns with error anomalies (repeated content, tool loops)

Format:
```json
{
  "messages": [
    {"role": "user", "content": "Implement bundle support"},
    {"role": "assistant", "content": "I'll create the bundle package."},
    {"role": "tool", "content": "File written"}
  ],
  "source": "eval_gym",
  "scenario_id": "fresh-go-cli",
  "quality_label": "positive"
}
```

### DPO Pair Generation

When the governor intervenes on a turn, the model's actual output
becomes the **rejected** response, and a synthesized ideal response
(based on the governor rule) becomes the **chosen** response.

```json
{
  "prompt": [{"role": "user", "content": "Fix the build"}],
  "chosen": "I notice I've been running verification commands without changes. Let me identify the specific issue and make a code edit.",
  "rejected": "I'll check the build again. Let me run go build...",
  "source": "eval_gym",
  "scenario_id": "verification-stall-no-edit"
}
```

### RLAIF Reward Signal

Each turn gets a reward score from 1.0 (clean) to -1.0 (terrible):
- -0.3 per error anomaly
- -0.1 per warning anomaly
- -0.4 if governor paused

```json
{
  "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "reward": 0.3,
  "anomaly_count": 2,
  "source": "eval_gym",
  "scenario_id": "plan-update-amnesia-loop"
}
```

### Using feedback-loop-runner.py

```bash
# Export eval gym data from admin
python scripts/feedback-loop-runner.py export \
  --run-id latest \
  --dataset_type eval_gym \
  --format jsonl \
  --out eval-gym-data.jsonl
```

### Format Compatibility

The JSONL output is compatible with:

- **Axolotl** — SFT format maps to `sharegpt` conversation format
- **TRL (Hugging Face)** — DPO format maps to `DPOTrainer` expected fields
- **Custom training loops** — all formats are simple JSON with standard fields

---

## Continuous Improvement Playbook

### Weekly Regression Run

Schedule in CI or cron:

```bash
SYNESIS_EVAL_TARGET_URL=$YARN_URL \
SYNESIS_TEST_PAT_TOKEN=$PAT \
npx tsx scripts/eval-gym.ts --category governor_regression --json --out weekly-regression.json

# Fail the CI job if any regression scenario breaks
npx tsx scripts/eval-gym.ts --category governor_regression
# Exit code 1 if any scenario fails
```

### Tiered Validation Lanes

Use explicit tiers so most changes do not require expensive full-workload replay:

- **PR fast lane:** `npm run ci:governor:pr` (deterministic governor unit + smoke replay)
- **Nightly lane:** `npm run ci:governor:nightly` (governor regression scenarios + budget gate)
- **Pre-release lane:** `npm run ci:governor:prerelease` (nightly lane + selected e2e_build scenarios)

All live lanes produce JSON artifacts:

- `eval-governor-regression.json`
- `eval-governor-budget.json`
- `eval-governor-e2e.json` (pre-release only)

### Regression Budget Gate

Budget checks compare candidate vs baseline on:

- pass rate
- average score
- governor intervention rate
- repeated-command anomaly rate
- average turns-to-resolution

Run manually:

```bash
npm run eval:budget -- \
  --candidate eval-governor-regression.json \
  --baseline baseline-governor-regression.json \
  --summary-out eval-governor-budget.json
```

Tune thresholds with optional flags:

- `--max-pass-rate-drop`
- `--max-score-drop`
- `--max-intervention-rate-increase`
- `--max-repeated-command-rate-increase`
- `--max-turns-increase`

### After Fixing a Governor Bug

1. Reproduce the waffling pattern as a scenario (see [Authoring Guide](#adding-a-new-governor-regression-scenario))
2. Run the scenario against the old code to confirm it fails
3. Deploy the fix
4. Run the scenario again to confirm it passes
5. The scenario stays in the regression suite permanently

### After a Model Update

```bash
# Run full suite against the new model
SYNESIS_EVAL_MODEL=new-model-name \
npx tsx scripts/eval-gym.ts --all --json --out new-model-results.json

# Compare against previous results
# Look at: pass rate, avg score, anomaly counts, governor interventions
```

### After Fine-Tuning

```bash
# Run the same scenarios against the fine-tuned model
SYNESIS_EVAL_TARGET_URL=http://fine-tuned-endpoint:8000 \
npx tsx scripts/eval-gym.ts --all --json --out fine-tuned-results.json

# Key metrics to compare:
# - Pass rate by category (especially governor_regression)
# - Average turns to completion (lower is better)
# - Governor intervention rate (should decrease after SFT)
# - Waffling marker frequency (should decrease after DPO)
```

### Reviewing Live Sessions

```bash
# Enable observer on production Yarn
curl -X POST http://yarn:8000/v1/eval/observe/start

# Let users work naturally for a few hours

# Query anomalies
curl "http://admin:8080/api/v1/feedback-loop/eval-gym/events?event_kind=live_eval_v1&limit=100"

# Review and create new regression scenarios from observed patterns

# Disable observer
curl -X POST http://yarn:8000/v1/eval/observe/stop
```

### Curating Training Data

1. Run scenarios: `npm run eval:export` (produces `eval-sft.jsonl`)
2. Review examples: positive examples should show efficient behavior; negatives should show real waffling
3. Remove ambiguous examples (edge cases where the model's behavior is debatable)
4. Add to training dataset
5. Fine-tune
6. Re-run eval gym to measure improvement

### Iterating the Governor

The eval gym results directly inform governor rule development:

1. **New anomaly pattern observed** in live sessions (observer detects it)
2. **Create a regression scenario** that reproduces it
3. **Write a new governor rule** that catches it
4. **Run the scenario** to confirm the rule fires
5. **Check existing scenarios** still pass (no regressions)
6. **Export training data** including the new pattern for model fine-tuning

### Tracking Progress Over Time

Key metrics to monitor:

| Metric | What It Measures | Target |
|--------|-----------------|--------|
| Pass rate (governor_regression) | Governor catches known waffling patterns | 100% |
| Pass rate (e2e_build) | Model completes real tasks efficiently | > 80% |
| Average score | Overall quality across all scenarios | > 0.85 |
| Average turns to completion | Efficiency (lower is better) | < 3 |
| Governor intervention rate | How often the governor has to step in | Decreasing |
| Waffling marker frequency | "I'll implement..." without edits | Decreasing |
| Anomaly count per scenario | Issues detected per run | Decreasing |

---

## Troubleshooting

### Auth Failures

```
ERROR: Chat completions 401: Authentication required
```

Check that `SYNESIS_EVAL_TARGET_KEY` or `SYNESIS_TEST_PAT_TOKEN` is set
and valid for the target API.

### Timeout on Long Scenarios

```
ERROR: Turn 0 failed: The operation was aborted due to timeout
```

Increase the timeout:
```bash
SYNESIS_EVAL_TIMEOUT_MS=300000 npx tsx scripts/eval-gym.ts --scenario ...
```

### Non-Yarn API Limitations

When targeting OpenRouter, vLLM, or other non-Yarn APIs:
- Governor assertions (`governor_paused`, `governor_not_paused`) always
  return "no data" and are skipped
- `passIfRules` / `failIfRules` in scoring criteria are ignored
- Scoring relies entirely on response-pattern analysis (anomaly detection,
  tool repetition, waffling markers)

### Governor Telemetry Not Available

If targeting Yarn but governor telemetry is empty:
- Set `SYNESIS_EVAL_ADMIN_URL` and `SYNESIS_EVAL_ADMIN_TOKEN`
- The runner queries `GET /api/v1/yarn/session-events` on the admin API
- Verify the admin API is accessible from where you're running the CLI

### Observer Data Not Appearing

1. Check `SYNESIS_YARN_EVAL_OBSERVER_ENABLED=true` in Yarn's env
2. Or verify runtime activation: `GET /v1/eval/observe/status`
3. Check Yarn has DB connectivity (session events need Postgres)
4. Check `UsageWriter` flush interval (default 50ms)

---

## Architecture Reference

### Component Diagram

```
base/yarn-ts/src/eval/
├── types.ts                 # All type definitions
├── scenario-runner.ts       # Multi-turn conversation executor
├── turn-scorer.ts           # Assertion evaluation + anomaly detection
├── session-observer.ts      # Live session recording
├── training-materializer.ts # Training data format conversion
├── routes.ts                # Fastify API route registration
└── scenarios/
    ├── index.ts             # Scenario registry
    ├── governor-regression.ts # 7 regression scenarios
    └── e2e-builds.ts        # 4 e2e scenarios

base/yarn-ts/scripts/
└── eval-gym.ts              # CLI entry point

base/yarn-ts/tests/
├── eval-turn-scorer.test.ts
├── eval-scenario-runner.test.ts
└── eval-training-materializer.test.ts
```

### Data Flow

```
Scenario Runner                    Yarn API
  │                                  │
  │── POST /v1/chat/completions ────>│
  │<── response (with tool_calls) ───│
  │── inject simulated tool result ──│
  │── POST /v1/chat/completions ────>│
  │<── final response ───────────────│
  │                                  │
  ├── Turn Scorer                    ├── Governor evaluates
  │   ├── Check assertions           │   ├── Records session event
  │   └── Detect anomalies           │   └── Fires rules if needed
  │                                  │
  ├── Score scenario                 ├── Observer (if enabled)
  │                                  │   ├── eval_transcript_v1
  └── Emit results                   │   └── live_eval_v1
      ├── stdout (CLI)               │
      ├── JSONL export               └── yarn_session_events (Postgres)
      └── scenario_eval_v1
```

### Relationship to Existing Infrastructure

| Component | Role | Location |
|-----------|------|----------|
| Governor Harness | Rules that detect waffling patterns | `src/governance/execution-governor.ts` |
| Feedback Loop | Dataset export for training | `base/admin/app/routers/feedback_loop.py` |
| Testing Labs | Eval suite execution | `base/admin/app/services/eval_harness.py` |
| Tier Compare | Single-turn latency benchmarks | `scripts/tier-compare.ts` |
| AB Reducer Compare | Tool-result reduction benchmarks | `scripts/ab-reducer-compare.ts` |
| **Eval Gym** | Multi-turn scenario testing + training data | `src/eval/` |

### Event Kinds

| Event Kind | Producer | Content |
|------------|----------|---------|
| `scenario_eval_v1` | Scenario runner (via Yarn) | Full scenario result with scores |
| `eval_transcript_v1` | Session observer | Per-turn transcript with anomalies |
| `live_eval_v1` | Session observer | Anomaly alert (only when issues detected) |
| `request_trajectory_v1` | Standard Yarn pipeline | Existing telemetry (always emitted) |
| `execution_governor_evaluated` | Governor | Governor decision per request |
