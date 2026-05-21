import type { HarnessToolCall, MasterHarnessPolicyV1, SafetyDecision } from "./types.js";

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "run_command",
  "run_shell",
  "terminal",
]);

const WRITE_CAPABLE_TOOL_NAMES = new Set([
  "write",
  "write_file",
  "filewrite",
  "file_write",
  "edit",
  "update",
  "multiedit",
  "applypatch",
  "str_replace",
]);

const PATH_FIELD_NAMES = new Set([
  "cwd",
  "destination",
  "directory",
  "file",
  "file_path",
  "filename",
  "filepath",
  "output_path",
  "path",
  "target_directory",
  "working_directory",
]);

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function normalizePathForPolicy(pathValue: string): string {
  return pathValue.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function commandFromInput(input: Record<string, unknown>): string {
  const raw = input.command ?? input.cmd ?? input.shell_command ?? input.bash_command ?? input.run;
  return typeof raw === "string" ? raw : "";
}

function pathCandidatesFromInput(input: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!PATH_FIELD_NAMES.has(normalizeToolName(key))) continue;
    if (typeof value === "string") {
      candidates.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") candidates.push(item);
      }
    }
  }
  return candidates;
}

export function detectDangerousShellCommand(command: string): { rule: string; reason: string } | null {
  const lowered = command.trim().toLowerCase();
  if (!lowered) return null;
  if (/\brm\s+-[a-z]*r[a-z]*f[a-z]*(?:\s|$)|\brm\s+-[a-z]*f[a-z]*r[a-z]*(?:\s|$)/.test(lowered)) {
    return { rule: "safety.shell.rm_rf", reason: "rm -rf is disallowed" };
  }
  if (/\bgit\s+clean\s+-f(?:\s|$)/.test(lowered)) {
    return { rule: "safety.shell.git_clean_force", reason: "git clean -f is disallowed" };
  }
  if (/\bmkfs(?:\.|\s|$)|\bdd\s+if=|\bshutdown\b|\breboot\b/.test(lowered)) {
    return { rule: "safety.shell.destructive_system_command", reason: "destructive system command detected" };
  }
  if (/\bcurl\b[\s\S]{0,120}\|\s*(?:bash|sh)\b/.test(lowered)) {
    return { rule: "safety.shell.curl_pipe_shell", reason: "curl piped to shell is disallowed" };
  }
  if (lowered.includes(":(){ :|:& };:")) {
    return { rule: "safety.shell.fork_bomb", reason: "fork bomb pattern detected" };
  }
  return null;
}

function detectUnsafePath(pathValue: string, policy: MasterHarnessPolicyV1): { rule: string; reason: string } | null {
  const normalized = normalizePathForPolicy(pathValue);
  if (!normalized) return null;

  if (
    policy.safety.block_parent_path_traversal &&
    normalized.split("/").some((part) => part === "..")
  ) {
    return {
      rule: "safety.path.parent_traversal",
      reason: `path '${pathValue}' contains parent traversal`,
    };
  }

  for (const prefix of policy.safety.blocked_path_prefixes) {
    const normalizedPrefix = normalizePathForPolicy(prefix);
    if (normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`)) {
      return {
        rule: "safety.path.blocked_prefix",
        reason: `path '${pathValue}' is outside the allowed sandbox`,
      };
    }
  }

  return null;
}

export function evaluateUniversalSafety(
  toolCall: HarnessToolCall,
  policy: MasterHarnessPolicyV1,
): SafetyDecision {
  const toolName = normalizeToolName(toolCall.toolName);
  const matchedRules: string[] = [];

  if (policy.safety.block_write_capable_tools && WRITE_CAPABLE_TOOL_NAMES.has(toolName)) {
    matchedRules.push("safety.write_capable_tool_blocked");
    return {
      action: "block",
      reason: `write-capable tool '${toolCall.toolName}' is blocked by master harness policy`,
      matchedRules,
    };
  }

  if (policy.safety.block_dangerous_shell && SHELL_TOOL_NAMES.has(toolName)) {
    const command = commandFromInput(toolCall.input);
    const dangerous = detectDangerousShellCommand(command);
    if (dangerous) {
      matchedRules.push(dangerous.rule);
      return {
        action: "block",
        reason: dangerous.reason,
        matchedRules,
      };
    }
  }

  if (policy.safety.enforce_path_sandbox) {
    for (const pathValue of pathCandidatesFromInput(toolCall.input)) {
      const unsafePath = detectUnsafePath(pathValue, policy);
      if (unsafePath) {
        matchedRules.push(unsafePath.rule);
        return {
          action: "block",
          reason: unsafePath.reason,
          matchedRules,
        };
      }
    }
  }

  matchedRules.push("safety.allow");
  return { action: "allow", matchedRules };
}
