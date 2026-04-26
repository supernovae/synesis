# Task Ledger Reconciliation

Client-agnostic task/todo/plan state accounting for the Synesis API harness.

## Problem

Coding agents frequently create task lists (via TodoWrite, plan mode, markdown checklists, or numbered plans), complete the actual work, then forget to mark items done before their final response. This leaves stale progress state that degrades user trust.

Different clients expose different mechanisms:
- **OpenCode**: explicit `todowrite`; the client renders a visible todo list.
- **Claude Code SDK / non-interactive**: `TodoWrite`; Claude Code interactive sessions may expose `TaskCreate` / `TaskUpdate` plus read-only task tools.
- **Cursor**: internal Agent to-dos; Synesis observes text/plan artifacts or explicit todo-like tool calls only. It does not write Cursor's private to-do UI directly.
- **Cline/Roo**: plan/act mode with markdown checklists
- **Generic**: numbered plans or markdown checklists in assistant text

The Synesis harness should normalize these signals and nudge models to reconcile task state before claiming completion.

## Design Principle

**Proportionality governance, not rigid behavior governance.** The harness helps the model keep progress state truthful without preventing useful work.

- The client owns the UI and the native todo/task tool.
- Synesis owns normalized task accounting, reconciliation nudges, and final completion safety.
- The harness does not overwrite client todo state destructively.
- Simple one-shot queries never create a task ledger.

## Architecture

```
Signal Sources                    Task Ledger Module              Integration
─────────────────                 ──────────────────              ───────────
Tool calls (todowrite, etc.) ──→  normalizeTaskToolCall()  ──┐
                                                              ├──→ reconcileTaskLedger
Assistant text (checklists)  ──→  extractTasksFromText()   ──┘         │
                                                                       ├──→ completionGate
Tool results (test/edit)     ──→  reconcileFromEvidence()  ────────────┤
                                                                       ├──→ nudgeBuilder → PromptFrame
PlanContentShadow diffs      ──→  bridgePlanTodoEntries()  ────────────┤
                                                                       └──→ governor enrichment
Client request tools         ──→  detectClientTaskCapabilities()
```

## Module: `src/task-ledger/`

| File | Purpose |
|------|---------|
| `types.ts` | `TaskStatus`, `TaskSource`, `HarnessTask`, `TaskLedger`, `ClientTaskCapabilities`, `TaskCompletionGateResult`, `EvidenceSignal` |
| `detectClientTaskCapabilities.ts` | Scan request tools + clientKind to infer planning mechanism |
| `normalizeTaskToolCall.ts` | Map tool calls from any client into `HarnessTask[]` |
| `extractTasksFromText.ts` | Extract tasks from markdown checklists, numbered plans, and `PlanTodoEntry` bridges |
| `reconcileTaskLedger.ts` | Merge tool/text/evidence updates into `TaskLedger` immutably; serialize/deserialize |
| `buildTaskLedgerNudge.ts` | Generate context-appropriate nudge strings and compact task summaries |
| `scrubTaskLedgerOutput.ts` | Remove internal task-ledger tags and reconciliation instructions from visible assistant text |
| `completionGate.ts` | `evaluateTaskCompletionGate` with soft block, 2-attempt cap, and escape hatch |
| `index.ts` | Barrel export |

## Types

```typescript
type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "obsolete" | "unknown";

type TaskSource =
  | "opencode_todowrite" | "claude_todowrite" | "cline_plan" | "cursor_plan"
  | "markdown_task_list" | "model_plan_text" | "harness_inferred" | "unknown";

interface HarnessTask {
  id: string;
  title: string;
  status: TaskStatus;
  source: TaskSource;
  clientTaskId?: string;
  evidence: string[];
  lastUpdatedTurn: number;
  createdTurn: number;
  confidence: number;  // 0.0–1.0
}

interface TaskLedger {
  sessionId: string;
  tasks: HarnessTask[];
  lastReconciledTurn?: number;
  hasExplicitClientTodoTool: boolean;
  hasExplicitPlanMode: boolean;
  reconciliationAttempts: number;
}
```

## Client Capability Detection

On session initialization, the harness scans the request's `tools` array for known todo/task tool names (case-insensitive, hyphen-to-underscore normalized):

- `todowrite`, `todo_write`, `TodoWrite`, `update_todo`, `task_update`, `TaskUpdate`, `TaskCreate`, `plan_update`
- Read-only capability signals: `todoread`, `TodoRead`, `TaskList`, `TaskGet`
- `CreatePlan`, `SwitchMode` (plan mode indicators)

The `clientKind` field (already resolved upstream) is used to refine the `TaskSource`:
- `opencode` / `opencode-agent` → `opencode_todowrite`
- `claude-code` → `claude_todowrite`
- `cursor` → `cursor_plan`
- `cline` / `roo` → `cline_plan`

All downstream logic operates on `ClientTaskCapabilities`, never on raw client identity.

## Task Extraction

### From tool calls

When the assistant emits a todo/task tool call, the normalizer extracts `HarnessTask[]` at confidence 1.0. The normalizer handles:
- `todowrite` / `TodoWrite`: `{ todos: [{ id, content, status }] }`
- `task_update` / `update_todo` / `TaskCreate` / `TaskUpdate`: `{ id, title/content/description, status, activeForm }`
- `plan_update` / `CreatePlan`: `{ steps: [{ title, status }] }`

Read-only task tools such as `TodoRead`, `TaskList`, and `TaskGet` are used only for capability detection and do not mutate the Synesis ledger.

### From assistant text

When no explicit tool is available, the extractor looks for:
- Markdown checklists (`- [ ] task` / `- [x] task`) at confidence 0.9
- Numbered plans with actionable verbs at confidence 0.7
- Minimum 2 items required; vague commentary is skipped

### From evidence

File edits, test results, and build outcomes update task confidence based on keyword overlap between the task title and the evidence detail.

## Completion Gate

Before the final assistant response, `evaluateTaskCompletionGate` checks:

1. **No ledger or no tasks** → allow immediately
2. **All tasks terminal** (completed/obsolete/blocked) → allow
3. **Open tasks, attempts < 2** → soft block with nudge
4. **Open tasks, attempts >= 2** → allow (escape hatch)

The nudge adapts to the client:
- If explicit todo tool exists: "Call {toolName} to mark each task..."
- If plan mode exists: "Update the plan to reflect..."
- Otherwise: "Include a reconciled task summary..."

## Integration Points in `index.ts`

| Point | Description |
|-------|-------------|
| Session init | `detectClientTaskCapabilities()` called once per session |
| After `governToolCall()` | `maybeUpdateTaskLedgerFromToolCall()` for todo/task tools |
| After `classifyLatestToolProgress()` | `classifyToolResultAsEvidence()` → `reconcileFromEvidence()` |
| Before `finalizeCompletionText()` | `extractTasksFromText()` for text-based task extraction |
| Inside `finalizeCompletionText()` | `evaluateTaskCompletionGate()` with nudge injection |
| `enrichWithFrameAndManifest()` | `buildTaskLedgerGovernanceBlock()` in governance blocks |
| `casSessionSave()` | `serializeTaskLedger()` into `record.metadata.task_ledger` |
| `getSessionState()` | `deserializeTaskLedger()` to restore on session load |
| `evaluateExecutionGovernor()` | `taskLedgerOpenCount` enriches `completion_claim_requires_task_update` |

## Guardrails

- **No infinite loops**: `reconciliationAttempts` caps at 2
- **No per-client branching**: client specifics confined to detect + normalize
- **No false urgency**: simple queries never create a ledger
- **Evidence-based**: confidence requires edit/test evidence, not just claims
- **Immutable**: all ledger functions return new objects
- **Existing rules enhanced**: `completion_claim_requires_task_update` gets richer signal but keeps phase gating

## Tests

`tests/task-ledger.test.ts` covers:
- OpenCode todowrite: 10 tasks created, 1 checked, gate blocks, reconcile all, gate allows
- Claude TodoWrite normalization
- Cline markdown plan extraction
- Generic numbered plan (actionable vs vague)
- Obsolete task handling
- No-tool / simple query (no ledger, no nudges)
- Reconciliation attempt cap (escape hatch)
- Evidence-based confidence
- Client capability detection for all known clients
- Serialization round-trip
