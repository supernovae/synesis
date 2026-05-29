import path from "node:path";
import {
  constrainFileToolPathToProjectRoot,
  normalizeFileToolArgs,
  remapCommonToolArgAliases,
  validateToolArgs,
} from "../providers/model-adapter.js";
import { canonicalValidationToolName } from "../tool-aliases.js";
import {
  validatePlanWriteContent,
  containsStubPhrase,
  hashContent,
  type PlanContentShadow,
  type PlanWriteValidationResult,
} from "../planning/plan-content-shadow.js";
import {
  evaluatePathAccess,
  extractBashFilePaths,
  type PathSandboxPolicy,
  type PathOperation,
} from "./path-sandbox.js";
import { isCoderClientKind } from "../session/session-key.js";

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
  restrictDiscoveryForPlanWork?: boolean;
  blockBroadVerificationForGreen?: boolean;
  blockVerificationForFailure?: boolean;
  planContentShadow?: PlanContentShadow | null;
  /** Per-file artifact shadows for stale-write detection on non-plan files. */
  artifactShadows?: ReadonlyMap<string, { stale: boolean; canonicalPath: string }>;
  /** Current turn index for edit-turn tracking. */
  currentTurnIndex?: number;
  /** Callback to record an edit turn for artifact shadow staleness. */
  onEditTurn?: (canonicalPath: string, turnIndex: number) => void;
  /** Total git inspection blocks so far in this session. Allows a grace first offense. */
  sessionGitInspectionBlockCount?: number;
  /** Path sandbox policy. When set, file operations outside allowed paths are blocked. */
  pathSandboxPolicy?: PathSandboxPolicy | null;
}

export interface PlanWriteAuditRecord {
  allowed: boolean;
  path: string;
  reason?: string;
  proposedContentHash?: string;
  shadowContentHash?: string;
  validation?: PlanWriteValidationResult;
}

export interface GovernedToolCall {
  toolName: string;
  input: Record<string, unknown>;
  normalizedPath: boolean;
  constrainedToRoot: boolean;
  envelopeUnwrapped: boolean;
  envelopeSource: string | null;
  blockedUnsafeShell: boolean;
  blockedWriteCapable: boolean;
  blockedBashDrift: boolean;
  validationMissing: string[];
  planWriteAudit?: PlanWriteAuditRecord;
  blockedStaleWrite?: boolean;
  blockedStubContent?: boolean;
  blockedPathSandbox?: boolean;
  pathSandboxNudge?: string;
}

const WRITE_CAPABLE_LOGICAL = new Set([
  "Write", "Edit", "Update", "MultiEdit", "FileWrite", "ApplyPatch", "StrReplace",
]);

function isPlanPath(filePath: string): boolean {
  return /\.claude\/plans\//.test(filePath);
}

/** One-line JSON on stderr + exit 2 — parseable by agents (schema_version bumps are breaking). */
export function buildStructuredErrorBashCommand(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return `printf '%s\\n' ${shellEscape(json)} >&2; exit 2`;
}

/** User-safe stderr message + exit 2 for client-visible tool failures. */
export function buildUserSafeErrorBashCommand(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return `printf '%s\\n' ${shellEscape(compact)} >&2; exit 2`;
}

const CAMEL_TO_SNAKE: Record<string, string> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
  globPattern: "glob_pattern",
  fileText: "file_text",
};

const SNAKE_TO_CAMEL: Record<string, string> = Object.fromEntries(
  Object.entries(CAMEL_TO_SNAKE).map(([c, s]) => [s, c]),
);

/**
 * Normalize camelCase tool args to snake_case for internal governance.
 * Returns the normalized input and the set of keys that were remapped
 * so the caller can reverse-map them in the output.
 */
function normalizeCamelCaseArgs(input: Record<string, unknown>): { input: Record<string, unknown>; remappedKeys: Set<string> } {
  const remappedKeys = new Set<string>();
  const out = { ...input };
  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    if (camel in out && !(snake in out)) {
      out[snake] = out[camel];
      delete out[camel];
      remappedKeys.add(snake);
    }
  }
  return { input: out, remappedKeys };
}

/**
 * Reverse snake_case keys back to camelCase for keys that were originally camelCase.
 */
function restoreCamelCaseArgs(input: Record<string, unknown>, remappedKeys: Set<string>): Record<string, unknown> {
  if (remappedKeys.size === 0) return input;
  const out = { ...input };
  for (const snake of remappedKeys) {
    const camel = SNAKE_TO_CAMEL[snake];
    if (camel && snake in out) {
      out[camel] = out[snake];
      delete out[snake];
    }
  }
  return out;
}

export function governToolCall(opts: GovernToolCallOptions): GovernedToolCall {
  const { input: normalizedInput, remappedKeys } = normalizeCamelCaseArgs(opts.input);
  opts.input = normalizedInput;
  const result = governToolCallInner(opts);
  if (remappedKeys.size > 0) {
    result.input = restoreCamelCaseArgs(result.input, remappedKeys);
  }
  return result;
}

function governToolCallInner(opts: GovernToolCallOptions): GovernedToolCall {
  const logicalName = canonicalValidationToolName(opts.toolName);
  const out: GovernedToolCall = {
    toolName: opts.toolName,
    input: { ...opts.input },
    normalizedPath: false,
    constrainedToRoot: false,
    envelopeUnwrapped: false,
    envelopeSource: null,
    blockedUnsafeShell: false,
    blockedWriteCapable: false,
    blockedBashDrift: false,
    validationMissing: [],
  };

  const envelope = unwrapCommonToolEnvelope(logicalName, out.input);
  out.input = envelope.input;
  out.envelopeUnwrapped = envelope.unwrapped;
  out.envelopeSource = envelope.source;

  const aliasRemap = remapCommonToolArgAliases(logicalName, out.input);
  if (aliasRemap.remapped) {
    out.input = aliasRemap.input;
  }

  const anchorRoot = resolvedAnchorRoot(opts.projectRoot, opts.shellCwd);
  const unanchoredAbsoluteBlock = maybeBlockUnanchoredAbsoluteFileTool(
    logicalName,
    out.input,
    opts.clientKind,
    anchorRoot,
  );
  if (unanchoredAbsoluteBlock) {
    out.toolName = unanchoredAbsoluteBlock.toolName;
    out.input = unanchoredAbsoluteBlock.input;
    out.blockedPathSandbox = true;
    out.pathSandboxNudge = unanchoredAbsoluteBlock.nudge;
    return out;
  }

  // Path sandbox: block file operations outside allowed boundaries
  if (opts.pathSandboxPolicy) {
    const sandboxBlock = maybeBlockPathSandbox(logicalName, out.input, opts.pathSandboxPolicy, opts.clientKind);
    if (sandboxBlock) {
      out.toolName = sandboxBlock.toolName;
      out.input = sandboxBlock.input;
      out.blockedPathSandbox = true;
      out.pathSandboxNudge = sandboxBlock.nudge;
      return out;
    }
  }

  const subagentProtection = maybeBlockSubagentExploration(logicalName, opts.clientKind);
  if (subagentProtection) {
    out.toolName = subagentProtection.toolName;
    out.input = subagentProtection.input;
    return out;
  }

  const planScopeProtection = maybeBlockBroadDiscoveryForPlanWork(
    logicalName,
    out.input,
    opts.clientKind,
    !!opts.restrictDiscoveryForPlanWork,
  );
  if (planScopeProtection) {
    out.toolName = planScopeProtection.toolName;
    out.input = planScopeProtection.input;
    out.blockedUnsafeShell = true;
    return out;
  }

  const broadVerificationProtection = maybeBlockBroadVerificationForGreen(
    logicalName,
    out.input,
    opts.clientKind,
    !!opts.blockBroadVerificationForGreen,
  );
  if (broadVerificationProtection) {
    out.toolName = broadVerificationProtection.toolName;
    out.input = broadVerificationProtection.input;
    out.blockedUnsafeShell = true;
    return out;
  }

  const failingVerificationProtection = maybeBlockVerificationForFailure(
    logicalName,
    out.input,
    opts.clientKind,
    !!opts.blockVerificationForFailure,
  );
  if (failingVerificationProtection) {
    out.toolName = failingVerificationProtection.toolName;
    out.input = failingVerificationProtection.input;
    out.blockedUnsafeShell = true;
    return out;
  }

  const pathNorm = normalizeFileToolArgs(logicalName, out.input);
  if (pathNorm.normalized) {
    out.input = pathNorm.input;
    out.normalizedPath = true;
  }
  const cwdPrefixRepair = repairShellCwdPrefixedFilePath(logicalName, out.input, opts.shellCwd, opts.projectRoot);
  if (cwdPrefixRepair.repaired) {
    out.input = cwdPrefixRepair.input;
    out.normalizedPath = true;
  }
  const exactCwdDuplicateRecovery = maybeRecoverExactDuplicatedCwdRead(
    logicalName,
    out.input,
    opts.shellCwd,
    opts.projectRoot,
    opts.clientKind,
  );
  if (exactCwdDuplicateRecovery) {
    out.toolName = exactCwdDuplicateRecovery.toolName;
    out.input = exactCwdDuplicateRecovery.input;
    out.normalizedPath = true;
    return out;
  }

  if (opts.enforcePathRoot && anchorRoot) {
    const requestedFilePath = typeof out.input.file_path === "string" ? out.input.file_path.trim() : "";
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
    const message = `Synesis Yarn blocked write-capable tool '${logicalName}' for the current session policy.`;
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

  const planWriteCheck = maybeValidatePlanFileWrite(logicalName, out.input, opts.planContentShadow, opts.clientKind);
  if (planWriteCheck.audit) {
    out.planWriteAudit = planWriteCheck.audit;
  }
  if (planWriteCheck.replacement) {
    out.toolName = planWriteCheck.replacement.toolName;
    out.input = planWriteCheck.replacement.input;
    out.blockedWriteCapable = true;
    return out;
  }

  if (logicalName === "Bash" && typeof out.input.command === "string") {
    const bashPlanCheck = maybeValidateBashPlanWrite(out.input.command, opts.planContentShadow, opts.clientKind);
    if (bashPlanCheck.audit) {
      out.planWriteAudit = bashPlanCheck.audit;
    }
    if (bashPlanCheck.replacement) {
      out.toolName = bashPlanCheck.replacement.toolName;
      out.input = bashPlanCheck.replacement.input;
      out.blockedWriteCapable = true;
      return out;
    }
  }

  const isWriteTool = WRITE_CAPABLE_LOGICAL.has(logicalName);
  if (isWriteTool) {
    const writePath = typeof out.input.file_path === "string" ? out.input.file_path.trim()
      : typeof out.input.path === "string" ? out.input.path.trim() : "";
    const writeContent = typeof out.input.content === "string" ? out.input.content
      : typeof out.input.new_string === "string" ? out.input.new_string : "";
    if (writeContent && !isPlanPath(writePath)) {
      const stubPhrase = containsStubPhrase(writeContent);
      if (stubPhrase) {
        const msg = `[Write blocked: stub content detected]\nThe proposed write contains metadata/stub content ("${stubPhrase}") instead of actual file content. Re-read the file with Read(${writePath}) to get the current content, then retry your edit.`;
        out.toolName = `Synesis_Error_StubContentWrite`;
        out.input = { synesis_error: true, reason: "stub_content_detected", detail: stubPhrase, message: msg, retryable: true };
        out.blockedStubContent = true;
        return out;
      }
    }
    if (writePath && opts.artifactShadows) {
      const normalizedWritePath = writePath.replace(/\\/g, "/");
      for (const [, shadow] of opts.artifactShadows) {
        const shadowBase = shadow.canonicalPath.replace(/\\/g, "/");
        if (shadowBase.endsWith(normalizedWritePath) || normalizedWritePath.endsWith(shadowBase.split("/").pop() ?? "\0")) {
          if (shadow.stale) {
            const msg = `[Write blocked: stale context]\nThe file "${writePath}" has been edited since your last read. Re-read it with Read(${writePath}) to get the current content, then retry your edit.`;
            out.toolName = `Synesis_Error_StaleWrite`;
            out.input = { synesis_error: true, reason: "stale_context_write", path: writePath, message: msg, retryable: true };
            out.blockedStaleWrite = true;
            return out;
          }
          break;
        }
      }
    }
    if (writePath && opts.onEditTurn && opts.currentTurnIndex !== undefined) {
      const resolvedPath = path.isAbsolute(writePath) ? writePath : path.resolve(opts.shellCwd || opts.projectRoot || "", writePath);
      opts.onEditTurn(resolvedPath.replace(/\\/g, "/"), opts.currentTurnIndex);
    }
  }

  if ((opts.blockBashPathDrift || opts.strictBashBlock) && logicalName === "Bash") {
    const command = out.input.command;
    if (typeof command === "string" && command.trim()) {
      const gitInspectionChurn = detectCompoundGitInspection(command, opts.clientKind);
      const gitInspectionGrace = (opts.sessionGitInspectionBlockCount ?? 0) === 0;
      if (gitInspectionChurn && !gitInspectionGrace) {
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
      const pathDrift = opts.blockBashPathDrift
        ? detectBashPathDrift(command)
          ?? detectDuplicatedCwdBashPath(command, opts.projectRoot, opts.shellCwd)
        : null;
      const dangerous = detectDangerousBash(command);
      if (pathDrift || dangerous) {
        const detail = pathDrift?.reason ?? dangerous?.reason ?? "unsafe shell command";
        const message = pathDrift?.recovery
          ? `Synesis Yarn blocked unsafe shell command: ${detail}. ${pathDrift.recovery}`
          : `Synesis Yarn blocked unsafe shell command: ${detail}. Use safe structured tools from project root.`;
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
          expected_schema: expectedToolSchema(logicalName),
          example: validationExample(logicalName),
          retryable: true,
        };
      } else {
        out.toolName = "Bash";
        const userSafe = `Tool call blocked: invalid arguments for ${logicalName} (missing: ${validation.missing.join(", ")}). Retry with the required schema fields.`;
        out.input = {
          command: buildUserSafeErrorBashCommand(userSafe),
          description: "Blocked invalid tool arguments",
        };
      }
    }
  }
  return out;
}

const recoveryAttempts = new Map<string, number>();

/** Reset per-session recovery counters (call on session init or compaction). */
export function resetRecoveryCounters(): void {
  recoveryAttempts.clear();
}

const MAX_AUTO_RECOVERIES = 2;

function recoverValidationFailure(
  logicalName: string,
  input: Record<string, unknown>,
  missing: string[],
): { toolName: string; input: Record<string, unknown> } | null {
  if (
    (logicalName === "Edit" || logicalName === "Update")
    && missing.includes("old_string")
    && typeof input.file_path === "string"
    && input.file_path.trim()
  ) {
    const fp = input.file_path.trim();
    const isClaudePlanFile =
      fp.includes("/.claude/plans/")
      && fp.toLowerCase().endsWith(".md");
    if (isClaudePlanFile) return null;
    const key = `${logicalName}:${fp}`;
    const attempts = recoveryAttempts.get(key) ?? 0;
    if (attempts >= MAX_AUTO_RECOVERIES) return null;
    recoveryAttempts.set(key, attempts + 1);
    return {
      toolName: "Read",
      input: { file_path: input.file_path },
    };
  }
  if (logicalName === "Glob" && missing.includes("glob_pattern")) {
    const targetDirectory =
      typeof input.target_directory === "string" && input.target_directory.trim()
        ? input.target_directory.trim()
        : undefined;
    const key = `Glob:${targetDirectory ?? "."}`;
    const attempts = recoveryAttempts.get(key) ?? 0;
    if (attempts >= MAX_AUTO_RECOVERIES) return null;
    recoveryAttempts.set(key, attempts + 1);
    const pattern = targetDirectory ? "src/*" : "*";
    return {
      toolName: "Glob",
      input: targetDirectory
        ? { target_directory: targetDirectory, glob_pattern: pattern }
        : { glob_pattern: pattern },
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
  return `${base} Emit exactly one tool call with strict JSON arguments only (no comments, no extra wrapper keys).`;
}

function expectedToolSchema(logicalName: string): string[] {
  switch (logicalName) {
    case "Write":
      return ["file_path", "content"];
    case "Read":
      return ["file_path"];
    case "Edit":
    case "Update":
      return ["file_path", "old_string", "new_string"];
    case "Bash":
      return ["command"];
    case "Glob":
      return ["glob_pattern"];
    case "Grep":
      return ["pattern"];
    default:
      return [];
  }
}

function validationExample(logicalName: string): Record<string, unknown> {
  switch (logicalName) {
    case "Write":
      return { file_path: "path/to/file.ts", content: "..." };
    case "Read":
      return { file_path: "path/to/file.ts" };
    case "Edit":
    case "Update":
      return { file_path: "path/to/file.ts", old_string: "before", new_string: "after" };
    case "Bash":
      return { command: "npm test" };
    case "Glob":
      return { glob_pattern: "**/*.ts" };
    case "Grep":
      return { pattern: "TODO" };
    default:
      return {};
  }
}

function unwrapCommonToolEnvelope(
  logicalName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; unwrapped: boolean; source: string | null } {
  const topValidation = validateToolArgs(logicalName, input);
  if (topValidation.valid) return { input, unwrapped: false, source: null };

  const nestedCandidates: Array<{ input: Record<string, unknown>; source: string }> = [];
  const argsObj = toRecord(input.args, "args");
  if (argsObj) nestedCandidates.push(argsObj);
  const argumentsObj = toRecord(input.arguments, "arguments");
  if (argumentsObj) nestedCandidates.push(argumentsObj);
  const inputObj = toRecord(input.input, "input");
  if (inputObj) nestedCandidates.push(inputObj);

  for (const candidate of nestedCandidates) {
    const remapped = remapCommonToolArgAliases(logicalName, candidate.input);
    const candidateInput = remapped.input;
    const nestedValidation = validateToolArgs(logicalName, candidateInput);
    if (nestedValidation.valid) return { input: candidateInput, unwrapped: true, source: candidate.source };
  }

  for (const candidate of nestedCandidates) {
    const required = expectedToolSchema(logicalName);
    if (required.length === 0) continue;
    const remapped = remapCommonToolArgAliases(logicalName, candidate.input);
    const candidateInput = remapped.input;
    const present = required.filter((k) => candidateInput[k] !== undefined && candidateInput[k] !== null);
    if (present.length > 0) {
      return { input: candidateInput, unwrapped: true, source: candidate.source };
    }
  }
  return { input, unwrapped: false, source: null };
}

function toRecord(value: unknown, keyName: string): { input: Record<string, unknown>; source: string } | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return { input: { ...(value as Record<string, unknown>) }, source: `${keyName}_object` };
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, source: `${keyName}_json_string` };
    }
  } catch {
    return null;
  }
  return null;
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
    || logicalName === "Update"
    || logicalName === "ApplyPatch"
    || logicalName === "FileWrite";
}

function isClaudePlanFilePath(filePath: string): boolean {
  return (filePath.includes("/.claude/plans/") || filePath.includes("\\.claude\\plans\\"))
    && filePath.toLowerCase().endsWith(".md");
}

function extractPlanWriteBody(logicalName: string, input: Record<string, unknown>): { body: string; isPartialEdit: boolean } {
  if (logicalName === "Write" || logicalName === "FileWrite") {
    return { body: String(input.content ?? ""), isPartialEdit: false };
  }
  return { body: String(input.new_string ?? ""), isPartialEdit: true };
}

function buildPlanWriteBlockResult(
  logicalName: string,
  filePath: string,
  reason: string,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown> } {
  const message = `[Plan write blocked: ${reason}] The proposed write to ${filePath} was rejected because: ${reason}. Re-read the plan file with Read(${filePath}) to get the current content, then retry your edit.`;
  if (clientKind === "claude-code") {
    return {
      toolName: "Synesis_Error_PlanWriteBlocked",
      input: {
        synesis_error: true,
        reason: "plan_write_blocked",
        detail: reason,
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
        reason: "plan_write_blocked",
        detail: reason,
        original_tool: logicalName,
        file_path: filePath,
        message,
        retryable: true,
      }),
      description: `Blocked unsafe write to Claude plan file: ${reason}`,
    },
  };
}

function maybeValidatePlanFileWrite(
  logicalName: string,
  input: Record<string, unknown>,
  shadow: PlanContentShadow | null | undefined,
  clientKind?: string,
): { replacement: { toolName: string; input: Record<string, unknown> } | null; audit: PlanWriteAuditRecord | null } {
  if (!isWriteCapableTool(logicalName)) return { replacement: null, audit: null };
  const filePath = typeof input.file_path === "string" ? input.file_path.trim() : "";
  if (!filePath || !isClaudePlanFilePath(filePath)) return { replacement: null, audit: null };

  const { body, isPartialEdit } = extractPlanWriteBody(logicalName, input);
  const validation = validatePlanWriteContent(body, shadow ?? null, isPartialEdit);
  const proposedHash = hashContent(body);

  if (!validation.allowed) {
    return {
      replacement: buildPlanWriteBlockResult(logicalName, filePath, validation.reason!, clientKind),
      audit: {
        allowed: false,
        path: filePath,
        reason: validation.reason,
        proposedContentHash: proposedHash,
        shadowContentHash: shadow?.contentHash,
        validation,
      },
    };
  }

  return {
    replacement: null,
    audit: {
      allowed: true,
      path: filePath,
      proposedContentHash: proposedHash,
      shadowContentHash: shadow?.contentHash,
      validation,
    },
  };
}

const BASH_PLAN_WRITE_RE = /(?:cat\s*>|tee\s+|echo\s.*>)\s*["']?([^\s"'|;]+\.claude\/plans\/[^\s"'|;]+\.md)/i;
const BASH_HEREDOC_BODY_RE = /<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1/;

function maybeValidateBashPlanWrite(
  command: string,
  shadow: PlanContentShadow | null | undefined,
  clientKind?: string,
): { replacement: { toolName: string; input: Record<string, unknown> } | null; audit: PlanWriteAuditRecord | null } {
  const pathMatch = BASH_PLAN_WRITE_RE.exec(command);
  if (!pathMatch) return { replacement: null, audit: null };
  const filePath = pathMatch[1];

  const heredocMatch = BASH_HEREDOC_BODY_RE.exec(command);
  const body = heredocMatch ? heredocMatch[2] : "";
  if (!body) return { replacement: null, audit: null };

  const validation = validatePlanWriteContent(body, shadow ?? null, false);
  const proposedHash = hashContent(body);

  if (!validation.allowed) {
    return {
      replacement: buildPlanWriteBlockResult("Bash", filePath, validation.reason!, clientKind),
      audit: {
        allowed: false,
        path: filePath,
        reason: validation.reason,
        proposedContentHash: proposedHash,
        shadowContentHash: shadow?.contentHash,
        validation,
      },
    };
  }

  return {
    replacement: null,
    audit: {
      allowed: true,
      path: filePath,
      proposedContentHash: proposedHash,
      shadowContentHash: shadow?.contentHash,
      validation,
    },
  };
}

function maybeBlockSubagentExploration(
  logicalName: string,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown> } | null {
  if (clientKind !== "claude-code") return null;
  const lower = logicalName.trim().toLowerCase();
  if (lower !== "explore") return null;
  const message = "Synesis Yarn blocked hallucinated subagent-style exploration for this session. Use the native Claude Code Agent tool for bounded subagent work, or use direct tools: Read specific files, then Edit/Write one concrete change.";
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

function maybeBlockBroadDiscoveryForPlanWork(
  logicalName: string,
  input: Record<string, unknown>,
  clientKind: string | undefined,
  enabled: boolean,
): { toolName: string; input: Record<string, unknown> } | null {
  if (!enabled || clientKind !== "claude-code") return null;
  const lower = logicalName.trim().toLowerCase();
  if (lower === "glob") {
    const pattern = typeof input.glob_pattern === "string" ? input.glob_pattern.trim() : "";
    if (
      pattern === "*"
      || pattern === "**/*"
      || pattern.startsWith("**/*.go")
      || pattern.startsWith("cmd/synesis/*.go")
      || pattern.startsWith("pkg/**/*.go")
    ) {
      return {
        toolName: "Synesis_Error_PlanExecutionScope",
        input: {
          synesis_error: true,
          reason: "plan_execution_scope",
          original_tool: logicalName,
          message: "Plan-execution mode is active. Broad discovery is blocked. Read the plan once, then do one concrete Edit/Write or focused test/build.",
          retryable: true,
        },
      };
    }
  }
  if (lower === "bash") {
    const cmd = typeof input.command === "string" ? input.command.toLowerCase() : "";
    if (!cmd) return null;
    const hasConcreteAction =
      /\bgit\s+add\b/.test(cmd)
      || /\bgit\s+commit\b/.test(cmd)
      || /\bgit\s+push\b/.test(cmd)
      || /\bgit\s+checkout\b/.test(cmd)
      || /\bgit\s+restore\b/.test(cmd)
      || /\bgo\s+test\b/.test(cmd)
      || /\bgo\s+build\b/.test(cmd)
      || /\bgo\s+vet\b/.test(cmd)
      || /\bcat\b/.test(cmd)
      || /\bhead\b/.test(cmd)
      || /\btail\b/.test(cmd);
    const isBroadDiscovery =
      /\bls\s+-la\b/.test(cmd)
      || /\bfind\s+/.test(cmd)
      || /\bgit\b.*\blog\b/.test(cmd)
      || /\bgit\b.*\bdiff\s+.*--stat\b/.test(cmd)
      || /\bgit\s+status\b/.test(cmd);
    if (isBroadDiscovery && !hasConcreteAction) {
      return {
        toolName: "Synesis_Error_PlanExecutionScope",
        input: {
          synesis_error: true,
          reason: "plan_execution_scope",
          original_tool: logicalName,
          message: "Plan-execution mode is active. Broad discovery Bash commands are blocked. Read/update the plan and apply one concrete code change.",
          retryable: true,
        },
      };
    }
  }
  return null;
}

function maybeBlockBroadVerificationForGreen(
  logicalName: string,
  input: Record<string, unknown>,
  clientKind: string | undefined,
  enabled: boolean,
): { toolName: string; input: Record<string, unknown> } | null {
  if (!enabled) return null;
  const lower = logicalName.trim().toLowerCase();
  if (lower !== "bash") return null;
  const cmd = typeof input.command === "string" ? input.command.toLowerCase() : "";
  if (!cmd) return null;
  const broadVerification =
    /\bgo\s+test\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+build\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+vet\s+\.\/\.\.\./.test(cmd)
    || /\bnpm\s+test\b/.test(cmd)
    || /\bpnpm\s+test\b/.test(cmd)
    || /\byarn\s+test\b/.test(cmd);
  if (!broadVerification) return null;
  const message = "Synesis Yarn blocked repeated broad verification while results are already green. Make one concrete Edit/Write first, then run one narrow verification command.";
  if (clientKind === "claude-code") {
    return {
      toolName: "Synesis_Error_VerificationLoop",
      input: {
        synesis_error: true,
        reason: "verification_green_repeat_block",
        original_tool: logicalName,
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
        reason: "verification_green_repeat_block",
        original_tool: logicalName,
        message,
        retryable: true,
      }),
      description: "Blocked repeated broad verification command",
    },
  };
}

function maybeBlockVerificationForFailure(
  logicalName: string,
  input: Record<string, unknown>,
  clientKind: string | undefined,
  enabled: boolean,
): { toolName: string; input: Record<string, unknown> } | null {
  if (!enabled) return null;
  const lower = logicalName.trim().toLowerCase();
  if (lower !== "bash") return null;
  const cmd = typeof input.command === "string" ? input.command.toLowerCase() : "";
  if (!cmd) return null;
  const verificationCommand =
    /\b(go test|go build|go vet|cargo test|dotnet test|ctest|mvn test|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test)\b/.test(cmd);
  if (!verificationCommand) return null;
  const message = "Synesis Yarn blocked repeated failing verification commands. Apply one focused Edit/Write to fix the failing root cause first, then run one narrow verification command.";
  if (clientKind === "claude-code") {
    return {
      toolName: "Synesis_Error_VerificationLoop",
      input: {
        synesis_error: true,
        reason: "verification_fail_repeat_block",
        original_tool: logicalName,
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
        reason: "verification_fail_repeat_block",
        original_tool: logicalName,
        message,
        retryable: true,
      }),
      description: "Blocked repeated failing verification command",
    },
  };
}

function resolvedAnchorRoot(projectRoot?: string | null, shellCwd?: string | null): string | null {
  const cwd = (shellCwd ?? "").trim();
  if (cwd) return cwd;
  const root = (projectRoot ?? "").trim();
  return root || null;
}

function repairShellCwdPrefixedFilePath(
  logicalName: string,
  input: Record<string, unknown>,
  shellCwd?: string | null,
  projectRoot?: string | null,
): { input: Record<string, unknown>; repaired: boolean } {
  if (!["Write", "Read", "Edit", "Update"].includes(logicalName)) return { input, repaired: false };
  const raw = typeof input.file_path === "string" ? input.file_path.trim() : "";
  const cwd = shellCwd?.trim() || projectRoot?.trim();
  if (!raw || !cwd) return { input, repaired: false };
  if (path.isAbsolute(raw) || raw.startsWith("~") || raw.startsWith("../") || raw === "..") {
    return { input, repaired: false };
  }

  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  const rawParts = normalized.split("/").filter(Boolean);
  if (rawParts.length < 2) return { input, repaired: false };

  const project = projectRoot?.trim();
  if (project) {
    const taskRel = path.relative(path.resolve(project), path.resolve(cwd)).split(path.sep).join("/");
    const taskRelParts = taskRel.split("/").filter((part) => part && part !== "." && part !== "..");
    if (taskRelParts.length > 0 && startsWithParts(rawParts, taskRelParts)) {
      const repaired = rawParts.slice(taskRelParts.length).join("/");
      if (repaired) return { input: { ...input, file_path: repaired }, repaired: true };
    }
  }

  const cwdParts = path.resolve(cwd).split(path.sep).filter(Boolean);
  const max = Math.min(cwdParts.length, rawParts.length - 1);
  for (let n = max; n >= 2; n -= 1) {
    const suffix = cwdParts.slice(cwdParts.length - n);
    if (!startsWithParts(rawParts, suffix)) continue;
    const repaired = rawParts.slice(n).join("/");
    if (repaired) return { input: { ...input, file_path: repaired }, repaired: true };
  }

  return { input, repaired: false };
}

function maybeRecoverExactDuplicatedCwdRead(
  logicalName: string,
  input: Record<string, unknown>,
  shellCwd?: string | null,
  projectRoot?: string | null,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown> } | null {
  if (logicalName !== "Read") return null;
  const raw = typeof input.file_path === "string" ? input.file_path.trim() : "";
  const cwd = shellCwd?.trim() || projectRoot?.trim();
  if (!raw || !cwd || path.isAbsolute(raw) || raw.startsWith("~") || raw.startsWith("../") || raw === "..") {
    return null;
  }

  const normalized = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  const rawParts = normalized.split("/").filter(Boolean);
  if (rawParts.length < 2) return null;

  const cwdParts = path.resolve(cwd).split(path.sep).filter(Boolean);
  const max = Math.min(cwdParts.length, rawParts.length);
  for (let n = max; n >= 2; n -= 1) {
    const suffix = cwdParts.slice(cwdParts.length - n);
    if (rawParts.length !== suffix.length || !startsWithParts(rawParts, suffix)) continue;
    const message = [
      `The requested Read path "${normalized}" duplicates the current workspace suffix.`,
      `Current workspace root is "${cwd}".`,
      "Use paths relative to the current workspace; for root discovery, inspect the current directory instead.",
    ].join(" ");
    if (clientKind === "claude-code") {
      return {
        toolName: "Synesis_Error_PathSandbox",
        input: {
          synesis_error: true,
          reason: "duplicated_cwd_relative_path",
          blocked_path: normalized,
          message,
          retryable: true,
        },
      };
    }
    return {
      toolName: "Bash",
      input: {
        command: [
          "printf '%s\\n' 'SYNESIS_PATH_CONTEXT_V1 reason=duplicated_cwd_relative_path'",
          `printf 'cwd=%s\\nrequested=%s\\n' "$(pwd 2>/dev/null || true)" ${shellEscape(normalized)}`,
          "find . -maxdepth 2 -mindepth 1 -print 2>/dev/null | sed 's#^\\./##' | sort | head -80",
        ].join("; "),
        description: "Recover from duplicated cwd-relative Read path with a bounded directory listing",
      },
    };
  }
  return null;
}

function startsWithParts(parts: string[], prefix: string[]): boolean {
  if (prefix.length > parts.length) return false;
  return prefix.every((part, index) => parts[index] === part);
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

function detectBashPathDrift(command: string): { reason: string; recovery?: string } | null {
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

function detectDuplicatedCwdBashPath(
  command: string,
  projectRoot?: string | null,
  shellCwd?: string | null,
): { reason: string; recovery?: string } | null {
  const root = (projectRoot || shellCwd || "").trim();
  if (!root) return null;
  const rootParts = path.resolve(root).split(path.sep).filter(Boolean);
  if (rootParts.length < 2) return null;

  const candidates = [
    ...extractBashFilePaths(command),
    ...extractAbsolutePathTokens(command),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTokenPath(candidate).replace(/\\/g, "/").replace(/\*+$/g, "");
    if (!normalized || !path.isAbsolute(normalized)) continue;
    const candidateParts = path.resolve(normalized).split(path.sep).filter(Boolean);
    if (!startsWithParts(candidateParts, rootParts)) continue;
    const afterRoot = candidateParts.slice(rootParts.length);
    const maxSuffix = Math.min(rootParts.length, afterRoot.length);
    for (let n = maxSuffix; n >= 2; n -= 1) {
      const suffix = rootParts.slice(rootParts.length - n);
      if (!startsWithParts(afterRoot, suffix)) continue;
      const duplicated = `/${[...rootParts, ...suffix].join("/")}`;
      return {
        reason: `duplicated working-directory path detected (${duplicated})`,
        recovery:
          "Use the canonical project directory from SESSION_EXECUTION_CONTEXT; do not copy, remove, or recreate duplicate trees. Run one targeted verification from the canonical directory.",
      };
    }
  }
  return null;
}

function extractAbsolutePathTokens(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'=])((?:\/[A-Za-z0-9._@:+-]+)+\/?)(?=$|[\s"';&|*])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function globPatternDirectory(pattern: string): string | null {
  const normalized = pattern.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  const wildcardIdx = normalized.search(/[*?[\]{}]/);
  const beforeWildcard = wildcardIdx >= 0 ? normalized.slice(0, wildcardIdx) : normalized;
  const candidate = beforeWildcard.replace(/\/+$/g, "");
  if (!candidate) return normalized.startsWith("/") ? "/" : null;
  if (path.isAbsolute(candidate) || candidate.startsWith("~") || candidate.startsWith(".") || candidate.includes("/")) {
    return candidate;
  }
  return null;
}

function sandboxPathsForNonBashTool(
  logicalName: string,
  input: Record<string, unknown>,
): Array<{ path: string; operation: PathOperation }> {
  const operation: PathOperation = WRITE_CAPABLE_LOGICAL.has(logicalName) ? "write" : "read";
  const directPath = typeof input.file_path === "string" ? input.file_path.trim()
    : typeof input.path === "string" ? input.path.trim()
      : "";
  const paths: Array<{ path: string; operation: PathOperation }> = [];
  if (directPath) paths.push({ path: directPath, operation });

  if (logicalName === "Glob" || logicalName === "Grep") {
    const targetDirectory = typeof input.target_directory === "string" ? input.target_directory.trim()
      : typeof input.directory === "string" ? input.directory.trim()
        : typeof input.dir === "string" ? input.dir.trim()
          : "";
    if (targetDirectory) paths.push({ path: targetDirectory, operation: "read" });

    if (logicalName === "Glob") {
      const pattern = typeof input.glob_pattern === "string" ? input.glob_pattern.trim()
        : typeof input.pattern === "string" ? input.pattern.trim()
          : typeof input.glob === "string" ? input.glob.trim()
            : typeof input.query === "string" ? input.query.trim()
              : "";
      const patternDir = pattern ? globPatternDirectory(pattern) : null;
      if (patternDir) paths.push({ path: patternDir, operation: "read" });
    }
  }

  const seen = new Set<string>();
  return paths.filter((entry) => {
    const key = `${entry.operation}:${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maybeBlockPathSandbox(
  logicalName: string,
  input: Record<string, unknown>,
  policy: PathSandboxPolicy,
  clientKind?: string,
): { toolName: string; input: Record<string, unknown>; nudge?: string } | null {
  // File/search tool paths, including absolute Glob patterns like /repo-parent/*
  if (logicalName !== "Bash") {
    for (const entry of sandboxPathsForNonBashTool(logicalName, input)) {
      const result = evaluatePathAccess(entry.path, entry.operation, policy);
      if (!result.allowed) {
        const message = result.nudge
          ?? `Path "${entry.path}" is outside the project sandbox. ${result.reason}. Use files within ${policy.projectRoot} or ~/.claude/ instead.`;
        if (clientKind === "claude-code") {
          return {
            toolName: "Synesis_Error_PathSandbox",
            input: {
              synesis_error: true,
              reason: "path_sandbox_violation",
              detail: result.reason,
              blocked_path: entry.path,
              resolved_path: result.resolvedPath,
              operation: entry.operation,
              message,
              retryable: true,
            },
            nudge: result.nudge,
          };
        }
        return {
          toolName: "Bash",
          input: {
            command: buildStructuredErrorBashCommand({
              synesis_error: true,
              schema_version: 1,
              category: "security",
              reason: "path_sandbox_violation",
              detail: result.reason,
              blocked_path: entry.path,
              operation: entry.operation,
              message,
              retryable: true,
            }),
            description: `Blocked ${entry.operation} outside sandbox: ${result.reason}`,
          },
          nudge: result.nudge,
        };
      }
    }
  }

  // Bash commands: check file paths embedded in the command
  if (logicalName === "Bash" && typeof input.command === "string") {
    const bashPaths = extractBashFilePaths(input.command);
    for (const bp of bashPaths) {
      if (!bp || bp.startsWith("-")) continue;
      // Determine if it's a write based on context (redirect)
      const bashOp: PathOperation = input.command.includes(`> ${bp}`)
        || input.command.includes(`>> ${bp}`)
        || input.command.includes(`>${bp}`)
        || input.command.includes(`>>${bp}`)
          ? "write" : "read";
      const result = evaluatePathAccess(bp, bashOp, policy);
      if (!result.allowed) {
        const message = result.nudge
          ?? `Bash command references "${bp}" which is outside the project sandbox. ${result.reason}.`;
        if (clientKind === "claude-code") {
          return {
            toolName: "Synesis_Error_PathSandbox",
            input: {
              synesis_error: true,
              reason: "path_sandbox_violation",
              detail: result.reason,
              blocked_path: bp,
              resolved_path: result.resolvedPath,
              operation: bashOp,
              message,
              retryable: true,
            },
            nudge: result.nudge,
          };
        }
        return {
          toolName: "Bash",
          input: {
            command: buildStructuredErrorBashCommand({
              synesis_error: true,
              schema_version: 1,
              category: "security",
              reason: "path_sandbox_violation",
              detail: result.reason,
              blocked_path: bp,
              operation: bashOp,
              message,
              retryable: true,
            }),
            description: `Blocked bash ${bashOp} outside sandbox: ${result.reason}`,
          },
          nudge: result.nudge,
        };
      }
    }
  }

  return null;
}

function maybeBlockUnanchoredAbsoluteFileTool(
  logicalName: string,
  input: Record<string, unknown>,
  clientKind: string | undefined,
  anchorRoot: string | null,
): { toolName: string; input: Record<string, unknown>; nudge: string } | null {
  if (anchorRoot || !isCoderClientKind(clientKind ?? "")) return null;
  if (!["Read", "Write", "Edit", "Update"].includes(logicalName)) return null;
  const rawPath = typeof input.file_path === "string" ? input.file_path.trim() : "";
  if (!rawPath) return null;
  const absoluteLike =
    path.isAbsolute(rawPath)
    || /^[A-Za-z]:[\\/]/.test(rawPath)
    || /^~(?:[\\/]|$)/.test(rawPath)
    || /^(?:Users|home|root)\//.test(rawPath);
  if (!absoluteLike) return null;

  const message = [
    `Synesis Yarn blocked absolute file path "${rawPath}" because no project_root or shell_cwd is known for this coder session.`,
    "Allow the workspace context handshake or run one narrow pwd/listing step, then retry with a path relative to the current workspace.",
  ].join(" ");
  if (clientKind === "claude-code") {
    return {
      toolName: "Synesis_Error_PathSandbox",
      input: {
        synesis_error: true,
        reason: "missing_workspace_context_absolute_path",
        blocked_path: rawPath,
        operation: logicalName === "Read" ? "read" : "write",
        message,
        retryable: true,
      },
      nudge: message,
    };
  }
  return {
    toolName: "Bash",
    input: {
      command: buildStructuredErrorBashCommand({
        synesis_error: true,
        schema_version: 1,
        category: "path_context",
        reason: "missing_workspace_context_absolute_path",
        blocked_path: rawPath,
        original_tool: logicalName,
        message,
        retryable: true,
      }),
      description: "Blocked absolute file path until workspace context is known",
    },
    nudge: message,
  };
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
