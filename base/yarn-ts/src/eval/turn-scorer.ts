/**
 * Turn Scorer — evaluates per-turn assertions and detects heuristic
 * anomalies (waffling, tool repetition, annotation non-compliance).
 *
 * Also provides scenario-level aggregate scoring.
 */

import type {
  TurnAssertion,
  AssertionResult,
  EvalChatMessage,
  Anomaly,
  TurnResult,
  ScoringCriteria,
} from "./types.js";

// ---------------------------------------------------------------------------
// Waffling marker phrases (model says it will do something without acting)
// ---------------------------------------------------------------------------

const WAFFLING_PHRASES = [
  "i'll implement",
  "let me check",
  "i'll validate",
  "i'll verify",
  "let me verify",
  "let me validate",
  "i'll check the current state",
  "let me check the current state",
  "i'll load the plan",
  "let me load the plan",
  "i'll finish",
  "let me finish",
  "i'll proceed",
  "let me proceed",
  "i'll clean up",
];

const STUB_PHRASES = [
  "unchanged since last read",
  "<file_unchanged",
  "file_unchanged",
  "already read",
  "(cached)",
];

const EDIT_TOOL_NAMES = new Set([
  "write",
  "edit",
  "applypatch",
  "filewrite",
  "strreplace",
  "write_file",
  "file_write",
  "edit_file",
  "str_replace",
  "apply_patch",
  "replace_in_file",
]);

const PLAN_READ_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "glob",
  "list_dir",
  "search",
  "search_code",
  "grep",
]);

const PLAN_WRITE_TOOL_NAMES = new Set([
  "write",
  "write_file",
  "file_write",
  "edit",
  "edit_file",
  "str_replace",
  "apply_patch",
  "applypatch",
  "filewrite",
  "strreplace",
]);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(normalizeToolName(toolName));
}

function containsGovernorPauseMarker(content: string): boolean {
  return content.includes("GOVERNOR PAUSE:") || content.includes("GOVERNOR HARD STOP");
}

function hasTurnExecutionError(turnResults: TurnResult[]): boolean {
  return turnResults.some((tr) =>
    tr.anomalies.some((a) =>
      a.kind === "turn_execution_error" ||
      /^Turn \d+ failed: /i.test(a.detail),
    ),
  );
}

const VERIFICATION_CMD_RE = /\b(test|tests|pytest|vitest|jest|go test|go build|build|lint|typecheck|tsc)\b/i;
const VERIFICATION_SUCCESS_RE = /\b(pass(ed)?|ok\b|build successful|all tests passed|0 failed|tests?\s+passed)\b/i;
const VERIFICATION_FAILURE_RE = /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|exit\s+code\s+[1-9]/i;
const COMPLETION_SIGNAL_RE = /\b(done|completed|finished|implemented|resolved)\b/i;
const VERIFICATION_NON_FAILURE_RE = /\b0\s+failed\b|\bno\s+failures?\b/i;

function normalizeTool(tool: string): string {
  return tool.trim().toLowerCase();
}

function hasVerificationToolIntent(name: string, args: string): boolean {
  const normalized = normalizeTool(name);
  if (normalized.includes("run_test") || normalized === "bash" || normalized === "shell") {
    return VERIFICATION_CMD_RE.test(args);
  }
  return VERIFICATION_CMD_RE.test(normalized) || VERIFICATION_CMD_RE.test(args);
}

function hasVerificationEvidence(turnResults: TurnResult[]): boolean {
  for (const turn of turnResults) {
    const verifyToolCallIds = new Set<string>();
    let sawVerificationIntent = false;
    for (const msg of turn.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const args = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? "");
          if (hasVerificationToolIntent(call.function.name, args)) {
            sawVerificationIntent = true;
            verifyToolCallIds.add(call.id);
          }
        }
      }
      if (msg.role === "tool" && sawVerificationIntent) {
        const linkedToVerification = !msg.tool_call_id || verifyToolCallIds.size === 0 || verifyToolCallIds.has(msg.tool_call_id);
        if (!linkedToVerification) continue;
        const text = typeof msg.content === "string" ? msg.content : "";
        const hasSuccess = VERIFICATION_SUCCESS_RE.test(text);
        const hasFailure = VERIFICATION_FAILURE_RE.test(text) && !VERIFICATION_NON_FAILURE_RE.test(text);
        if (hasSuccess && !hasFailure) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasAnyEditAction(turnResults: TurnResult[]): boolean {
  return turnResults.some((turn) =>
    turn.messages.some((msg) =>
      msg.role === "assistant"
      && (msg.tool_calls ?? []).some((tc) => isEditTool(tc.function.name)),
    ),
  );
}

function hasCompletionSignal(turnResults: TurnResult[]): boolean {
  const assistantMessages = turnResults.flatMap((tr) =>
    tr.messages.filter((m) => m.role === "assistant"),
  );
  const textualSignal = assistantMessages.some((m) =>
    typeof m.content === "string" && COMPLETION_SIGNAL_RE.test(m.content),
  );
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const finalNarrativeResponse = !!lastAssistant && !(lastAssistant.tool_calls?.length ?? 0);
  return textualSignal || finalNarrativeResponse;
}

export function computeSessionCompletionKpi(turnResults: TurnResult[]): {
  taskFinished: boolean;
  verificationEvidence: boolean;
  completed: boolean;
} {
  const taskFinished = hasAnyEditAction(turnResults) && hasCompletionSignal(turnResults);
  const verificationEvidence = hasVerificationEvidence(turnResults);
  return {
    taskFinished,
    verificationEvidence,
    completed: taskFinished && verificationEvidence,
  };
}

function inferScenarioOutcome(
  turnResults: TurnResult[],
  allGovernorRules: string[],
): "completed" | "governor_stopped" | "incomplete" {
  const governorPaused =
    allGovernorRules.some((r) => r !== "allow" && r !== "disabled") ||
    turnResults.some((tr) =>
      tr.messages.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          containsGovernorPauseMarker(m.content),
      ),
    );
  if (governorPaused) return "governor_stopped";
  if (hasTurnExecutionError(turnResults)) return "incomplete";

  const completionKpi = computeSessionCompletionKpi(turnResults);
  if (completionKpi.completed) {
    return "completed";
  }

  const assistantMessages = turnResults.flatMap((tr) =>
    tr.messages.filter((m) => m.role === "assistant"),
  );
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  if (lastAssistant && !(lastAssistant.tool_calls?.length ?? 0)) {
    return "completed";
  }
  return "incomplete";
}

// ---------------------------------------------------------------------------
// Anomaly detection (heuristic, no assertions required)
// ---------------------------------------------------------------------------

export function detectAnomalies(messages: EvalChatMessage[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const assistantMessages = messages.filter(m => m.role === "assistant");

  // Repeated assistant content
  const contentCounts = new Map<string, number>();
  for (const m of assistantMessages) {
    const text = typeof m.content === "string" ? m.content.trim().slice(0, 200) : "";
    if (!text) continue;
    contentCounts.set(text, (contentCounts.get(text) ?? 0) + 1);
  }
  for (const [text, count] of contentCounts) {
    if (count >= 2) {
      anomalies.push({
        kind: "repeated_content",
        detail: `Assistant repeated "${text.slice(0, 80)}..." ${count} times`,
        severity: count >= 3 ? "error" : "warning",
      });
    }
  }

  // Repeated tool calls (same name + same args)
  const toolCallSigs = new Map<string, number>();
  for (const m of assistantMessages) {
    for (const tc of m.tool_calls ?? []) {
      const sig = `${tc.function.name}:${tc.function.arguments}`;
      toolCallSigs.set(sig, (toolCallSigs.get(sig) ?? 0) + 1);
    }
  }
  for (const [sig, count] of toolCallSigs) {
    if (count >= 2) {
      const name = sig.split(":")[0];
      anomalies.push({
        kind: "repeated_tool_call",
        detail: `Tool "${name}" called with same args ${count} times`,
        severity: count >= 3 ? "error" : "warning",
      });
    }
  }

  // Waffling markers without edits
  const hasEdit = assistantMessages.some((m) =>
    (m.tool_calls ?? []).some((tc) => isEditTool(tc.function.name)),
  );
  if (!hasEdit) {
    for (const m of assistantMessages) {
      const text = (typeof m.content === "string" ? m.content : "").toLowerCase();
      for (const phrase of WAFFLING_PHRASES) {
        if (text.includes(phrase)) {
          anomalies.push({
            kind: "waffling_marker",
            detail: `"${phrase}" without any edit tool calls`,
            severity: "warning",
          });
          break;
        }
      }
    }
  }

  // Stub content in tool results
  const toolMessages = messages.filter(m => m.role === "tool");
  for (const m of toolMessages) {
    const text = (typeof m.content === "string" ? m.content : "").toLowerCase();
    for (const stub of STUB_PHRASES) {
      if (text.includes(stub)) {
        anomalies.push({
          kind: "stub_content_detected",
          detail: `Tool result contains stub phrase: "${stub}"`,
          severity: "warning",
        });
        break;
      }
    }
  }

  // Plan re-read after update
  const planReads: number[] = [];
  const planWrites: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const tc of m.tool_calls ?? []) {
      const args = tc.function.arguments;
      const isPlanPath = args.includes(".claude/plans/") || args.includes("plans/");
      if (!isPlanPath) continue;
      const toolName = normalizeToolName(tc.function.name);
      if (PLAN_READ_TOOL_NAMES.has(toolName)) planReads.push(i);
      if (PLAN_WRITE_TOOL_NAMES.has(toolName)) planWrites.push(i);
    }
  }
  for (const writeIdx of planWrites) {
    const laterReads = planReads.filter(r => r > writeIdx);
    if (laterReads.length > 0) {
      anomalies.push({
        kind: "plan_re_read_after_update",
        detail: `Plan re-read at message ${laterReads[0]} after update at ${writeIdx}`,
        severity: "warning",
      });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Per-turn assertion evaluation
// ---------------------------------------------------------------------------

export function scoreTurn(
  assertions: TurnAssertion[],
  messages: EvalChatMessage[],
  governorRules: string[],
  anomalies: Anomaly[],
): AssertionResult[] {
  return assertions.map(a => evaluateAssertion(a, messages, governorRules, anomalies));
}

function evaluateAssertion(
  assertion: TurnAssertion,
  messages: EvalChatMessage[],
  governorRules: string[],
  anomalies: Anomaly[],
): AssertionResult {
  switch (assertion.type) {
    case "governor_paused": {
      const pauseRules = governorRules.filter(r => r !== "allow" && r !== "disabled");
      // Also detect from message content when admin API is unavailable
      const contentPause = messages.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          containsGovernorPauseMarker(m.content),
      );
      const passed = pauseRules.length > 0 || contentPause;
      return {
        assertion,
        passed,
        detail: passed
          ? `Rules: ${pauseRules.join(", ") || "detected in message content"}`
          : "Governor did not pause",
      };
    }

    case "governor_not_paused": {
      const pauseRules = governorRules.filter(r => r !== "allow" && r !== "disabled");
      const contentPause = messages.some(
        (m) =>
          m.role === "assistant" &&
          typeof m.content === "string" &&
          containsGovernorPauseMarker(m.content),
      );
      const passed = pauseRules.length === 0 && !contentPause;
      return {
        assertion,
        passed,
        detail: passed ? "No pause" : `Unexpected pause: ${pauseRules.join(", ") || "detected in message content"}`,
      };
    }

    case "contains_edit": {
      const hasEdit = messages.some((m) =>
        m.role === "assistant" &&
        (m.tool_calls ?? []).some((tc) => isEditTool(tc.function.name)),
      );
      return { assertion, passed: hasEdit, detail: hasEdit ? "Edit found" : "No edit tool calls" };
    }

    case "no_repeated_tool": {
      const repeats = anomalies.filter(a => a.kind === "repeated_tool_call");
      const passed = repeats.length === 0;
      return { assertion, passed, detail: passed ? "No repeats" : repeats.map(r => r.detail).join("; ") };
    }

    case "recovery_block_present": {
      const hasRecovery = messages.some(m =>
        typeof m.content === "string" && (
          m.content.includes("SYNESIS_RECOVERY") ||
          m.content.includes("STOP running") ||
          m.content.includes("STOP searching")
        ),
      );
      return { assertion, passed: hasRecovery, detail: hasRecovery ? "Recovery block found" : "No recovery block" };
    }

    case "annotation_present": {
      const marker = String(assertion.params?.marker ?? "");
      const hasAnnotation = messages.some(m =>
        typeof m.content === "string" && m.content.includes(marker),
      );
      return { assertion, passed: hasAnnotation, detail: hasAnnotation ? `Found: ${marker}` : `Missing: ${marker}` };
    }

    case "tool_count_lte": {
      const max = Number(assertion.params?.max ?? 10);
      const count = messages.filter(m => m.role === "assistant").reduce(
        (n, m) => n + (m.tool_calls?.length ?? 0), 0,
      );
      const passed = count <= max;
      return { assertion, passed, detail: `${count} tool calls (max ${max})` };
    }

    case "no_stub_content": {
      const stubs = anomalies.filter(a => a.kind === "stub_content_detected");
      const passed = stubs.length === 0;
      return { assertion, passed, detail: passed ? "No stubs" : stubs.map(s => s.detail).join("; ") };
    }

    case "content_matches": {
      const pattern = new RegExp(String(assertion.params?.pattern ?? ""), "i");
      const match = messages.some(m =>
        m.role === "assistant" && typeof m.content === "string" && pattern.test(m.content),
      );
      return { assertion, passed: match, detail: match ? "Pattern matched" : "Pattern not found" };
    }

    case "no_waffling_markers": {
      const waffles = anomalies.filter(a => a.kind === "waffling_marker");
      const passed = waffles.length === 0;
      return { assertion, passed, detail: passed ? "No waffling" : waffles.map(w => w.detail).join("; ") };
    }

    case "tool_name_present": {
      const name = String(assertion.params?.name ?? "");
      const found = messages.some(m =>
        m.role === "assistant" && (m.tool_calls ?? []).some(tc => tc.function.name === name),
      );
      return { assertion, passed: found, detail: found ? `Found: ${name}` : `Missing: ${name}` };
    }

    case "tool_name_absent": {
      const name = String(assertion.params?.name ?? "");
      const found = messages.some(m =>
        m.role === "assistant" && (m.tool_calls ?? []).some(tc => tc.function.name === name),
      );
      return { assertion, passed: !found, detail: found ? `Unexpected: ${name}` : `Absent: ${name}` };
    }

    default:
      return { assertion, passed: false, detail: `Unknown assertion type: ${assertion.type}` };
  }
}

function hasRequiredToolAction(turnResults: TurnResult[], requiredToolName: string): boolean {
  const normalizedRequired = normalizeTool(requiredToolName);
  return turnResults.some((turn) =>
    turn.messages.some((msg) =>
      msg.role === "assistant"
      && (msg.tool_calls ?? []).some((call) => normalizeTool(call.function.name) === normalizedRequired),
    ),
  );
}

function hasArtifactPathEvidence(turnResults: TurnResult[], artifactPath: string): boolean {
  const needle = artifactPath.trim();
  if (!needle) return true;
  return turnResults.some((turn) =>
    turn.messages.some((msg) => {
      if (msg.role === "assistant") {
        return (msg.tool_calls ?? []).some((call) => {
          const args = typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? "");
          return args.includes(needle);
        });
      }
      if (msg.role === "tool") {
        return typeof msg.content === "string" && msg.content.includes(needle);
      }
      return false;
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario-level scoring
// ---------------------------------------------------------------------------

export function scoreScenario(
  criteria: ScoringCriteria,
  turnResults: TurnResult[],
  allGovernorRules: string[],
  governorInterventions: number,
): { passed: boolean; score: number; failureReasons: string[] } {
  const failures: string[] = [];
  let score = 1.0;
  const completionKpi = computeSessionCompletionKpi(turnResults);

  if (criteria.requiredOutcome) {
    const observed = inferScenarioOutcome(turnResults, allGovernorRules);
    if (observed !== criteria.requiredOutcome) {
      failures.push(`Required outcome not reached: expected ${criteria.requiredOutcome}, got ${observed}`);
      score -= 0.3;
    }
  }

  if (turnResults.length > criteria.maxTotalTurns) {
    failures.push(`Exceeded max turns: ${turnResults.length} > ${criteria.maxTotalTurns}`);
    score -= 0.3;
  }

  if (criteria.maxGovernorInterventions !== undefined && governorInterventions > criteria.maxGovernorInterventions) {
    failures.push(`Too many governor interventions: ${governorInterventions} > ${criteria.maxGovernorInterventions}`);
    score -= 0.2;
  }

  if (criteria.requireVerificationEvidence && !completionKpi.verificationEvidence) {
    failures.push("Missing concrete verification evidence (passing build/test output)");
    score -= 0.2;
  }

  if (criteria.requireSessionCompletionKpi && !completionKpi.completed) {
    failures.push(
      `Session completion KPI not met (taskFinished=${completionKpi.taskFinished}, verificationEvidence=${completionKpi.verificationEvidence})`,
    );
    score -= 0.25;
  }

  if (criteria.requiredToolActions?.length) {
    const missingTools = criteria.requiredToolActions.filter((toolName) =>
      !hasRequiredToolAction(turnResults, toolName),
    );
    if (missingTools.length > 0) {
      failures.push(`Missing required tool actions: ${missingTools.join(", ")}`);
      score -= 0.15;
    }
  }

  if (criteria.requiredArtifactPaths?.length) {
    const missingArtifacts = criteria.requiredArtifactPaths.filter((artifactPath) =>
      !hasArtifactPathEvidence(turnResults, artifactPath),
    );
    if (missingArtifacts.length > 0) {
      failures.push(`Missing required artifact evidence: ${missingArtifacts.join(", ")}`);
      score -= 0.15;
    }
  }

  if (criteria.failIfRules?.length) {
    const fired = criteria.failIfRules.filter(r => allGovernorRules.includes(r));
    if (fired.length > 0) {
      failures.push(`Forbidden governor rules fired: ${fired.join(", ")}`);
      score -= 0.3;
    }
  }

  if (criteria.passIfRules?.length) {
    const missing = criteria.passIfRules.filter(r => !allGovernorRules.includes(r));
    if (missing.length > 0) {
      failures.push(`Required governor rules did not fire: ${missing.join(", ")}`);
      score -= 0.3;
    }
  }

  const totalAssertionsFailed = turnResults.reduce(
    (n, tr) => n + tr.assertionResults.filter(a => !a.passed).length, 0,
  );
  if (totalAssertionsFailed > 0) {
    failures.push(`${totalAssertionsFailed} turn assertion(s) failed`);
    score -= 0.1 * totalAssertionsFailed;
  }

  if (hasTurnExecutionError(turnResults)) {
    failures.push("Turn execution failed before scenario completion");
    score -= 0.4;
  }

  const totalAnomalies = turnResults.reduce((n, tr) => n + tr.anomalies.filter(a => a.severity === "error").length, 0);
  if (totalAnomalies > 0) {
    score -= 0.05 * totalAnomalies;
  }

  score = Math.max(0, Math.min(1, score));
  const passed = failures.length === 0 && score >= 0.7;

  return { passed, score: Number(score.toFixed(3)), failureReasons: failures };
}
