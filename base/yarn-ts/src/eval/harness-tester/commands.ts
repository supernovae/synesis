import { spawn } from "node:child_process";
import type { HarnessTesterCommandResult, HarnessTesterCommandSpec } from "./types.js";

const MAX_CAPTURED_OUTPUT_CHARS = 200_000;

export async function runHarnessTesterCommand(spec: HarnessTesterCommandSpec): Promise<HarnessTesterCommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, spec.timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: spec.command,
        cwd: spec.cwd,
        exitCode: null,
        timedOut,
        stdout,
        stderr: appendBounded(stderr, error.message),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: spec.command,
        cwd: spec.cwd,
        exitCode,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function buildCommandResult(params: Partial<HarnessTesterCommandResult> & {
  command: string;
  cwd: string;
}): HarnessTesterCommandResult {
  return {
    command: params.command,
    cwd: params.cwd,
    exitCode: params.exitCode ?? 0,
    timedOut: params.timedOut ?? false,
    stdout: params.stdout ?? "",
    stderr: params.stderr ?? "",
    durationMs: params.durationMs ?? 0,
  };
}

function appendBounded(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}
