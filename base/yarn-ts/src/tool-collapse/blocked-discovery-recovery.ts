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
    ? "Empty glob patterns are disabled for performance and reliability. Use an explicit scoped pattern."
    : "Root-level wildcard globs are disabled for performance. Use scoped discovery first.";
  return [
    `Blocked ${blocked.length} broad discovery tool call(s): ${blockedSummary}.`,
    `${primaryMessage} Use list_dir on '.' first when available, then target a specific subtree (for example src/*).`,
    `<SYNESIS_TOOL_GUARDRAIL status="blocked" code="${guardrailCode}" version="2">`,
    `family=${label}`,
    `startup_policy=${label === "minimax" ? "minimax_constrained_discovery" : "default_constrained_discovery"}`,
    `blocked=${blocked.length}`,
    `reasons=${reasons}`,
    "next_action=list_dir:.|glob:src/*|glob:pkg/**/*_test.go|search_code:<symbol>",
    "tests_hint=if_user_asks_for_tests_then_search_code:_test.go|test_|spec|jest|vitest|pytest",
    "message=If list_dir is unavailable, read README.md/go.mod/package.json and then use a scoped glob/search pattern.",
    "</SYNESIS_TOOL_GUARDRAIL>",
  ].join("\n");
}

export function buildBlockedDiscoveryRecoveryWithoutSnapshot(
  baseGuidance: string,
  code: "no_project_root" | "root_empty" | "snapshot_io_error",
): string {
  return [
    baseGuidance,
    "Recovery hint: start with `list_dir` on `.` when available; otherwise read `README.md` and run one scoped `glob` or `search_code` call.",
    `<SYNESIS_DISCOVERY_RECOVERY status="guided" code="${code}" version="1">`,
    "entries_total=0",
    "entries_preview=0",
    "message=Project root preview unavailable. Use one concrete path hint (README.md/go.mod/package.json), then scope to one directory.",
    "next_action=read_file:README.md|glob:src/*|glob:pkg/**/*_test.go|search_code:<symbol>",
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
      "Recovery hint: pick one directory from the preview and continue with scoped discovery.",
      "<SYNESIS_DISCOVERY_RECOVERY status=\"guided\" code=\"top_level_snapshot\" version=\"1\">",
      `entries_total=${normalized.length}`,
      `entries_preview=${preview.length}`,
      "message=Use list_dir on one of these directories, then use search_code with a symbol or error string.",
      ...previewLines,
      "</SYNESIS_DISCOVERY_RECOVERY>",
    ].join("\n"),
    previewCount: preview.length,
  };
}
