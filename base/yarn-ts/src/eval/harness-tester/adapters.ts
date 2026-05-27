import type { HarnessTesterAdapter, HarnessTesterAdapterInput, HarnessTesterCommandSpec } from "./types.js";

export interface OpenCodeAdapterOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_OPENCODE_ARGS = [
  "run",
  "--model",
  "{model}",
  "--session",
  "{sessionKey}",
  "--prompt-file",
  "{promptFile}",
];

export function createOpenCodeHarnessAdapter(options: OpenCodeAdapterOptions = {}): HarnessTesterAdapter {
  return {
    name: "opencode",
    buildCommand(input: HarnessTesterAdapterInput): HarnessTesterCommandSpec {
      const substitutions = {
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey ?? "",
        model: input.model,
        prompt: input.task.prompt,
        promptFile: input.promptFilePath,
        runId: input.runId,
        sessionKey: input.sessionKey,
        taskId: input.task.id,
        workspace: input.workspacePath,
      };
      const args = (options.args ?? DEFAULT_OPENCODE_ARGS).map((arg) => interpolate(arg, substitutions));
      const env: Record<string, string> = {
        OPENAI_API_KEY: input.apiKey ?? "synesis-harness-tester",
        OPENAI_BASE_URL: input.apiBaseUrl,
        OPENCODE_MODEL: input.model,
        SYNESIS_HARNESS_RUN_ID: input.runId,
        SYNESIS_HARNESS_SESSION_KEY: input.sessionKey,
        SYNESIS_HARNESS_TASK_ID: input.task.id,
        ...input.task.env,
        ...input.env,
      };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        env[key] = interpolate(value, substitutions);
      }
      return {
        command: [options.command ?? "opencode", ...args.map(shellQuote)].join(" "),
        cwd: input.workspacePath,
        env,
        timeoutMs: (input.task.timeout_seconds ?? 300) * 1000,
      };
    },
  };
}

export function createHarnessAdapter(name: string, options: OpenCodeAdapterOptions = {}): HarnessTesterAdapter {
  if (name === "opencode") return createOpenCodeHarnessAdapter(options);
  throw new Error(`Unsupported harness '${name}'. Only opencode is implemented in this vertical slice.`);
}

function interpolate(value: string, substitutions: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => substitutions[key] ?? match);
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
