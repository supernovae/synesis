export type BlockedDiscoveryDetail = {
  toolName: string;
  reason: string;
  argsPreview?: string;
};

type RecoveryPreviewEntry = {
  name: string;
  kind: "dir" | "file";
};

function modelFamilyLabelForGuidance(family: string): string {
  const lower = family.toLowerCase();
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("kimi")) return "kimi";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("deepseek")) return "deepseek";
  return "default";
}

function summarizeBlockedCalls(blocked: BlockedDiscoveryDetail[]): string {
  const samples = blocked.slice(0, 3).map((item) => {
    const preview = item.argsPreview ? ` ${item.argsPreview}` : "";
    return `${item.toolName}${preview}`;
  });
  const extra = blocked.length > samples.length ? ` (+${blocked.length - samples.length} more)` : "";
  return samples.join(", ") + extra;
}

function primaryGuardrailCode(blocked: BlockedDiscoveryDetail[]): "empty_glob_pattern" | "root_wildcard_glob" {
  if (blocked.some((b) => b.reason === "empty_glob_pattern_blocked")) return "empty_glob_pattern";
  return "root_wildcard_glob";
}

export function buildBlockedDiscoveryGuidance(
  family: string,
  blocked: BlockedDiscoveryDetail[],
): string {
  const label = modelFamilyLabelForGuidance(family);
  const reasons = blocked.map((b) => `${b.toolName}:${b.reason}`).join(",");
  const blockedSummary = summarizeBlockedCalls(blocked);
  const guardrailCode = primaryGuardrailCode(blocked);
  const primaryMessage = guardrailCode === "empty_glob_pattern"
    ? "Empty glob patterns are disabled. You MUST use an explicit scoped pattern."
    : "Root-level wildcard globs are disabled. You MUST use scoped discovery.";
  return [
    `Blocked ${blocked.length} broad discovery tool call(s): ${blockedSummary}.`,
    `${primaryMessage} Do NOT retry the same call. Instead: Read README.md or package.json, then use a scoped Glob like src/* or tests/*.`,
    `<SYNESIS_TOOL_GUARDRAIL status="blocked" code="${guardrailCode}" version="3">`,
    `family=${label}`,
    `startup_policy=${label === "minimax" ? "minimax_constrained_discovery" : "default_constrained_discovery"}`,
    `blocked=${blocked.length}`,
    `reasons=${reasons}`,
    "next_action=read_file:README.md|read_file:package.json|glob:src/*|glob:tests/*|grep:<keyword>",
    "tests_hint=if_user_asks_for_tests_then_grep:_test.go|test_|spec|jest|vitest|pytest",
    "message=Read README.md/go.mod/package.json first, then use a scoped Glob or Grep. Do NOT call Glob with empty or wildcard patterns.",
    "</SYNESIS_TOOL_GUARDRAIL>",
  ].join("\n");
}

export function buildBlockedDiscoveryRecoveryWithoutSnapshot(
  baseGuidance: string,
  code: "no_project_root" | "root_empty" | "snapshot_io_error",
): string {
  if (code === "root_empty") {
    return [
      baseGuidance,
      "Recovery: the workspace root appears empty. Do not retry broad discovery or read nonexistent README/package files. Ask what to create, or create the first project files only when the user's request is specific enough.",
      "<SYNESIS_DISCOVERY_RECOVERY status=\"guided\" code=\"root_empty\" version=\"2\">",
      "entries_total=0",
      "entries_preview=0",
      "message=The workspace is empty. Do not claim prior task frames, previous turns, active objectives, or files unless they appear in the current transcript.",
      "next_action=ask_user_for_project_goal|create_first_files_from_explicit_user_request|use_init_for_CLAUDE.md",
      "</SYNESIS_DISCOVERY_RECOVERY>",
    ].join("\n");
  }
  return [
    baseGuidance,
    "Recovery: Read README.md or package.json to discover structure, then use a scoped Glob (e.g. src/*) or Grep.",
    `<SYNESIS_DISCOVERY_RECOVERY status="guided" code="${code}" version="2">`,
    "entries_total=0",
    "entries_preview=0",
    "message=Read README.md/go.mod/package.json first to learn the directory layout, then scope Glob/Grep to one directory.",
    "next_action=read_file:README.md|read_file:package.json|glob:src/*|grep:<keyword>",
    "</SYNESIS_DISCOVERY_RECOVERY>",
  ].join("\n");
}

export function buildBlockedDiscoveryRecoveryWithSnapshot(
  baseGuidance: string,
  normalized: RecoveryPreviewEntry[],
): { text: string; previewCount: number } {
  const preview = normalized.slice(0, 20);
  const previewLines = preview.map((entry) => `- ${entry.kind}:${entry.name}`);
  return {
    text: [
      baseGuidance,
      "Recovery: pick one directory from the preview and use a scoped Glob (e.g. src/*) or Grep to continue.",
      "<SYNESIS_DISCOVERY_RECOVERY status=\"guided\" code=\"top_level_snapshot\" version=\"2\">",
      `entries_total=${normalized.length}`,
      `entries_preview=${preview.length}`,
      "message=Use a scoped Glob on one directory (e.g. src/*), or Grep for a symbol or error string.",
      ...previewLines,
      "</SYNESIS_DISCOVERY_RECOVERY>",
    ].join("\n"),
    previewCount: preview.length,
  };
}
