/**
 * Sandbox Executor — intercepts OpenAI tool_calls from the model response and
 * forwards them to the synesis-sandbox warm pool POST /execute endpoint.
 *
 * In live mode the worker driver calls executeSandboxToolCall() for each
 * tool_call. The result is formatted as an OpenAI tool-role message and
 * returned to the caller to append before the next completion turn.
 *
 * Language detection maps the bash command to a sandbox language:
 *   go test / go build / go run / go vet / go fmt → "go"
 *   python / pytest / uv run pytest …             → "python"
 *   node / npm / npx / tsx / vitest               → "node"
 *   everything else                               → "bash"
 *
 * The sandbox response shape (from warm_server.py):
 *   { stdout, stderr, exit_code, lint_output?, security_output? }
 */

export interface SandboxConfig {
  url: string;
  secret?: string;
  /** Max ms to wait for a sandbox execution (default 30 000). */
  timeoutMs?: number;
}

export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string;
}

export interface SandboxExecResult {
  toolCallId: string;
  content: string;
  exitCode: number;
  language: string;
}

interface WarmPoolResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  lint_output?: string;
  security_output?: string;
  error?: string;
}

function detectLanguage(command: string): string {
  const cmd = command.trim().toLowerCase();
  if (/\bgo\s+(test|build|run|vet|fmt|generate|install)\b/.test(cmd)) return "go";
  if (/\b(python3?|pytest|uv\s+run|poetry\s+run)\b/.test(cmd)) return "python";
  if (/\b(node|npm|npx|tsx|vitest|jest)\b/.test(cmd)) return "node";
  return "bash";
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractCommand(toolName: string, rawArgs: string): string {
  const args = parseArgs(rawArgs);
  // bash / run_command / shell / execute all carry the command in "command"
  if (typeof args["command"] === "string") return args["command"];
  // run_in_sandbox uses "code"
  if (typeof args["code"] === "string") return args["code"];
  // filePath used by read_file; not a shell command — return empty
  if (typeof args["filePath"] === "string") return "";
  // Fallback: stringify the args
  return JSON.stringify(args);
}

function formatToolResult(
  toolCall: ToolCallRef,
  result: WarmPoolResponse,
  language: string,
): SandboxExecResult {
  const parts: string[] = [];
  if (result.stdout?.trim()) parts.push(result.stdout.trim());
  if (result.stderr?.trim()) parts.push(result.stderr.trim());
  if (result.lint_output?.trim()) parts.push(`[lint] ${result.lint_output.trim()}`);
  if (result.security_output?.trim()) parts.push(`[security] ${result.security_output.trim()}`);
  if (result.error) parts.push(`[error] ${result.error}`);
  const exitCode = result.exit_code ?? (result.error ? 1 : 0);
  if (exitCode !== 0) {
    parts.push(`Process exited with code ${exitCode}`);
  }
  return {
    toolCallId: toolCall.id,
    content: parts.join("\n") || "(no output)",
    exitCode,
    language,
  };
}

/**
 * Execute one tool_call against the sandbox warm pool.
 * Returns a structured result; the caller is responsible for
 * building the OpenAI tool-role message.
 */
export async function executeSandboxToolCall(
  toolCall: ToolCallRef,
  config: SandboxConfig,
): Promise<SandboxExecResult> {
  const command = extractCommand(toolCall.name, toolCall.arguments);

  // Non-shell tools (read_file, search, glob, str_replace, write_file, etc.)
  // are not forwarded to the sandbox — return a placeholder that lets the
  // scenario driver decide how to handle them.
  if (!command) {
    return {
      toolCallId: toolCall.id,
      content: `[sandbox-executor] Tool "${toolCall.name}" is not a shell command. Provide a simulatedToolResult for this tool.`,
      exitCode: 0,
      language: "none",
    };
  }

  const language = detectLanguage(command);
  const timeoutMs = config.timeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(config.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(config.secret ? { Authorization: `Bearer ${config.secret}` } : {}),
      },
      body: JSON.stringify({
        language,
        code: command,
        filename: language === "go" ? "main.go" : language === "python" ? "script.py" : "script.sh",
        trivial: false,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        toolCallId: toolCall.id,
        content: `[sandbox-executor] HTTP ${resp.status}: ${text.slice(0, 200)}`,
        exitCode: 1,
        language,
      };
    }

    const result = (await resp.json()) as WarmPoolResponse;
    return formatToolResult(toolCall, result, language);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      toolCallId: toolCall.id,
      content: `[sandbox-executor] Request failed: ${msg}`,
      exitCode: 1,
      language,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check sandbox reachability. Returns true if /healthz responds 200.
 */
export async function isSandboxReachable(config: SandboxConfig): Promise<boolean> {
  try {
    const healthUrl = config.url.replace(/\/execute$/, "/healthz");
    const resp = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
      headers: config.secret ? { Authorization: `Bearer ${config.secret}` } : {},
    });
    return resp.ok;
  } catch {
    return false;
  }
}
