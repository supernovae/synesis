export type {
  TaskStatus,
  TaskSource,
  HarnessTask,
  TaskLedger,
  ClientTaskCapabilities,
  TaskCompletionGateResult,
  EvidenceSignal,
} from "./types.js";

export { detectClientTaskCapabilities } from "./detectClientTaskCapabilities.js";

export { isTaskToolCall, normalizeTaskToolCall } from "./normalizeTaskToolCall.js";

export { extractTasksFromText, bridgePlanTodoEntries } from "./extractTasksFromText.js";

export {
  reconcileFromToolCall,
  reconcileFromText,
  reconcileFromEvidence,
  decayStaleTaskConfidence,
  createEmptyLedger,
  serializeTaskLedger,
  deserializeTaskLedger,
} from "./reconcileTaskLedger.js";

export {
  buildTaskLedgerSummary,
  buildTaskLedgerNudge,
  buildTaskLedgerGovernanceBlock,
} from "./buildTaskLedgerNudge.js";

export { scrubTaskLedgerOutput, type TaskLedgerOutputScrubResult } from "./scrubTaskLedgerOutput.js";

export {
  evaluateTaskCompletionGate,
  incrementReconciliationAttempts,
} from "./completionGate.js";
