import type { RecentToolCall } from "../providers/model-adapter.js";

const SHELL_TOOLS = new Set([
  "bash",
  "execute_command",
  "run_terminal_cmd",
  "run_shell",
  "shell",
]);

function normalizeCommand(call: RecentToolCall): string {
  const args = call.args ?? {};
  const command = typeof args.command === "string"
    ? args.command
    : (typeof args.cmd === "string" ? args.cmd : "");
  return command.trim();
}

function runtimeToken(command: string): string | null {
  const lower = command.toLowerCase();
  if (!lower) return null;
  if (/\buv\s+run\b/.test(lower)) return "uv_run";
  if (/(^|\s)\.\/?\.?venv\/bin\/python([0-9.]*)?\b/.test(lower) || /(^|\s)venv\/bin\/python([0-9.]*)?\b/.test(lower)) {
    return "venv_python";
  }
  if (/(^|\s)python3\b/.test(lower)) return "python3";
  if (/(^|\s)python\b/.test(lower)) return "python";
  if (/(^|\s)pytest\b/.test(lower)) return "pytest_direct";
  return null;
}

function isPythonRelated(command: string): boolean {
  const lower = command.toLowerCase();
  return /\bpython\b|\bpython3\b|\buv\s+run\b|\bpytest\b|\bpip\b/.test(lower);
}

function isDependencySetupCommand(command: string): boolean {
  return /\b(?:uv\s+)?pip\s+install\b/i.test(command)
    || /\b(npm|pnpm|yarn)\s+install\b/i.test(command)
    || /\bgo\s+mod\s+tidy\b/i.test(command);
}

export interface PythonRuntimeDiscoveryLoopResult {
  detected: boolean;
  attempts: number;
  runtimeVariants: string[];
  guidance: string;
}

export function detectPythonRuntimeDiscoveryLoop(
  recentCalls: RecentToolCall[],
  windowSize = 10,
): PythonRuntimeDiscoveryLoopResult | null {
  const tail = recentCalls.slice(-windowSize);
  const tokens: string[] = [];
  let pythonAttempts = 0;

  for (const call of tail) {
    const tool = call.toolName.trim().toLowerCase();
    if (!SHELL_TOOLS.has(tool) && tool !== "run_test" && tool !== "run_build" && tool !== "run_lint") continue;
    const cmd = normalizeCommand(call);
    if (!cmd) continue;
    if (isDependencySetupCommand(cmd)) {
      tokens.length = 0;
      pythonAttempts = 0;
      continue;
    }
    if (!isPythonRelated(cmd)) continue;
    pythonAttempts += 1;
    const token = runtimeToken(cmd);
    if (token) tokens.push(token);
  }

  const runtimeVariants = [...new Set(tokens)];
  const hasProbeLoop = pythonAttempts >= 3 && runtimeVariants.length >= 2;
  if (!hasProbeLoop) return null;

  return {
    detected: true,
    attempts: pythonAttempts,
    runtimeVariants,
    guidance: [
      "<SYNESIS_PYTHON_RUNTIME_HINT>",
      `Python runtime probing loop detected (${pythonAttempts} attempts; variants: ${runtimeVariants.join(", ")}).`,
      "Do NOT keep retrying with different python command spellings.",
      "",
      "Resolve runtime once, then continue with that runtime:",
      "  if [ -x .venv/bin/python ]; then PY=.venv/bin/python;",
      "  elif command -v uv >/dev/null 2>&1; then PY='uv run python';",
      "  elif command -v python3 >/dev/null 2>&1; then PY=python3;",
      "  elif command -v python >/dev/null 2>&1; then PY=python;",
      "  else echo 'No Python runtime found (.venv/uv/python3/python)'; fi",
      "",
      "Run tests as `$PY -m pytest ...` (or `uv run pytest ...` when using uv).",
      "If runtime is missing, report the single probe result and stop retrying.",
      "</SYNESIS_PYTHON_RUNTIME_HINT>",
    ].join("\n"),
  };
}
