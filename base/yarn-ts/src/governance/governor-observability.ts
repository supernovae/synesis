export interface GovernorObservabilityMessage {
  role: string;
  tool_calls?: unknown;
}

export interface GovernorLoopObservability {
  hasRunTest: boolean;
  lastAssistantToolCalls: number;
  assistantToolCallsSinceLatestUser: number;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseToolCallName(call: unknown): string {
  if (!call || typeof call !== "object") return "";
  const row = call as Record<string, unknown>;
  const fn = row.function && typeof row.function === "object"
    ? (row.function as Record<string, unknown>)
    : null;
  return normalizeString(row.name ?? fn?.name).toLowerCase();
}

function parseToolCallCommand(call: unknown): string {
  if (!call || typeof call !== "object") return "";
  const row = call as Record<string, unknown>;
  const fn = row.function && typeof row.function === "object"
    ? (row.function as Record<string, unknown>)
    : null;
  const args = fn?.arguments ?? row.input;
  if (!args) return "";
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      return normalizeString(parsed.command ?? parsed.cmd).toLowerCase();
    } catch {
      return "";
    }
  }
  if (typeof args === "object" && !Array.isArray(args)) {
    const parsed = args as Record<string, unknown>;
    return normalizeString(parsed.command ?? parsed.cmd).toLowerCase();
  }
  return "";
}

function isTestToolCall(name: string, command: string): boolean {
  if (!name && !command) return false;
  if (name.includes("run_test")) return true;
  // Standard test runners
  if (/\b(go test|cargo test|cargo clippy|cargo check|dotnet test|ctest|mvn (test|verify)|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test)\b/.test(command)) return true;
  // JS: jest, vitest, npx variants, npm run test
  if (/\b(jest|vitest|npx jest|npx vitest)\b/.test(command)) return true;
  if (/\bnpm\s+run\s+(test|check|lint|build|typecheck)\b/.test(command)) return true;
  // Python: python -m pytest / uv run pytest / poetry
  if (/\bpython3?\s+-m\s+(pytest|mypy|ruff)\b/.test(command)) return true;
  if (/\buv\s+run\s+(pytest|ruff|mypy|coverage)\b/.test(command)) return true;
  if (/\b(poetry|pipenv)\s+run\s+\S/.test(command)) return true;
  // CLI binary invocations (./binary or /path/to/binary as a command)
  if (/(?:(?:^|[&|;])\s*)(?:\.\/|\/\w[\w/.-]*\/)\w[\w.-]*/.test(command)) return true;
  return false;
}

export function deriveGovernorLoopObservability(
  messages: GovernorObservabilityMessage[],
): GovernorLoopObservability {
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return i;
    }
    return -1;
  })();
  const turn = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;

  let hasRunTest = false;
  let assistantToolCallsSinceLatestUser = 0;
  let lastAssistantToolCalls = 0;

  for (const msg of turn) {
    if (msg.role !== "assistant") continue;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length > 0) {
      lastAssistantToolCalls = calls.length;
      assistantToolCallsSinceLatestUser += calls.length;
    }
    for (const call of calls) {
      const name = parseToolCallName(call);
      const command = parseToolCallCommand(call);
      if (isTestToolCall(name, command)) {
        hasRunTest = true;
      }
    }
  }

  return {
    hasRunTest,
    lastAssistantToolCalls,
    assistantToolCallsSinceLatestUser,
  };
}
