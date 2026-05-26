import type { GovernedToolCall } from "../path-governance/tool-call-governance.js";
import type { SessionState } from "../state/session-state.js";
import {
  isFileDeletion,
  recordEditOperation,
  recordFileDeletion,
} from "./diff-accumulator.js";

export interface RouteDiffAccumulatorOptions {
  proportionalityEnabled: boolean;
}

export function createRouteDiffAccumulatorUpdater(
  options: RouteDiffAccumulatorOptions,
): (session: SessionState, governed: GovernedToolCall) => void {
  return (session, governed) => {
    if (!options.proportionalityEnabled) return;
    if (session.scopeEnvelope === "unconstrained" || session.scopeEnvelope === "removal_ok") return;

    const logicalName = governed.toolName;
    const input = governed.input;

    if (logicalName.startsWith("Synesis_Error")) return;

    const writeTools = new Set(["Write", "Edit", "Update", "MultiEdit", "FileWrite", "ApplyPatch", "StrReplace"]);
    if (!writeTools.has(logicalName) && logicalName !== "Bash") return;

    const filePath = typeof input.file_path === "string" ? input.file_path.trim()
      : typeof input.path === "string" ? input.path.trim() : "";

    if (writeTools.has(logicalName) && filePath) {
      const content = typeof input.content === "string" ? input.content : undefined;
      if (logicalName === "Write" || logicalName === "FileWrite") {
        if (isFileDeletion(content)) {
          recordFileDeletion(session.diffStats, filePath, 50);
        } else {
          const lines = (content ?? "").split("\n").length;
          recordEditOperation(session.diffStats, filePath, lines, 0);
        }
      } else {
        const oldStr = typeof input.old_string === "string" ? input.old_string : "";
        const newStr = typeof input.new_string === "string" ? input.new_string : "";
        const oldLines = oldStr ? oldStr.split("\n").length : 0;
        const newLines = newStr ? newStr.split("\n").length : 0;
        recordEditOperation(session.diffStats, filePath, newLines, oldLines);
      }
    }
  };
}
