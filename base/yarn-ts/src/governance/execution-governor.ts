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
    trailingVerificationRunLength: number;
  };
}

interface CommandEvent {
  command: string;
  toolName: string;
  resultSignature: string;
  argsObject?: Record<string, unknown> | null;
}

export type GovernanceProfileName = "safety_strict" | "balanced_completion" | "strict_control";

interface GovernorThresholds {
  repeatedTestPauseThreshold: number;
  repeatedReadSearchPauseThreshold: number;
  totalBroadDiscoveryPauseThreshold: number;
  repeatedBroadDiscoveryPauseThreshold: number;
  broadVerificationNoticeThreshold: number;
  broadVerificationBlockThreshold: number;
  verificationStallThreshold: number;
}

const BALANCED_THRESHOLDS: GovernorThresholds = {
  repeatedTestPauseThreshold: 2,
  repeatedReadSearchPauseThreshold: 5,
  totalBroadDiscoveryPauseThreshold: 4,
  repeatedBroadDiscoveryPauseThreshold: 2,
  broadVerificationNoticeThreshold: 3,
  broadVerificationBlockThreshold: 4,
  verificationStallThreshold: 6,
};

function thresholdsForProfile(profile: GovernanceProfileName): GovernorThresholds {
  if (profile === "safety_strict") {
    return {
      ...BALANCED_THRESHOLDS,
      // Safety-first profile: keep hard runaway controls, reduce behavioral policing.
      repeatedTestPauseThreshold: 4,
      repeatedReadSearchPauseThreshold: 8,
      totalBroadDiscoveryPauseThreshold: 8,
      repeatedBroadDiscoveryPauseThreshold: 4,
      broadVerificationNoticeThreshold: 6,
      broadVerificationBlockThreshold: 8,
      verificationStallThreshold: 10,
    };
  }
  if (profile === "strict_control") {
    return {
      ...BALANCED_THRESHOLDS,
      // Debug/forensics profile: nudge earlier and harder.
      repeatedTestPauseThreshold: 1,
      repeatedReadSearchPauseThreshold: 3,
      totalBroadDiscoveryPauseThreshold: 3,
      repeatedBroadDiscoveryPauseThreshold: 1,
      broadVerificationNoticeThreshold: 2,
      broadVerificationBlockThreshold: 3,
      verificationStallThreshold: 4,
    };
  }
  return BALANCED_THRESHOLDS;
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
  if (tool === "taskcreate" || tool === "task_create" || tool.includes("taskcreate")) {
    const title = normalizeString(row.title || row.name || row.content || row.task);
    return title ? `taskcreate:${title}` : "taskcreate";
  }
  if (tool === "taskupdate" || tool === "task_update" || tool.includes("taskupdate")) {
    const title = normalizeString(row.title || row.name || row.content || row.task || row.id);
    return title ? `taskupdate:${title}` : "taskupdate";
  }
  if (tool === "todowrite" || tool.includes("todowrite")) {
    const todos = Array.isArray(row.todos) ? row.todos : [];
    const firstTodo = todos.length > 0 && typeof todos[0] === "object" && todos[0] !== null
      ? normalizeString((todos[0] as Record<string, unknown>).content)
      : "";
    return firstTodo ? `todowrite:${firstTodo}` : "todowrite";
  }
  return "";
}

function parseArgsToObject(args: unknown): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  const t = args.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function normalizeResultSignature(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) return "";
  return content
    .toLowerCase()
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, "<t>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function extractCommandEvents(messages: GovernorInputMessage[]): CommandEvent[] {
  const callById = new Map<string, { command: string; toolName: string; argsObject?: Record<string, unknown> | null }>();
  const out: CommandEvent[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const id = normalizeString(call.id);
        if (!id) continue;
        const toolName = normalizeString(call.function?.name ?? call.name).toLowerCase();
        const rawArgs = call.function?.arguments ?? call.input;
        const command = parseArgsToCommand(toolName, rawArgs);
        if (!command) continue;
        callById.set(id, { command, toolName, argsObject: parseArgsToObject(rawArgs) });
      }
      continue;
    }
    if (msg.role !== "tool" && msg.role !== "tool_result") continue;
    const id = normalizeString(msg.tool_call_id);
    if (!id) continue;
    const item = callById.get(id);
    if (!item) continue;
    out.push({
      ...item,
      resultSignature: normalizeResultSignature(msg.content),
    });
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

function extractEditedFileHints(events: CommandEvent[]): string[] {
  const hints = new Set<string>();
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!c.startsWith("edit:")) continue;
    const file = c.slice("edit:".length).trim();
    if (!file) continue;
    hints.add(file);
    if (hints.size >= 20) break;
  }
  return [...hints];
}

function hasFailureSignature(sig: string): boolean {
  if (!sig) return false;
  return /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b|expected statement\b|undefined:\b/.test(sig);
}

function isCompileLikeFailureSignature(sig: string): boolean {
  if (!sig) return false;
  return /imported and not used|declared but its value is never read|unused (variable|import|binding)|undefined\b|cannot find symbol|unresolved reference|type mismatch|syntax error|expected .* found|failed to compile|compilation failed|build failed/.test(sig);
}

function hasSuccessSignature(sig: string): boolean {
  if (!sig) return false;
  return /\bok\b|\bpass(ed)?\b|\bbuild successful\b|\bsuccess\b|\bno test files\b/.test(sig);
}

function hasEditFailureSignature(sig: string): boolean {
  if (!sig) return false;
  return /error editing file|old_string.*not found|failed to apply patch|no changes made|did not match file content/.test(sig);
}

function hasCompletionClaimInAssistantText(messages: GovernorInputMessage[]): boolean {
  const assistantText = messages
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => String(m.content).toLowerCase())
    .join("\n");
  if (!assistantText.trim()) return false;
  return /\bi('| a)?ve?\s+(completed|finished|done|implemented)\b/.test(assistantText)
    || /\b(task|feature|clipboard|implementation)\s+(is\s+)?(complete|done)\b/.test(assistantText);
}

function hasTaskDoneStatusUpdate(events: CommandEvent[]): boolean {
  for (const e of events) {
    const tool = normalizeString(e.toolName).toLowerCase();
    const args = e.argsObject ?? {};
    if (tool.includes("taskupdate")) {
      const status = normalizeString(args.status).toLowerCase();
      if (status === "done" || status === "completed") return true;
    }
    if (tool.includes("todowrite")) {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      for (const todo of todos) {
        if (!todo || typeof todo !== "object") continue;
        const status = normalizeString((todo as Record<string, unknown>).status).toLowerCase();
        if (status === "done" || status === "completed") return true;
      }
    }
  }
  return false;
}

function isDeclarationOnlyEditResultSignature(sig: string): boolean {
  if (!sig) return false;
  const looksSmallEdit = /added <n> line|added <n> lines|removed <n> line|removed <n> lines/.test(sig);
  const declarationMarker =
    /\bimport\b/.test(sig)
    || /\bflag\b/.test(sig)
    || /\brequire\b/.test(sig)
    || /\binclude\b/.test(sig)
    || /\buse\b/.test(sig)
    || /\busing\b/.test(sig)
    || /\bextern\b/.test(sig);
  return looksSmallEdit && declarationMarker;
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

function isBroadVerificationCommand(command: string): boolean {
  const cmd = normalizeString(command).toLowerCase();
  if (!cmd) return false;
  return /\bgo\s+test\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+build\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+vet\s+\.\/\.\.\./.test(cmd)
    || /\bnpm\s+test\b/.test(cmd)
    || /\bpnpm\s+test\b/.test(cmd)
    || /\byarn\s+test\b/.test(cmd);
}

function isVerificationCommand(toolName: string, command: string): boolean {
  const tool = normalizeString(toolName).toLowerCase();
  const cmd = normalizeString(command).toLowerCase();
  return tool.includes("run_test")
    || /\b(go test|go build|go vet|cargo test|dotnet test|ctest|mvn test|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test|eslint|ruff|golangci-lint)\b/.test(cmd);
}

function isGitAddWithoutCommit(events: CommandEvent[]): boolean {
  let sawGitAdd = false;
  let sawGitCommit = false;
  const tail = events.slice(-6);
  for (const e of tail) {
    const cmd = normalizeString(e.command).toLowerCase();
    if (/\bgit\s+add\b/.test(cmd)) sawGitAdd = true;
    if (/\bgit\s+commit\b/.test(cmd)) sawGitCommit = true;
  }
  return sawGitAdd && !sawGitCommit;
}

function isDependencyInstallReplay(events: CommandEvent[]): boolean {
  const depCmds = new Map<string, number>();
  for (const e of events) {
    const cmd = normalizeString(e.command).toLowerCase();
    const isDepInstall =
      /\bnpm\s+install\b/.test(cmd)
      || /\bpnpm\s+install\b/.test(cmd)
      || /\byarn\s+install\b/.test(cmd)
      || /\bgo\s+mod\s+tidy\b/.test(cmd)
      || /\bpip\s+install\b/.test(cmd)
      || /\buv\s+pip\s+install\b/.test(cmd)
      || /\bcargo\s+build\b/.test(cmd);
    if (!isDepInstall) continue;
    const key = cmd.slice(0, 60);
    depCmds.set(key, (depCmds.get(key) ?? 0) + 1);
  }
  for (const count of depCmds.values()) {
    if (count >= 2) return true;
  }
  return false;
}

function isReadOnlyInvestigationIntent(userText: string): boolean {
  return /\b(explain|what does|how does|show me|describe|analyze|understand|review)\b/.test(userText)
    && !/\b(fix|implement|add|create|change|edit|update|write|refactor|delete|remove)\b/.test(userText);
}

function isTruncatedVerificationCommand(command: string): boolean {
  const cmd = normalizeString(command).toLowerCase();
  return /\|\s*head\b/.test(cmd)
    || /\|\s*tail\b/.test(cmd)
    || /\|\s*sed\s+-n\b/.test(cmd);
}

function hasFailureSignals(messages: GovernorInputMessage[]): boolean {
  // Only inspect tool/tool_result payloads. User/assistant narration can contain
  // words like "invalid tool parameters" that should not block green verification bypass.
  const joined = messages
    .filter((m) => m.role === "tool" || m.role === "tool_result")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n")
    .toLowerCase();
  if (!joined.trim()) return false;
  if (/validation_failed|invalid tool parameters|synesis_error/.test(joined)) return false;
  // Common success summaries can contain words like "failed" in zero-count contexts.
  const zeroFailureOnly =
    /\b0\s*failed\b/.test(joined)
    || /\bfailed\s*:\s*0\b/.test(joined)
    || /\b0\s*failures?\b/.test(joined)
    || /\bfailures?\s*:\s*0\b/.test(joined)
    || /\bno\s+failures?\b/.test(joined)
    || /\b0\s*errors?\b/.test(joined)
    || /\berrors?\s*:\s*0\b/.test(joined)
    || /\ball tests passed\b/.test(joined);
  if (zeroFailureOnly && !/\b(1|[2-9]\d*)\s+failed\b|\bpanic\b|\btraceback\b/.test(joined)) return false;
  return /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b/.test(joined);
}

export interface ExecutionGovernorOptions {
  profile?: GovernanceProfileName;
  activePlanStage?: string | null;
}

export function evaluateExecutionGovernor(
  messages: GovernorInputMessage[],
  profileOrOptions: GovernanceProfileName | ExecutionGovernorOptions = "balanced_completion",
): ExecutionGovernorDecision {
  const opts: ExecutionGovernorOptions = typeof profileOrOptions === "string"
    ? { profile: profileOrOptions }
    : profileOrOptions;
  const profile = opts.profile ?? "balanced_completion";
  const activePlanStage = opts.activePlanStage ?? null;
  const thresholds = thresholdsForProfile(profile);
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") return i;
    }
    return -1;
  })();
  const turnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
  const events = extractCommandEvents(turnMessages);
  const changedFiles = extractEditedFileHints(events);
  const userText = extractUserText(messages);
  const hasFailures = hasFailureSignals(turnMessages);
  const testRuntime = inferTestRuntime(events, userText);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastEventIsVerification = lastEvent
    ? isVerificationCommand(lastEvent.toolName, lastEvent.command)
    : false;
  let repeatedTestCommands = 0;
  let repeatedReadSearchCalls = 0;
  let repeatedBroadDiscoveryCalls = 0;
  let totalBroadDiscoveryCalls = 0;
  let broadVerificationCommands = 0;
  let broadTestRepeat = false;
  let repeatedFailingVerification = 0;
  let repeatedSuccessfulVerification = 0;
  let repeatedNoSignalVerification = 0;
  let repeatedTruncatedVerification = 0;
  let repeatedCompileLikeFailureVerification = 0;
  let repeatedEditFailureReplay = 0;
  let repeatedTaskCreateReplay = 0;
  let declarationFollowthroughViolation = false;
  let completionClaimNeedsTaskUpdate = false;
  const noEditEvidence = changedFiles.length === 0;
  const matchedRules: string[] = [];
  const hasRunTest = events.some((e) =>
    /\b(go test|cargo test|dotnet test|ctest|mvn test|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test)\b/i.test(e.command)
    || e.toolName.includes("run_test"),
  );
  const hasEdit = events.some((e) => e.command.startsWith("edit:") || e.command === "edit");

  const BROAD_DISCOVERY_WINDOW = 20;
  const windowStart = Math.max(0, events.length - BROAD_DISCOVERY_WINDOW);
  const editFailureReplay = new Map<string, number>();
  const taskCreateReplay = new Map<string, number>();

  for (let i = 0; i < events.length; i += 1) {
    const tool = events[i].toolName;
    const currentIsBroadVerification = isBroadVerificationCommand(events[i].command);
    if (i >= windowStart && isBroadDiscoveryCommand(tool, events[i].command)) {
      totalBroadDiscoveryCalls += 1;
    }
    if (i >= windowStart && currentIsBroadVerification) {
      broadVerificationCommands += 1;
    }
    if (i === 0) continue;
    const previousIsBroadVerification = isBroadVerificationCommand(events[i - 1].command);
    if (
      isVerificationCommand(tool, events[i].command)
      && isVerificationCommand(events[i - 1].toolName, events[i - 1].command)
      && (
        events[i].command === events[i - 1].command
        || (currentIsBroadVerification && previousIsBroadVerification)
      )
    ) {
      repeatedTestCommands += 1;
      if (currentIsBroadVerification || previousIsBroadVerification) broadTestRepeat = true;
      if (
        events[i].resultSignature
        && events[i - 1].resultSignature
        && events[i].resultSignature === events[i - 1].resultSignature
        && hasFailureSignature(events[i].resultSignature)
      ) {
        repeatedFailingVerification += 1;
        if (isCompileLikeFailureSignature(events[i].resultSignature)) {
          repeatedCompileLikeFailureVerification += 1;
        }
      }
      if (
        events[i].resultSignature
        && events[i - 1].resultSignature
        && events[i].resultSignature === events[i - 1].resultSignature
        && hasSuccessSignature(events[i].resultSignature)
      ) {
        repeatedSuccessfulVerification += 1;
      }
      if (!events[i].resultSignature && !events[i - 1].resultSignature) {
        repeatedNoSignalVerification += 1;
      }
    }
    if (
      isVerificationCommand(tool, events[i].command)
      && isVerificationCommand(events[i - 1].toolName, events[i - 1].command)
      && isTruncatedVerificationCommand(events[i].command)
      && isTruncatedVerificationCommand(events[i - 1].command)
    ) {
      repeatedTruncatedVerification += 1;
    }
    if (events[i].command !== events[i - 1].command) continue;
    if (i >= windowStart && (tool.includes("search") || tool.includes("read"))) {
      repeatedReadSearchCalls += 1;
    }
    if (isBroadDiscoveryCommand(tool, events[i].command)) {
      repeatedBroadDiscoveryCalls += 1;
    }
  }
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!c.startsWith("edit:")) continue;
    if (!hasEditFailureSignature(e.resultSignature)) continue;
    const key = `${c}|${e.resultSignature}`;
    const next = (editFailureReplay.get(key) ?? 0) + 1;
    editFailureReplay.set(key, next);
    if (next >= 2) repeatedEditFailureReplay += 1;
  }
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!(c.startsWith("taskcreate:") || c === "taskcreate" || c.startsWith("todowrite:") || c === "todowrite")) continue;
    const key = c;
    const next = (taskCreateReplay.get(key) ?? 0) + 1;
    taskCreateReplay.set(key, next);
    if (next >= 2) repeatedTaskCreateReplay += 1;
  }

  // Count trailing verification commands from end of events, stopping at first edit.
  // Also track unique commands to distinguish legitimate multi-package verification
  // from the stall pattern (same 2-3 commands cycling: go build → go test → go build → ...).
  let trailingVerificationRunLength = 0;
  const trailingVerificationCommands = new Set<string>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].command.startsWith("edit:") || events[i].command === "edit") break;
    if (isVerificationCommand(events[i].toolName, events[i].command)) {
      trailingVerificationRunLength += 1;
      trailingVerificationCommands.add(events[i].command);
    }
  }
  const trailingVerificationHasRepeats = trailingVerificationRunLength > trailingVerificationCommands.size;

  // Enforce follow-through when a declaration-only edit is made: avoid read/search churn.
  let sawDeclarationOnlyEdit = false;
  let sawFollowupConcreteEdit = false;
  let nonActionAfterDeclarationEdit = 0;
  for (const e of events) {
    const c = normalizeString(e.command);
    if (c.startsWith("edit:")) {
      if (isDeclarationOnlyEditResultSignature(e.resultSignature)) {
        sawDeclarationOnlyEdit = true;
        sawFollowupConcreteEdit = false;
        nonActionAfterDeclarationEdit = 0;
        continue;
      }
      if (sawDeclarationOnlyEdit) {
        sawFollowupConcreteEdit = true;
      }
      continue;
    }
    if (!sawDeclarationOnlyEdit || sawFollowupConcreteEdit) continue;
    const t = normalizeString(e.toolName).toLowerCase();
    const isReadOrSearch = t.includes("read") || t.includes("search") || t.includes("grep") || t.includes("glob");
    if (isReadOrSearch) nonActionAfterDeclarationEdit += 1;
  }
  if (sawDeclarationOnlyEdit && !sawFollowupConcreteEdit && nonActionAfterDeclarationEdit >= 2) {
    declarationFollowthroughViolation = true;
  }
  const hasTaskLifecycleTraffic = events.some((e) => {
    const tool = normalizeString(e.toolName).toLowerCase();
    return tool.includes("taskcreate") || tool.includes("taskupdate") || tool.includes("todowrite");
  });
  const claimButNoUpdate = hasTaskLifecycleTraffic && hasCompletionClaimInAssistantText(turnMessages) && !hasTaskDoneStatusUpdate(events);
  const planNotFinalized = activePlanStage !== null && activePlanStage !== "finalize" && activePlanStage !== "done";
  if (claimButNoUpdate || (hasCompletionClaimInAssistantText(turnMessages) && planNotFinalized)) {
    completionClaimNeedsTaskUpdate = true;
  }

  // Read-only investigation intent: suppress noEditEvidence-dependent rules.
  const isInvestigationOnly = isReadOnlyInvestigationIntent(userText);

  if (broadTestRepeat) matchedRules.push("broad_to_narrow_verification");
  if (!isInvestigationOnly && isGitAddWithoutCommit(events) && events.length >= 4) matchedRules.push("git_commit_followthrough");
  if (isDependencyInstallReplay(events)) matchedRules.push("dependency_install_replay");
  const hasFailureDrivenVerificationLoop =
    hasFailures || repeatedFailingVerification > 0 || repeatedCompileLikeFailureVerification > 0;
  if (repeatedTestCommands >= thresholds.repeatedTestPauseThreshold && hasFailureDrivenVerificationLoop) {
    matchedRules.push("edit_before_retest");
  }
  if (broadTestRepeat && repeatedTestCommands >= 1 && noEditEvidence && hasFailureDrivenVerificationLoop) {
    matchedRules.push("no_repeat_without_change");
  }
  const effectiveNoEditEvidence = noEditEvidence && !isInvestigationOnly;
  if (repeatedCompileLikeFailureVerification >= 1 && effectiveNoEditEvidence) matchedRules.push("verification_same_failure_signature_replay");
  if (repeatedEditFailureReplay >= 1) matchedRules.push("edit_failure_replay");
  if (repeatedTaskCreateReplay >= 1) matchedRules.push("task_creation_replay");
  if (!isInvestigationOnly && declarationFollowthroughViolation) matchedRules.push("declaration_followthrough_required");
  if (completionClaimNeedsTaskUpdate) matchedRules.push("completion_claim_requires_task_update");
  if (repeatedFailingVerification >= 2 && effectiveNoEditEvidence) matchedRules.push("verification_fail_repeat_block");
  if (repeatedTruncatedVerification >= 1 && effectiveNoEditEvidence) matchedRules.push("verification_truncated_output");
  if (!broadTestRepeat && !hasFailures && repeatedSuccessfulVerification >= 1 && effectiveNoEditEvidence) matchedRules.push("verification_done_report");
  if (!broadTestRepeat && !hasFailures && repeatedNoSignalVerification >= 1 && effectiveNoEditEvidence) matchedRules.push("verification_no_signal_repeat");
  if (!isInvestigationOnly && trailingVerificationRunLength >= thresholds.verificationStallThreshold && !hasFailures && trailingVerificationHasRepeats) {
    matchedRules.push("verification_stall_no_edit");
  }
  if (
    totalBroadDiscoveryCalls >= thresholds.totalBroadDiscoveryPauseThreshold
    || repeatedBroadDiscoveryCalls >= thresholds.repeatedBroadDiscoveryPauseThreshold
  ) matchedRules.push("broad_discovery_repeat");
  if (repeatedReadSearchCalls >= thresholds.repeatedReadSearchPauseThreshold) matchedRules.push("bounded_exploration_budget");
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
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("dependency_install_replay")) {
    return {
      pause: true,
      reason: "dependency_install_replay",
      suggestedNextStep:
        "You are repeating the same dependency install command without code changes. If the install succeeded, move on to the next code edit. If it failed, investigate the specific error rather than re-running.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_same_failure_signature_replay")) {
    return {
      pause: true,
      reason: "verification_same_failure_signature_replay",
      suggestedNextStep:
        "You are replaying the same compile/build failure signature without edits. Stop rerunning broad verification. Make one concrete code fix at the reported symbol/location, then run one narrow package/file-level verification.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("edit_failure_replay")) {
    return {
      pause: true,
      reason: "edit_failure_replay",
      suggestedNextStep:
        "You are replaying the same edit failure. Stop retrying the same patch. Read the exact target section once (use offset/limit if large), then issue one corrected Edit/Update with exact old_string/new_string, and verify narrowly.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("task_creation_replay")) {
    return {
      pause: true,
      reason: "task_creation_replay",
      suggestedNextStep:
        "You are recreating duplicate tasks. Stop creating new task entries for the same intent. Update existing task status and execute one concrete code action (Edit/Write/test) for the active task.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("declaration_followthrough_required")) {
    return {
      pause: true,
      reason: "declaration_followthrough_required",
      suggestedNextStep:
        "You made a declaration-only edit (for example import/flag) but did not complete a usage-site change. Stop additional read/search calls and apply one concrete follow-through edit that wires the new declaration into runtime behavior, then run narrow verification.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("completion_claim_requires_task_update")) {
    return {
      pause: true,
      reason: "completion_claim_requires_task_update",
      suggestedNextStep:
        "You claimed completion but task statuses were not marked done. Update existing task entries to done (TaskUpdate/TodoWrite) for completed scope before reporting final completion.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_fail_repeat_block")) {
    return {
      pause: true,
      reason: "verification_fail_repeat_block",
      suggestedNextStep:
        "You are repeating the same failing verification output. STOP re-running tests/builds. Read the failing file/error location, apply exactly one focused Edit/Write to address that root cause, then run one narrow verification command.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_stall_no_edit")) {
    return {
      pause: true,
      reason: "verification_stall_no_edit",
      suggestedNextStep:
        `You have run ${trailingVerificationRunLength} verification commands without making any code edits. Builds and tests are passing — there is nothing left to verify. Stop running build/test commands. Pick the next unfinished task item, read the relevant source file once, make one concrete code edit (Write/Edit), then run one narrow verification.`,
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_truncated_output")) {
    return {
      pause: true,
      reason: "verification_truncated_output",
      suggestedNextStep:
        "Verification output was truncated (for example via | head/tail), so failures may be hidden. Run one narrow verification command without output truncation, capture full result, then apply one focused edit if needed.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("git_commit_followthrough")) {
    return {
      pause: false,
      reason: "git_commit_followthrough",
      suggestedNextStep:
        "You ran git add but did not follow through with git commit. If changes are ready, run git commit now. If not, continue editing — do not loop on git status/diff.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_done_report")) {
    return {
      pause: false,
      reason: "verification_done_report",
      suggestedNextStep:
        "Verification is already passing and no new edits were made. Do not rerun verification; continue with the next requested non-verification action (for example update plan state) and provide a concise completion report.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_no_signal_repeat")) {
    return {
      pause: false,
      reason: "verification_no_signal_repeat",
      suggestedNextStep:
        "Repeated verification produced no new output and no edits were made. Treat the last successful exit as sufficient; continue with the next requested non-verification action and report completion (or make one concrete edit before any further verification).",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  const verificationLoopRules = new Set([
    "broad_to_narrow_verification",
    "edit_before_retest",
    "no_repeat_without_change",
  ]);
  const hasOnlyVerificationLoopRules = matchedRules.every((r) => verificationLoopRules.has(r));
  if (!lastEventIsVerification && hasOnlyVerificationLoopRules) {
    return {
      pause: false,
      reason: "verification_loop_advisory_after_pivot",
      suggestedNextStep:
        "Verification reruns were detected earlier, but you have already pivoted to a non-verification action. Continue that action (for example updating plan status or applying the next edit) instead of running more tests now.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  // Avoid trapping the model in repeated broad verification when output is already green.
  if (broadVerificationCommands >= thresholds.broadVerificationNoticeThreshold) {
    broadTestRepeat = true;
    if (!matchedRules.includes("broad_to_narrow_verification")) matchedRules.push("broad_to_narrow_verification");
  }

  if (broadTestRepeat && repeatedTestCommands >= 1 && !hasFailures) {
    matchedRules.push("verification_already_green");
    const shouldPause = broadVerificationCommands >= thresholds.broadVerificationBlockThreshold;
    if (shouldPause) matchedRules.push("verification_green_repeat_block");
    return {
      pause: shouldPause,
      reason: shouldPause
        ? "verification_green_repeat_block"
        : "verification_already_green",
      suggestedNextStep: shouldPause
        ? "Verification is already green. Stop broad go test/go build checks now. Make exactly one concrete code edit for the next requested feature, then run one narrow verification command."
        : "Verification is already passing. Stop re-running broad go vet/go test checks and continue implementing the next requested feature.",
      matchedRules,
      telemetry: {
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
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
        trailingVerificationRunLength,
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
      trailingVerificationRunLength,
    },
  };
}

export function executionGovernorRecoveryRewriteBlock(decision: ExecutionGovernorDecision): string {
  const reason = decision.reason;
  let step1: string;
  let step2: string;
  let step3: string;

  switch (reason) {
    case "verification_stall_no_edit":
      step1 = "STOP running build and test commands. Verification is already passing — there is nothing to check.";
      step2 = "Identify the next unfinished task item and read the relevant source file once (with offset/limit if large).";
      step3 = "Make one concrete code edit (Write/Edit) for that task item, then run one narrow verification.";
      break;
    case "verification_fail_repeat_block":
    case "verification_same_failure_signature_replay":
    case "verification_truncated_output":
      step1 = "Read the failing file at the error location (use offset/limit). Do NOT re-read README or unrelated files.";
      step2 = "Make one concrete code fix at the reported symbol/location.";
      step3 = "Run one narrow file-level or package-level verification command (not a broad build).";
      break;
    case "edit_failure_replay":
      step1 = "Re-read the exact target section of the file you tried to edit (use offset/limit to get current content).";
      step2 = "Adjust old_string to match the file's actual content exactly — whitespace, indentation, surrounding lines.";
      step3 = "Apply one corrected Edit call. Do not retry with identical arguments.";
      break;
    case "task_creation_replay":
    case "completion_claim_requires_task_update":
      step1 = "Update existing task items to reflect current status. Do not create duplicate tasks.";
      step2 = "If claiming completion, ensure all task items are marked done first.";
      step3 = "Do not call file discovery tools — focus on task state and completion evidence.";
      break;
    case "dependency_install_replay":
      step1 = "Investigate the specific install error in the output. Do not re-run the same install command.";
      step2 = "If the install succeeded, move on to the next code edit.";
      step3 = "If it failed, fix the root cause (wrong package name, missing lockfile, version conflict) before retrying.";
      break;
    case "declaration_followthrough_required":
      step1 = "Apply one usage-site edit that references the declaration you just added (import, call, wire).";
      step2 = "Do not search for more context — you already have the information needed.";
      step3 = "After the usage edit, run one narrow verification to confirm integration.";
      break;
    case "git_commit_followthrough":
      step1 = "Run git commit with a clear message for the staged changes.";
      step2 = "If changes are not ready to commit, continue editing — do not loop on git status/diff.";
      step3 = "After committing, move on to the next task step.";
      break;
    default: {
      const rules = new Set(decision.matchedRules);
      const testFlow = rules.has("test_entry_contract");
      const explorationLoop = rules.has("bounded_exploration_budget") || rules.has("broad_discovery_repeat");
      step1 = testFlow
        ? "Use Grep first for test files/configs (_test, test_, jest.config, vitest, pytest.ini), then Read at most 3 highest-signal files."
        : "Read README.md or package.json, then use a scoped Glob (e.g. src/*) or Grep. Read at most 3 likely files and stop broad scanning.";
      step2 = explorationLoop
        ? "Do not call Glob(\"*\") or empty glob patterns. If glob is required, use scoped patterns such as src/* or pkg/**/*_test.go."
        : "Avoid broad discovery loops; each tool call must refine scope.";
      step3 = "Before any large read, state one concrete hypothesis and one verification command.";
      break;
    }
  }

  return [
    "<SYNESIS_EXECUTION_RECOVERY status=\"rewrite\" version=\"2\">",
    `matched_rules=${decision.matchedRules.join(",")}`,
    `reason=${reason}`,
    "objective=convert broad exploration into bounded hypothesis-driven workflow",
    `step1=${step1}`,
    `step2=${step2}`,
    `step3=${step3}`,
    `next_action=${decision.suggestedNextStep ?? "run one narrow verification step"}`,
    "</SYNESIS_EXECUTION_RECOVERY>",
  ].join("\n");
}
