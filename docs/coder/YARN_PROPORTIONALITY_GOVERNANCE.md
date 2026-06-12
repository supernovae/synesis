# Proportionality Governance

## Problem

An agent asked to "fix security issues" may choose the path of least resistance: deleting the insecure capability entirely instead of patching it. This is technically "the most secure" but disproportionate to user intent. The same class of problem arises when agents rewrite modules instead of refactoring, or remove API endpoints instead of securing them.

Without proportionality governance, the agent has no structural pressure to match the magnitude of its changes to the magnitude of the user's request.

## Design Principles

1. **Intent-scope matching** — The user's request implicitly defines an acceptable change envelope. "Fix the XSS bug" implies surgical patches, not feature removal.
2. **Graduated response** — Small breaches get nudges, moderate breaches get guidance, severe breaches trigger intervention or pause.
3. **Never block legitimate work** — Broad refactors and explicit removals are valid. Proportionality only constrains when the classified scope is narrow.
4. **Deterministic first, critic second** — Fast regex + threshold checks handle 90% of cases. The LLM critic is optional and only fires for ambiguous high-risk situations.
5. **Composable with sensemaking** — Proportionality signals feed into the existing Cynefin-aware sensemaking governor as first-class friction signals.

## Architecture

Three layers, each feeding the next:

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Intent Scope Classifier                   │
│  Classifies user prompt → scope envelope            │
│  (narrow_fix, targeted_refactor, broad_refactor,    │
│   removal_ok, unconstrained)                        │
└───────────────────────┬─────────────────────────────┘
                        │ envelope
┌───────────────────────▼─────────────────────────────┐
│  Layer 2: Diff Accumulator                          │
│  Tracks cumulative change stats per user turn       │
│  (files modified/deleted, lines added/removed,      │
│   largest single deletion, net removal)             │
│  Assessed against envelope thresholds               │
└───────────────────────┬─────────────────────────────┘
                        │ proportionality level
┌───────────────────────▼─────────────────────────────┐
│  Layer 3: Sensemaking Governor Signals              │
│  Proportionality signals inject friction:           │
│  scope_exceeded_narrow    (advisory, 0.12)          │
│  scope_exceeded_moderate  (complicated, 0.22)       │
│  scope_exceeded_dangerous (chaotic, 0.35)           │
│                                                     │
│  Optional: Fast-model proportionality critic        │
│  (reuses SYNESIS_YARN_CRITIC_URL infrastructure)    │
└─────────────────────────────────────────────────────┘
```

## Layer 1: Intent Scope Classifier

**File:** `yarn-ts/src/governance/intent-scope-classifier.ts`

Runs once per genuine user message using regex heuristics (no LLM call). Classifies the user's `pendingUserDirective` (from ChatState) into a scope envelope.

### Scope Envelopes

| Envelope | Trigger Patterns | Risk Modifier | Thresholds |
|---|---|---|---|
| `narrow_fix` | fix/patch/resolve + security/bug/CVE | 0.8 | 3 files, 50 lines removed, 0 deletions |
| `targeted_refactor` | refactor/clean up/modernize/simplify | 0.4 | 10 files, 200 lines removed, 2 deletions |
| `broad_refactor` | rewrite/rebuild/overhaul/from scratch | 0.2 | 25 files, 500 lines removed, 5 deletions |
| `removal_ok` | remove/delete/drop + feature/module | 0.0 | No constraints |
| `unconstrained` | Default (no scope match) | 0.0 | No constraints |

### Precedence

Removal intent is checked first — if the user explicitly asks to remove something, no proportionality constraints apply. This prevents false positives on legitimate cleanup tasks.

## Layer 2: Diff Accumulator

**File:** `yarn-ts/src/governance/diff-accumulator.ts`

Tracks cumulative change statistics across the current user turn. Updated after every governed tool call (Write, Edit, StrReplace, etc.) via `updateDiffAccumulator()` called from all four governance call sites in `index.ts`.

### Tracked Metrics

- `filesCreated` / `filesDeleted` / `filesModified`
- `linesAdded` / `linesRemoved` / `netLinesRemoved`
- `totalLinesChanged`
- `largestSingleDeletion` (path + lines)
- `touchedPaths` (distinct file set)

### Assessment

`assessProportionality(stats, envelope)` compares accumulated stats against the envelope's thresholds and returns a proportionality level:

| Level | Meaning | Signal |
|---|---|---|
| `proportional` | Within thresholds | None |
| `elevated` | Single threshold breached | `scope_exceeded_narrow` |
| `disproportionate` | Multiple breaches or 2x files threshold | `scope_exceeded_moderate` |
| `dangerous` | File deleted in narrow_fix scope, or 3x line threshold | `scope_exceeded_dangerous` |

### Reset Behavior

The accumulator resets to zero when a new user message arrives that reclassifies the scope envelope. This ensures proportionality is measured per user turn, not across the entire session.

## Layer 3: Sensemaking Governor Integration

The proportionality signal is passed as the 8th parameter to `evaluateSensemakingGovernor()`. It enters the signal catalog and contributes to friction computation like any other signal.

### Signal Catalog Entries

| Signal | Weight | Domain | Decay | Productive Counterweight |
|---|---|---|---|---|
| `scope_exceeded_narrow` | 0.12 | advisory | 0.7 | 0.3 |
| `scope_exceeded_moderate` | 0.22 | complicated | 0.85 | 0.2 |
| `scope_exceeded_dangerous` | 0.35 | chaotic | 0.95 | 0.05 |

Key design choices:

- **Low productive counterweight** — Proportionality concerns should not be easily dismissed by productive momentum. An agent that's efficiently deleting an entire module is still disproportionate.
- **High decay resistance for dangerous** — The `scope_exceeded_dangerous` signal persists across turns (0.95 decay) to prevent the agent from "forgetting" it overstepped.
- **Composable friction** — Proportionality signals combine with other friction signals (verification churn, no-progress loops, etc.) for compounded response escalation.

### Graduated Response Messages

**Nudge** (scope_exceeded_narrow):
> "Your changes are broader than the request suggests. The user asked for a targeted fix — consider a more surgical approach rather than removing or rewriting large sections."

**Guide** (scope_exceeded_moderate):
> "WARNING: Your changes appear significantly broader than what the user requested. STOP and reconsider: fix the specific issues rather than removing or rewriting entire modules."

**Guide/Intervene** (scope_exceeded_dangerous):
> "CRITICAL: Your changes far exceed the user's request scope. You appear to be deleting features or rewriting modules when the user asked for targeted fixes. STOP immediately. Revert to surgical fixes only."

## Optional: Proportionality Critic

**File:** `yarn-ts/src/governance/proportionality-critic.ts`

An optional fast-model LLM critic that evaluates ambiguous cases where deterministic thresholds fire but the situation may be legitimate. Uses the existing `SYNESIS_YARN_CRITIC_URL` / `SYNESIS_YARN_CRITIC_MODEL` infrastructure.

### When It Fires

The critic is only called when:
1. The deterministic assessment returns `disproportionate` or `dangerous`
2. The sensemaking governor hasn't already hard-paused
3. The `SYNESIS_YARN_PROPORTIONALITY_ENABLED` config is true

### Critic Prompt

The critic receives:
- The user's original directive
- The classified scope envelope
- Cumulative diff stats
- Threshold breaches
- Recent tool names

It returns a structured verdict: `proportional`, `disproportionate`, or `dangerous` with a one-sentence reason.

### Fallback Behavior

If the critic times out (4s budget) or returns an error, the deterministic verdict is used as-is. The critic can only override a deterministic finding — it cannot escalate beyond the deterministic level.

## Telemetry

When proportionality is not `proportional`, a `proportionality_check` event is emitted with:

```json
{
  "level": "elevated | disproportionate | dangerous",
  "scopeEnvelope": "narrow_fix",
  "filesModified": 5,
  "filesDeleted": 1,
  "netLinesRemoved": 200,
  "totalLinesChanged": 350,
  "breaches": ["files_modified: 5 > 3", "files_deleted: 1 > 0"],
  "signal": "scope_exceeded_dangerous"
}
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SYNESIS_YARN_PROPORTIONALITY_ENABLED` | `true` | Master toggle for proportionality governance |

## The REPL Example

The motivating scenario: An agent was asked to find and fix security issues in a CLI. It found security findings for the REPL component. Instead of patching the REPL (sandboxing, input validation, etc.), it deleted the entire REPL module.

With proportionality governance:

1. The user's prompt "fix security issues" classifies as `narrow_fix` (scope envelope)
2. As the agent starts deleting the REPL module files, the diff accumulator tracks:
   - `filesDeleted: 1` (REPL module) — exceeds threshold of 0 for `narrow_fix`
   - `netLinesRemoved: 200+` — exceeds threshold of 50
3. Assessment: `dangerous` (file deleted in narrow_fix scope)
4. Signal `scope_exceeded_dangerous` enters sensemaking governor with weight 0.35 in the chaotic domain
5. Sensemaking governor fires `guide` or `intervene` response:
   > "CRITICAL: Your changes far exceed the user's request scope. You appear to be deleting features when the user asked for targeted fixes. STOP immediately. Revert to surgical fixes only."
6. The agent receives this guidance and pivots to patching the REPL with proper sandboxing

## Why Not Confirmation Dialogs?

Most coding IDEs only show confirmation dialogs in planning mode, not during execution. This is by design:

1. **Flow disruption** — Confirmation dialogs break the agent's execution flow and require the user to be actively watching.
2. **Confirmation fatigue** — Users quickly learn to click "yes" without reading, defeating the purpose.
3. **API harness limitation** — The Yarn proxy operates at the API level, not the client UI level. It cannot inject modal dialogs.
4. **Better alternative** — Graduated guidance (nudge → guide → intervene) achieves the same goal without requiring user attention for benign cases.

The proportionality governance system operates as an invisible guardrail that only activates when changes become disproportionate, rather than asking the user to approve every action.

## Related Code

- `yarn-ts/src/governance/intent-scope-classifier.ts` — Scope envelope classification
- `yarn-ts/src/governance/diff-accumulator.ts` — Cumulative change tracking
- `yarn-ts/src/governance/proportionality-critic.ts` — Optional LLM critic
- `yarn-ts/src/governance/sensemaking-governor.ts` — Signal catalog and friction computation
- `yarn-ts/src/index.ts` — Pipeline integration (4 governance call sites)
- `yarn-ts/tests/proportionality-governance.test.ts` — 43 unit tests
- [`constraint-governance.md`](constraint-governance.md) — Governance precedence
- [`GOVERNOR_HARNESS.md`](GOVERNOR_HARNESS.md) — Reliability invariants and safety boundaries
