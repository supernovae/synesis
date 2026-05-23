import type { GovernedToolCall } from "../path-governance/tool-call-governance.js";
import type { AdapterToolHardeningResult } from "./tool-call-governor-service.js";

export interface ToolArgHardeningStats {
  normalizedPathCount: number;
  projectRootConstrainedCount: number;
  envelopeUnwrappedCount: number;
  envelopeUnwrappedArgsObjectCount: number;
  envelopeUnwrappedArgsJsonStringCount: number;
  envelopeUnwrappedArgumentsObjectCount: number;
  envelopeUnwrappedArgumentsJsonStringCount: number;
  envelopeUnwrappedInputObjectCount: number;
  envelopeUnwrappedInputJsonStringCount: number;
  blockedBashPathDriftCount: number;
  blockedUnsafeShellCount: number;
  blockedWriteCapableToolCount: number;
  remappedArgsCount: number;
  repairedWriteContentCount: number;
  repairedWriteCount: number;
  repairedBashCount: number;
  validationFailedCount: number;
  qwenParserMismatchSuspectCount: number;
}

export interface ToolRepairObservationInput {
  stats: ToolArgHardeningStats;
  hardening: AdapterToolHardeningResult;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  requestId: string;
  originalToolName: string;
  originalInput: Record<string, unknown>;
}

export interface ToolRepairObservationResult {
  repairCountDelta: number;
}

export function recordAdapterToolRepairObservations(
  input: ToolRepairObservationInput,
): ToolRepairObservationResult {
  const { stats, hardening, logger, requestId, originalToolName, originalInput } = input;
  let repairCountDelta = 0;
  if (hardening.remapped) stats.remappedArgsCount += 1;
  if (hardening.repairedWriteContent) {
    stats.repairedWriteContentCount += 1;
    repairCountDelta += 1;
    logger.warn(
      {
        reqId: requestId,
        originalTool: originalToolName,
        filePath: originalInput.file_path ?? originalInput.path,
      },
      "write_tool_content_array_repaired",
    );
  }
  if (hardening.repairedWrite) {
    stats.repairedWriteCount += 1;
    repairCountDelta += 1;
    logger.warn(
      {
        reqId: requestId,
        originalTool: originalToolName,
        rewrittenTo: "Bash",
        filePath: originalInput.file_path ?? originalInput.path,
      },
      "write_tool_repaired_to_bash_heredoc",
    );
  }
  if (hardening.repairedBash) {
    stats.repairedBashCount += 1;
    repairCountDelta += 1;
    logger.warn({ reqId: requestId, toolName: hardening.toolName, bashRepaired: true }, "bash_tool_args_repaired");
  }
  return { repairCountDelta };
}

export function recordGovernedToolHardeningStats(
  stats: ToolArgHardeningStats,
  governed: GovernedToolCall,
): void {
  if (governed.normalizedPath) stats.normalizedPathCount += 1;
  if (governed.constrainedToRoot) stats.projectRootConstrainedCount += 1;
  if (governed.envelopeUnwrapped) {
    stats.envelopeUnwrappedCount += 1;
    switch (governed.envelopeSource) {
      case "args_object":
        stats.envelopeUnwrappedArgsObjectCount += 1;
        break;
      case "args_json_string":
        stats.envelopeUnwrappedArgsJsonStringCount += 1;
        break;
      case "arguments_object":
        stats.envelopeUnwrappedArgumentsObjectCount += 1;
        break;
      case "arguments_json_string":
        stats.envelopeUnwrappedArgumentsJsonStringCount += 1;
        break;
      case "input_object":
        stats.envelopeUnwrappedInputObjectCount += 1;
        break;
      case "input_json_string":
        stats.envelopeUnwrappedInputJsonStringCount += 1;
        break;
      default:
        break;
    }
  }
  if (governed.blockedBashDrift) stats.blockedBashPathDriftCount += 1;
  if (governed.blockedUnsafeShell) stats.blockedUnsafeShellCount += 1;
  if (governed.blockedWriteCapable) stats.blockedWriteCapableToolCount += 1;
  if (governed.validationMissing.length > 0) stats.validationFailedCount += 1;
}

export function isGitInspectionChurnBlock(governed: GovernedToolCall): boolean {
  return governed.blockedUnsafeShell && /git_inspection_churn/.test(JSON.stringify(governed.input));
}
