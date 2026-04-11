import path from "node:path";
import {
  constrainFileToolPathToProjectRoot,
  normalizeFileToolArgs,
  validateToolArgs,
} from "../providers/model-adapter.js";
import { canonicalValidationToolName } from "../tool-aliases.js";

export interface GovernToolCallOptions {
  toolName: string;
  input: Record<string, unknown>;
  projectRoot?: string | null;
  shellCwd?: string | null;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  strictBashBlock?: boolean;
  strictValidationBlock?: boolean;
  blockWriteCapableTools?: boolean;
  clientKind?: string;
}

export interface GovernedToolCall {
  toolName: string;
  input: Record<string, unknown>;
  normalizedPath: boolean;
  constrainedToRoot: boolean;
  blockedUnsafeShell: boolean;
  blockedWriteCapable: boolean;
  blockedBashDrift: boolean;
  validationMissing: string[];
}

/** One-line JSON on stderr + exit 2 — parseable by agents (schema_version bumps are breaking). */
export function buildStructuredErrorBashCommand(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return `printf '%s\\n' ${shellEscape(json)} >&2; exit 2`;
}

export function governToolCall(opts: GovernToolCallOptions): GovernedToolCall {
  const logicalName = canonicalValidationToolName(opts.toolName);
  const requestedFilePath = typeof opts.input.file_path === "string" ? opts.input.file_path.trim() : "";
  const out: GovernedToolCall = {
    toolName: opts.toolName,
    input: { ...opts.input },
    normalizedPath: false,
    constrainedToRoot: false,
    blockedUnsafeShell: false,
    blockedWriteCapable: false,
    blockedBashDrift: false,
    validationMissing: [],
  };

  const subagentProtection = maybeBlockSubagentExploration(logicalName, opts.clientKind);
  if (subagentProtection) {
    out.toolName = subagentProtection.toolName;
    out.input = subagentProtection.input;
    return out;
  }

  const pathNorm = normalizeFileToolArgs(logicalName, out.input);
  if (pathNorm.normalized) {
    out.input = pathNorm.input;
    out.normalizedPath = true;
  }

  const anchorRoot = resolvedAnchorRoot(opts.projectRoot, opts.shellCwd);
  if (opts.enforcePathRoot && anchorRoot) {
    const rootClamp = constrainFileToolPathToProjectRoot(anchorRoot, logicalName, out.input);
    if (rootClamp.constrained) {
      out.input = rootClamp.input;
      out.constrainedToRoot = true;
      const pathRecovery = recoverConstrainedPathRequest(logicalName, requestedFilePath, out.input);
      if (pathRecovery) {
        out.toolName = pathRecovery.toolName;
        out.input = pathRecovery.input;
        return out;
      }
    }
  }

  if (opts.blockWriteCapableTools && isWriteCapableTool(logicalName)) {
    const message = `Synesis Yarn blocked write-capable tool '${logicalName}' for this client safety profile.`;
    if (opts.clientKind === "claude-code") {
      out.toolName = "Synesis_Error_WriteCapableBlocked";
      out.input = {
        synesis_error: true,
        reason: "write_capable_blocked",
        original_tool: logicalName,
        message,
        retryable: false,
      };
    } else {
      out.toolName = "Bash";
      out.input = {
        command: buildStructuredErrorBashCommand({
          synesis_error: true,
          schema_version: 1,
          category: "policy",
          reason: "write_capable_blocked",
          original_tool: logicalName,
          message,
          retryable: false,
        }),
        description: "Blocked write-capable tool for safety profile",
      };
    }
    out.blockedWriteCapable = true;
    return out;
  }

  const planPlaceholderProtection = maybeBlockPlanPlaceholderWrite(logicalName, out.input, opts.clientKind);
  if (planPlaceholderProtection) {
    out.toolName = planPlaceholderProtection.toolName;
    out.input = planPlaceholderProtection.input;
    out.blockedWriteCapable = true;
    return out;
  }

  if ((opts.blockBashPathDrift || opts.strictBashBlock) && logicalName === "Bash") {
    const command = out.input.command;
    if (typeof command === "string" && command.trim()) {
      const gitInspectionChurn = detectCompoundGitInspection(command, opts.clientKind);
      if (gitInspectionChurn) {
        const message = `Synesis Yarn blocked low-yield git inspection churn: ${gitInspectionChurn.reason}. Perform one concrete action next (Edit/Write, test/build, or git add/commit).`;
        if (opts.clientKind === "claude-code") {
          out.toolName = "Synesis_Error_GitInspectionChurn";
          out.input = {
            synesis_error: true,
            reason: "git_inspection_churn",
            detail: gitInspectionChurn.reason,
            message,
            retryable: true,
          };
        } else {
          out.input = {
            command: buildStructuredErrorBashCommand({
              synesis_error: true,
              schema_version: 1,
              category: "policy",
              reason: "git_inspection_churn",
              detail: gitInspectionChurn.reason,
              message,
              retryable: true,
            }),
            description: "Blocked low-yield git inspection churn",
          };
        }
        out.blockedUnsafeShell = true;
        return out;
      }
      const pathDrift = opts.blockBashPathDrift ? detectBashPathDrift(command) : null;
      const dangerous = detectDangerousBash(command);
      if (pathDrift || dangerous) {
        const detail = pathDrift?.reason ?? dangerous?.reason ?? "unsafe shell command";
        const message = `Synesis Yarn blocked unsafe shell command: ${detail}. Use safe structured tools from project root.`;
        if (opts.clientKind === "claude-code") {
          out.toolName = "Synesis_Error_UnsafeShell";
          out.input = {
            synesis_error: true,
            reason: "unsafe_shell",
            detail,
            message,
            retryable: true,
          };
        } else {
          out.input = {
            command: buildStructuredErrorBashCommand({
              synesis_error: true,
              schema_version: 1,
              category: "policy",
              reason: "unsafe_shell",
              detail,
              message,
              retryable: true,
            }),
            description: "Blocked unsafe shell command",
          };
        }
        out.blockedUnsafeShell = true;
        if (pathDrift) out.blockedBashDrift = true;
        return out;
      }
    }
  }

  const validation = validateToolArgs(logicalName, out.input);
  if (!validation.valid) {
    out.validationMissing = validation.missing;
    const recovered = recoverValidationFailure(logicalName, out.input, validation.missing);
    if (recovered) {
      out.toolName = recovered.toolName;
      out.input = recovered.input;
      out.validationMissing = [];
      return out;
    }
    if (opts.strictValidationBlock !== false) {
      const human = `Synesis Yarn blocked invalid tool arguments for ${out.toolName}: missing ${validation.missing.join(", ")}`;
      if (opts.clientKind === "claude-code") {
        out.toolName = "Synesis_Error_ValidationFailed";
        out.input = {
          synesis_error: true,
          reason: "validation_failed",
          original_tool: logicalName,
          missing: validation.missing,
          message: human,
          hint: validationHint(logicalName, validation.missing),
          retryable: true,
        };
      } else {
        out.toolName = "Bash";
        out.input = {
          command: buildStructuredErrorBashCommand({
            synesis_error: true,
            schema_version: 1,
            category: "validation",
            original_tool: logicalName,
            missing: validation.missing,
            message: human,
            hint: validationHint(logicalName, validation.missing),
            retryable: true,
          }),
          description: "Blocked invalid tool arguments",
        };
      }
    }
  }
  return out;
}

function recoverValidationFailure(
  logicalName: string,
  input: Record<string, unknown>,
  missing: string[],
): { toolName: string; input: Record<string, unknown> } | null {
  // Common model failure: Edit missing old_string.
  // Recover by issuing a Read on the same file so the model can retry with exact text.
  if (
    (logicalName === "Edit" || logicalName === "Update")
    && missing.includes("old_string")
    && typeof input.file_path === "string"
    && input.file_path.trim()
  ) {
    return {
      toolName: "Read",
      input: { file_path: input.file_path },
    };
  }
  // Common model failure: Glob called without glob_pattern.
  // Recover with a bounded broad pattern so the model gets file candidates and can retry.
  if (logicalName === "Glob" && missing.includes("glob_pattern")) {
    const targetDirectory =
      typeof input.target_directory === "string" && input.target_directory.trim()
        ? input.target_directory.trim()
        : undefined;
    return {
      toolName: "Glob",
      input: targetDirectory
        ? { target_directory: targetDirectory, glob_pattern: "*" }
        : { glob_pattern: "*" },
    };
  }
  return null;
}

function validationHint(logicalName: string, missing: string[]): string {
  const base = `Provide required fields (${missing.join(", ")}) using exact parameter names from the tool schema.`;
  if (logicalName === "Edit" || logicalName === "Update") {
    if (missing.includes("old_string")) {
      return `${base} For Edit/Update, include BOTH old_string (exact text to replace) and new_string (replacement text). If replacing an entire file, use Write(file_path, content) instead.`;
    }
    return `${base} For Edit/Update, required params are file_path, old_string, new_string.`;
  }
  if (logicalName === "Write") {
    return `${base} For Write, required params are file_path and content.`;
  }
  if (logicalName === "Glob") {
    return `${base} For Glob, required param is glob_pattern (for example "*.py" or "**/*.test.ts").`;
  }
  return `${base} Example: Write uses file_path and content.`;
}

function recoverConstrainedPathRequest(
  logicalName: string,
  requestedFilePath: string,
  governedInput: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } | null {
  if (!(logicalName === "Edit" || logicalName === "Update")) return null;
  if (!requestedFilePath || !path.isAbsolute(requestedFilePath)) return null;
  const governedPath = typeof governedInput.file_path === "string" ? governedInput.file_path.trim() : "";
  if (!governedPath) return null;
  const base = path.basename(governedPath);
  if (!base) return null;
  // If an absolute path was clamped into project root, discover candidates first.
  // This avoids "file not found" on a potentially wrong basename and gives deterministic next steps.
  return {
    toolName: "Glob",
    input: { glob_pattern: `**/${base}` },
  };
}

function isWriteCapableTool(logicalName: string): boolean {
  return logicalName === "Write"
    || logicalName === "Edit"
    || logicalName === "Update";
}

function maybeBlockPlanPlaceholderWrite(
  logicalName: string,
  input: Record<string, unknown>,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown> } | null {
  if (!isWriteCapableTool(logicalName)) return null;
  const filePath = typeof input.file_path === "string" ? input.file_path.trim() : "";
  if (!filePath) return null;
  const isClaudePlanFile =
    filePath.includes("/.claude/plans/")
    && filePath.toLowerCase().endsWith(".md");
  if (!isClaudePlanFile) return null;

  const writeBody = logicalName === "Write"
    ? String(input.content ?? "")
    : String(input.new_string ?? "");
  const lowerBody = writeBody.toLowerCase();
  if (!lowerBody.includes("no plan file exists yet")
    || !lowerBody.includes("this is a fresh session")) {
    return null;
  }

  const message = "Synesis Yarn blocked destructive placeholder overwrite for a Claude plan file. Re-read the plan and preserve existing tasks instead of writing a 'fresh session' placeholder.";
  if (clientKind === "claude-code") {
    return {
      toolName: "Synesis_Error_PlanPlaceholderBlocked",
      input: {
        synesis_error: true,
        reason: "plan_placeholder_blocked",
        original_tool: logicalName,
        file_path: filePath,
        message,
        retryable: true,
      },
    };
  }
  return {
    toolName: "Bash",
    input: {
      command: buildStructuredErrorBashCommand({
        synesis_error: true,
        schema_version: 1,
        category: "policy",
        reason: "plan_placeholder_blocked",
        original_tool: logicalName,
        file_path: filePath,
        message,
        retryable: true,
      }),
      description: "Blocked destructive placeholder write to Claude plan file",
    },
  };
}

function maybeBlockSubagentExploration(
  logicalName: string,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown> } | null {
  if (clientKind !== "claude-code") return null;
  const lower = logicalName.trim().toLowerCase();
  if (lower !== "agent" && lower !== "explore") return null;
  const message = "Synesis Yarn blocked subagent-style exploration for this session because it causes low-yield wandering loops. Use direct tools instead: Read specific files, then Edit/Write one concrete change.";
  return {
    toolName: "Synesis_Error_SubagentBlocked",
    input: {
      synesis_error: true,
      reason: "subagent_exploration_blocked",
      original_tool: logicalName,
      message,
      retryable: true,
    },
  };
}

function resolvedAnchorRoot(projectRoot?: string | null, shellCwd?: string | null): string | null {
  const root = (projectRoot ?? "").trim();
  if (root) return root;
  const cwd = (shellCwd ?? "").trim();
  return cwd || null;
}

function detectDangerousBash(command: string): { reason: string } | null {
  const c = command.trim().toLowerCase();
  if (/\brm\s+-rf\s+/.test(c)) {
    return { reason: "rm -rf is disallowed" };
  }
  if (/\bgit\s+clean\s+-f/.test(c)) {
    return { reason: "git clean -f is disallowed" };
  }
  if (/\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/.test(c)) {
    return { reason: "destructive system command detected" };
  }
  
  return null;
}

function detectCompoundGitInspection(command: string, clientKind?: string): { reason: string } | null {
  if (clientKind !== "claude-code") return null;
  const c = command.trim().toLowerCase();
  const hasAction =
    /\bgit\s+add\b/.test(c)
    || /\bgit\s+commit\b/.test(c)
    || /\bgit\s+push\b/.test(c)
    || /\bgit\s+checkout\b/.test(c)
    || /\bgit\s+restore\b/.test(c);
  if (hasAction) return null;
  const inspectMatches = [
    /\bgit\s+status\b/.test(c),
    /\bgit\s+diff\b/.test(c),
    /\bgit\s+log\b/.test(c),
    /\bgit\s+show\b/.test(c),
  ].filter(Boolean).length;
  // Allow single, targeted git introspection calls. Block only chained / mixed
  // inspection commands that tend to loop with qwen in Claude Code sessions.
  const chained = c.includes("&&") || c.includes(";");
  if (inspectMatches >= 2 || (inspectMatches >= 1 && chained)) {
    return { reason: "compound git status/diff/log inspection without action" };
  }
  return null;
}

function normalizeTokenPath(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/g, "");
}

function detectBashPathDrift(command: string): { reason: string } | null {
  const c = command.trim();
  const m = /mkdir(?:\s+-p)?\s+([^\s;&|]+)\s*(?:&&|;)\s*cd\s+([^\s;&|]+)/i.exec(c);
  if (!m) return null;
  const created = normalizeTokenPath(m[1]);
  const changed = normalizeTokenPath(m[2]);
  if (!created || !changed) return null;
  if (created === changed) {
    return { reason: "mkdir && cd path drift detected (duplicate segment)" };
  }
  return null;
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
