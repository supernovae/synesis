import {
  buildClientToolCapabilityBlock,
  type ClientToolCapabilities,
} from "../adapters/client-tool-capabilities.js";
import { formatTaskIntakeBlock, type TaskIntake } from "../planning/task-intake.js";
import { formatPlanProgressBlock, type PlanGraph } from "../planning/plan-graph.js";
import {
  evaluateMemoryRules,
  type MemoryGovernorTracker,
} from "../memory/governor-integration.js";
import {
  buildTaskLedgerGovernanceBlock,
  type ClientTaskCapabilities,
  type TaskLedger,
} from "../task-ledger/index.js";

export interface GovernanceBlockStructuralIndex {
  getStats(): { fileCount: number };
}

export interface BuildRouteGovernanceBlocksInput {
  memoryTracker: MemoryGovernorTracker;
  structuralIndex?: GovernanceBlockStructuralIndex | null;
  sessionMemoryCount: number;
  clientToolCapabilities: ClientToolCapabilities;
  taskIntake?: TaskIntake | null;
  planGraph?: PlanGraph | null;
  relevantEvidenceBlock?: string | null;
  artifactBridgeBlock?: string | null;
  stateConfidenceBlock?: string | null;
  freshImplicitSessionNotice?: string | null;
  governorPauseResumeBlock?: string | null;
  plannerTodoPacketBlock?: string | null;
  taskLedger?: TaskLedger | null;
  taskCapabilities?: ClientTaskCapabilities | null;
}

export interface RouteGovernanceBlocksResult {
  blocks: string[];
  memoryBlocks: string[];
  clientToolBlock: string | null;
  taskLedgerBlock: string | null;
}

export function buildRouteGovernanceBlocks(input: BuildRouteGovernanceBlocksInput): RouteGovernanceBlocksResult {
  if (input.structuralIndex) {
    input.memoryTracker.setIndexAvailable(input.structuralIndex.getStats().fileCount > 0);
  }
  input.memoryTracker.setFindingsCount(input.sessionMemoryCount);

  const memoryBlocks = evaluateMemoryRules(input.memoryTracker.getSignals())
    .filter((rule) => rule.fired)
    .map((rule) => `<MEMORY_GUIDANCE rule="${rule.rule}">\n${rule.message}\n</MEMORY_GUIDANCE>`);
  const clientToolBlock = buildClientToolCapabilityBlock(input.clientToolCapabilities);
  const taskLedgerBlock = buildTaskLedgerGovernanceBlock(input.taskLedger ?? null, input.taskCapabilities ?? null) || null;

  const blocks = [
    ...(input.taskIntake ? [formatTaskIntakeBlock(input.taskIntake)] : []),
    ...(input.planGraph ? [formatPlanProgressBlock(input.planGraph)] : []),
    ...memoryBlocks,
    ...(input.relevantEvidenceBlock ? [input.relevantEvidenceBlock] : []),
    ...(input.artifactBridgeBlock ? [input.artifactBridgeBlock] : []),
    ...(input.stateConfidenceBlock ? [input.stateConfidenceBlock] : []),
    ...(clientToolBlock ? [clientToolBlock] : []),
    ...(input.freshImplicitSessionNotice ? [input.freshImplicitSessionNotice] : []),
    ...(input.governorPauseResumeBlock ? [input.governorPauseResumeBlock] : []),
    ...(input.plannerTodoPacketBlock ? [input.plannerTodoPacketBlock] : []),
    ...(taskLedgerBlock ? [taskLedgerBlock] : []),
  ];

  return {
    blocks,
    memoryBlocks,
    clientToolBlock,
    taskLedgerBlock,
  };
}
