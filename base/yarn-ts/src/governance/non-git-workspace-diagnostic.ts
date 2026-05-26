import type { RecentToolCall } from "../providers/model-adapter.js";

const NON_GIT_RE = /\bInvalidGitRepositoryError\b|not a git repository|No git repository detected|fatal:\s+not a git repository/i;
const GITPYTHON_RE = /\bgit\.exc\.InvalidGitRepositoryError\b|site-packages\/git\b|GitPython/i;

export interface NonGitWorkspaceDiagnosticResult {
  detected: boolean;
  source: "pytest_plugin" | "git_command" | "unknown";
  guidance: string;
}

function commandOf(call: RecentToolCall): string {
  const args = call.args ?? {};
  return typeof args.command === "string"
    ? args.command
    : (typeof args.cmd === "string" ? args.cmd : "");
}

function classify(call: RecentToolCall): NonGitWorkspaceDiagnosticResult["source"] {
  const command = commandOf(call).toLowerCase();
  const result = String(call.resultContent ?? "");
  if (/\bpytest\b|python3?\s+-m\s+pytest|uv\s+run\s+pytest/.test(command) && GITPYTHON_RE.test(result)) {
    return "pytest_plugin";
  }
  if (/\bgit\s+/.test(command) || /fatal:\s+not a git repository/i.test(result)) {
    return "git_command";
  }
  return "unknown";
}

export function detectNonGitWorkspaceDiagnostic(
  recentCalls: RecentToolCall[],
  windowSize = 8,
): NonGitWorkspaceDiagnosticResult | null {
  const hit = recentCalls.slice(-windowSize).find((call) => NON_GIT_RE.test(String(call.resultContent ?? "")));
  if (!hit) return null;
  const source = classify(hit);
  const guidance = [
    "<SYNESIS_NON_GIT_WORKSPACE_HINT>",
    "No git repository is detected for this workspace. That is allowed for fresh local experiments and scaffolded projects.",
    "Do NOT run `git init`, `git status`, `git diff`, or other git workflow commands unless the user explicitly asks for a repository workflow.",
    source === "pytest_plugin"
      ? "The current failure appears to come from pytest/plugin/GitPython code assuming a git repository, not from missing application code."
      : "Treat the non-git result as workspace metadata, not as a reason to force git setup.",
    "",
    "Next step:",
    source === "pytest_plugin"
      ? "1) Capture the full traceback frame that first leaves site-packages or the plugin name causing the git lookup."
      : "1) Continue the requested scaffold/verification without git-specific commands.",
    source === "pytest_plugin"
      ? "2) Fix or configure that test/plugin path, or run the targeted pytest command with the git-dependent plugin disabled if it is unrelated to the app."
      : "2) If verification is failing, fix the application/test failure shown in the output.",
    "3) Re-run one narrow verification command after the fix.",
    "</SYNESIS_NON_GIT_WORKSPACE_HINT>",
  ].join("\n");
  return { detected: true, source, guidance };
}
