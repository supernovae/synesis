import { suggestScopedVerificationCommand } from "../verification/test-scope-selector.js";

export interface GovernorInputMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
}

export interface ExecutionGovernorDecision {
  pause: boolean;
  reason: string;
  suggestedNextStep?: string;
  matchedRules: string[];
  telemetry: {
    repeatedTestCommands: number;
    repeatedReadSearchCalls: number;
    repeatedBroadDiscoveryCalls: number;
    totalBroadDiscoveryCalls: number;
    broadTestRepeat: boolean;
    noEditEvidence: boolean;
  };
}

function normalizeString(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return "";
}

function parseArgsToCommand(toolName: string, args: unknown): string {
  if (typeof args === "string") {
    const t = args.trim();
    if (t.startsWith("{")) {
      try {
        const row = JSON.parse(t) as Record<string, unknown>;
        return parseArgsToCommand(toolName, row);
      } catch {
        return normalizeString(args);
      }
    }
    return normalizeString(args);
  }
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  if (typeof row.preset === "string" && normalizeString(toolName).toLowerCase().includes("run_test")) {
    return `run_test:${normalizeString(row.preset)}`;
  }
  for (const k of ["command", "cmd", "script"]) {
    if (typeof row[k] === "string") return normalizeString(row[k]);
  }
  const tool = normalizeString(toolName).toLowerCase();
  if (tool.includes("glob")) {
    const pattern = normalizeString(row.glob_pattern ?? row.pattern ?? row.glob);
    return pattern ? `glob:${pattern}` : "glob:*";
  }
  if (tool.includes("read_file") || tool === "read") {
    const p = normalizeString(row.filePath || row.file_path || row.path || row.target_file);
    if (p) return `read:${p}`;
  }
  if (tool.includes("write_file") || tool.includes("apply_patch") || tool.includes("str_replace") || tool === "edit" || tool === "update") {
    const p = normalizeString(row.filePath || row.file_path || row.path || row.target_file);
    if (p) return `edit:${p}`;
    return "edit";
  }
  if (tool.includes("list_files") || tool.includes("read_dir") || tool.includes("read_directory")) {
    const path = normalizeString(row.path || row.dir || row.directory);
    if (path) return `list:${path}`;
  }
  if (tool.includes("search") || tool.includes("grep")) {
    const query = normalizeString(row.query || row.pattern);
    if (query) return `search:${query}`;
  }
  return "";
}

function extractCommandEvents(messages: GovernorInputMessage[]): Array<{ command: string; toolName: string }> {
  const callById = new Map<string, { command: string; toolName: string }>();
  const out: Array<{ command: string; toolName: string }> = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const id = normalizeString(call.id);
        if (!id) continue;
        const toolName = normalizeString(call.function?.name ?? call.name).toLowerCase();
        const command = parseArgsToCommand(toolName, call.function?.arguments ?? call.input);
        if (!command) continue;
        callById.set(id, { command, toolName });
      }
      continue;
    }
    if (msg.role !== "tool" && msg.role !== "tool_result") continue;
    const id = normalizeString(msg.tool_call_id);
    if (!id) continue;
    const item = callById.get(id);
    if (!item) continue;
    out.push(item);
  }
  return out;
}

function isBroadDiscoveryCommand(toolName: string, command: string): boolean {
  const tool = normalizeString(toolName).toLowerCase();
  const cmd = normalizeString(command).toLowerCase();
  if (tool.includes("glob")) {
    return cmd === "glob:*" || cmd === "glob:**/*" || cmd.startsWith("glob:**/");
  }
  if (tool.includes("list_files") || tool.includes("read_dir") || tool.includes("read_directory")) {
    return cmd === "list:." || cmd === "list:/" || cmd === "list:";
  }
  return false;
}

function extractChangedFileHints(messages: GovernorInputMessage[]): string[] {
  const hints = new Set<string>();
  const joined = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n");
  const rx = /([a-zA-Z0-9_\-./]+?\.(?:go|ts|tsx|js|jsx|py|rs|java|kt|yaml|yml|json|md))/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(joined)) !== null) {
    hints.add(match[1]);
    if (hints.size >= 20) break;
  }
  return [...hints];
}

function extractUserText(messages: GovernorInputMessage[]): string {
  return messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => String(m.content))
    .join("\n")
    .toLowerCase();
}

function needsTestEntryGate(userText: string): boolean {
  return /\b(add|write|create|build).{0,30}\btests?\b/.test(userText)
    || /\bcomprehensive test suite\b/.test(userText);
}

function needsCleanupGate(userText: string): boolean {
  return /\b(clean ?up|technical debt|dead code|todo|fixme|debug logging|polish)\b/.test(userText)
    || /\brefactor\b/.test(userText);
}

function shouldSkipCleanupHarvest(userText: string): boolean {
  return /\b(do not|don't|skip|without)\b.{0,30}\b(todo|fixme|debug)\b.{0,20}\b(harvest|search)\b/.test(userText)
    || /\b(do not|don't|skip|without)\b.{0,40}\bcleanup[_ -]?todo[_ -]?harvest\b/.test(userText);
}

function hasTestConfigDiscovery(events: Array<{ command: string; toolName: string }>): boolean {
  return events.some((e) =>
    /search:.*(jest\.config|vitest|pytest\.ini|pyproject\.toml|package\.json|go\.mod)/i.test(e.command)
    || /read:.*(jest\.config|vitest|pytest\.ini|pyproject\.toml|package\.json|go\.mod)/i.test(e.command),
  );
}

type TestRuntime =
  | "go"
  | "rust"
  | "js_ts"
  | "python"
  | "java"
  | "kotlin"
  | "dotnet"
  | "cpp"
  | "ruby"
  | "php"
  | "swift"
  | "unknown";

function inferTestRuntime(
  events: Array<{ command: string; toolName: string }>,
  userText: string,
): TestRuntime {
  const joined = `${userText}\n${events.map((e) => `${e.toolName} ${e.command}`).join("\n")}`.toLowerCase();
  if (/\bcargo test\b|\.rs\b|cargo\.toml\b/.test(joined)) return "rust";
  if (/\bgo test\b|\.go\b|_test\.go\b|\bgo\.mod\b/.test(joined)) return "go";
  if (/\bmvn test\b|\bgradle test\b|\.java\b|pom\.xml\b/.test(joined)) return "java";
  if (/\bgradle test\b|\.kt\b|build\.gradle\.kts\b/.test(joined)) return "kotlin";
  if (/\bdotnet test\b|\.cs\b|\.sln\b|\.csproj\b/.test(joined)) return "dotnet";
  if (/\bctest\b|\bcmake\b|\.cpp\b|\.cc\b|\.cxx\b|\.c\b|\.h\b|\.hpp\b|cmakelists\.txt\b/.test(joined)) return "cpp";
  if (/\brspec\b|\.rb\b|gemfile\b/.test(joined)) return "ruby";
  if (/\bphpunit\b|\.php\b|composer\.json\b/.test(joined)) return "php";
  if (/\bxcodebuild test\b|swift test\b|\.swift\b|package\.swift\b/.test(joined)) return "swift";
  if (/\bvitest\b|\bjest\b|\bpnpm test\b|\bnpm test\b|\byarn test\b|\.tsx?\b|package\.json\b/.test(joined)) return "js_ts";
  if (/\bpytest\b|pyproject\.toml|pytest\.ini|\.py\b/.test(joined)) return "python";
  return "unknown";
}

function requiresTestConfigDiscovery(runtime: TestRuntime): boolean {
  return runtime === "js_ts" || runtime === "python";
}

function hasTodoHarvest(events: Array<{ command: string; toolName: string }>): boolean {
  return events.some((e) => /search:.*(todo|fixme|debug)/i.test(e.command));
}

function hasFailureSignals(messages: GovernorInputMessage[]): boolean {
  const joined = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n")
    .toLowerCase();
  return /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b/.test(joined);
}

export function evaluateExecutionGovernor(messages: GovernorInputMessage[]): ExecutionGovernorDecision {
  const events = extractCommandEvents(messages);
  const changedFiles = extractChangedFileHints(messages);
  const userText = extractUserText(messages);
  const hasFailures = hasFailureSignals(messages);
  const testRuntime = inferTestRuntime(events, userText);
  let repeatedTestCommands = 0;
  let repeatedReadSearchCalls = 0;
  let repeatedBroadDiscoveryCalls = 0;
  let totalBroadDiscoveryCalls = 0;
  let broadTestRepeat = false;
  const noEditEvidence = changedFiles.length === 0;
  const matchedRules: string[] = [];
  const hasRunTest = events.some((e) =>
    /\b(go test|cargo test|dotnet test|ctest|mvn test|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test)\b/i.test(e.command)
    || e.toolName.includes("run_test"),
  );
  const hasEdit = events.some((e) => e.command.startsWith("edit:") || e.command === "edit");

  const BROAD_DISCOVERY_WINDOW = 20;
  const windowStart = Math.max(0, events.length - BROAD_DISCOVERY_WINDOW);

  for (let i = 0; i < events.length; i += 1) {
    const tool = events[i].toolName;
    if (i >= windowStart && isBroadDiscoveryCommand(tool, events[i].command)) {
      totalBroadDiscoveryCalls += 1;
    }
    if (i === 0) continue;
    if (events[i].command !== events[i - 1].command) continue;
    if (tool.includes("run_test") || /\b(go test|npm test|pnpm test|yarn test)\b/i.test(events[i].command)) {
      repeatedTestCommands += 1;
      if (/go test \.\/\.\.\.|^npm test$|^pnpm test$|^yarn test$/i.test(events[i].command)) {
        broadTestRepeat = true;
      }
    }
    if (i >= windowStart && (tool.includes("search") || tool.includes("read"))) {
      repeatedReadSearchCalls += 1;
    }
    if (isBroadDiscoveryCommand(tool, events[i].command)) {
      repeatedBroadDiscoveryCalls += 1;
    }
  }

  if (broadTestRepeat) matchedRules.push("broad_to_narrow_verification");
  if (repeatedTestCommands >= 2) matchedRules.push("edit_before_retest");
  if (broadTestRepeat && repeatedTestCommands >= 1 && noEditEvidence) matchedRules.push("no_repeat_without_change");
  if (totalBroadDiscoveryCalls >= 4 || repeatedBroadDiscoveryCalls >= 2) matchedRules.push("broad_discovery_repeat");
  if (repeatedReadSearchCalls >= 5) matchedRules.push("bounded_exploration_budget");
  if (needsTestEntryGate(userText) && hasRunTest && requiresTestConfigDiscovery(testRuntime) && !hasTestConfigDiscovery(events)) {
    matchedRules.push("test_entry_contract");
  }
  const cleanupHarvestRequested = needsCleanupGate(userText) && !shouldSkipCleanupHarvest(userText);
  if (cleanupHarvestRequested && hasEdit && !hasTodoHarvest(events)) {
    matchedRules.push("cleanup_todo_harvest");
  }

  if (matchedRules.length === 0) {
    return {
      pause: false,
      reason: "ok",
      matchedRules: ["allow"],
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
      },
    };
  }

  // Avoid trapping the model in repeated broad verification when output is already green.
  if (broadTestRepeat && repeatedTestCommands >= 1 && !hasFailures) {
    matchedRules.push("verification_already_green");
    return {
      pause: false,
      reason: "verification_already_green",
      suggestedNextStep: "Verification is already passing. Stop re-running broad go vet/go test checks and continue implementing the next requested feature.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
      },
    };
  }

  const latestTest = [...events]
    .reverse()
    .find((e) => /\b(go test|npm test|pnpm test|yarn test)\b/i.test(e.command));
  const scoped = latestTest
    ? suggestScopedVerificationCommand(latestTest.command, changedFiles)
    : { suggestedCommand: null };
  let suggestedNextStep = scoped.suggestedCommand
    ?? (noEditEvidence
      ? "Apply one focused code change for a single root-cause hypothesis, then run one narrow verification command."
      : "State one root-cause hypothesis and run one narrow verification command.");
  if (totalBroadDiscoveryCalls >= 4 || repeatedBroadDiscoveryCalls >= 2) {
    suggestedNextStep = "Run one targeted repo summary (for example synesis_inspect_repo), then read only 1-3 likely files; do not repeat Glob(\"*\") again.";
  } else if (matchedRules.includes("test_entry_contract")) {
    suggestedNextStep =
      testRuntime === "python"
        ? "Before running tests, inspect existing test conventions: search_code for pytest.ini/pyproject.toml and read the nearest existing test file."
        : "Before running tests, inspect existing test conventions: search_code for jest.config/vitest/package.json and read the nearest existing test file.";
  } else if (matchedRules.includes("cleanup_todo_harvest")) {
    suggestedNextStep = "Before edits, run one targeted search_code for TODO|FIXME|DEBUG and rank top cleanup candidates, then patch highest-impact files only.";
  } else if (matchedRules.includes("bounded_exploration_budget")) {
    suggestedNextStep = "State one root-cause hypothesis, then read at most 3 files directly tied to it before applying a patch.";
  }

  const onlyCleanupHarvest =
    matchedRules.length === 1 && matchedRules[0] === "cleanup_todo_harvest";
  if (onlyCleanupHarvest) {
    return {
      pause: false,
      reason: "cleanup_todo_harvest advisory only",
      suggestedNextStep,
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
      },
    };
  }

  return {
    pause: true,
    reason: "Execution governor detected low-yield repetition. Pivot to a narrower, hypothesis-driven step.",
    suggestedNextStep,
    matchedRules,
    telemetry: {
      repeatedTestCommands,
      repeatedReadSearchCalls,
      repeatedBroadDiscoveryCalls,
      totalBroadDiscoveryCalls,
      broadTestRepeat,
      noEditEvidence,
    },
  };
}

export function executionGovernorSoftFailMessage(decision: ExecutionGovernorDecision): string {
  return [
    "I paused to avoid a low-yield loop (repeating broad checks without enough new signal).",
    `Matched rules: ${decision.matchedRules.join(", ")}.`,
    `Next step: ${decision.suggestedNextStep ?? "pick one narrow verification step before continuing."}`,
  ].join(" ");
}

export function executionGovernorRecoveryRewriteBlock(decision: ExecutionGovernorDecision): string {
  const rules = new Set(decision.matchedRules);
  const testFlow = rules.has("test_entry_contract");
  const explorationLoop = rules.has("bounded_exploration_budget") || rules.has("broad_discovery_repeat");
  const bullet = testFlow
    ? "Use Grep first for test files/configs (_test, test_, jest.config, vitest, pytest.ini), then Read at most 3 highest-signal files."
    : "Read README.md or package.json, then use a scoped Glob (e.g. src/*) or Grep. Read at most 3 likely files and stop broad scanning.";
  const globRule = explorationLoop
    ? "Do not call Glob(\"*\") or empty glob patterns. If glob is required, use scoped patterns such as src/* or pkg/**/*_test.go."
    : "Avoid broad discovery loops; each tool call must refine scope.";
  return [
    "<SYNESIS_EXECUTION_RECOVERY status=\"rewrite\" version=\"1\">",
    `matched_rules=${decision.matchedRules.join(",")}`,
    "objective=convert broad exploration into bounded hypothesis-driven workflow",
    `step1=${bullet}`,
    `step2=${globRule}`,
    "step3=before any large read, state one concrete hypothesis and one verification command",
    `next_action=${decision.suggestedNextStep ?? "run one narrow verification step"}`,
    "</SYNESIS_EXECUTION_RECOVERY>",
  ].join("\n");
}
