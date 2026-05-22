/**
 * Detects when a model is retrying the same command with different output
 * capture strategies — a pattern caused by client-side stdout truncation
 * (e.g. Claude Code's BASH_MAX_OUTPUT_LENGTH).
 *
 * The model sees truncated test/build output, can't find the failure details,
 * and retries with `| cat`, `| tee`, `| head -N`, `> /tmp/file; cat`, etc.
 * Each retry is a full LLM round-trip (often 100k+ tokens) to recover ~3k
 * of truncated output. Injecting a one-shot hint after the second retry
 * saves 1-3 additional turns.
 */

import type { RecentToolCall } from "../providers/model-adapter.js";

const OUTPUT_CAPTURE_WRAPPERS = [
  /\s*2>&1\s*\|\s*cat\s*$/,
  /\s*2>&1\s*\|\s*tee\s+\S+\s*$/,
  /\s*\|\s*cat\s*$/,
  /\s*\|\s*tee\s+\S+\s*$/,
  /\s*\|\s*head\s+-\d+\s*$/,
  /\s*\|\s*tail\s+-\d+\s*$/,
  /\s*\|\s*head\s+-n\s*\d+\s*$/,
  /\s*\|\s*tail\s+-n\s*\d+\s*$/,
  /\s*\|\s*sed\s+-n\s+['"][^'"]+['"]\s*$/,
  /\s*\|\s*awk\s+['"][^'"]+['"]\s*$/,
  /\s*\|\s*rg\s+-n\s+['"][^'"]+['"]\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*(echo\s+"[^"]*"\s*;\s*)?cat\s+\S+\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*head\s+-\d+\s+\S+\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*tail\s+-\d+\s+\S+\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*tail\s+-n\s*\d+\s+\S+\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*sed\s+-n\s+['"][^'"]+['"]\s+\S+\s*$/,
  /\s*>\s*\S+\s*2>&1\s*;\s*rg\s+-n\s+['"][^'"]+['"]\s+\S+\s*$/,
  /\s*2>&1\s*\|\s*tee\s+\S+\s*\|\s*tail\s+-\d+\s*$/,
  /\s*2>&1\s*\|\s*tee\s+\S+\s*\|\s*tail\s+-n\s*\d+\s*$/,
  /\s*2>&1\s*$/,
  /\s*-v\s+2>&1\s*$/,
];

function stripCaptureWrapper(cmd: string): string {
  let stripped = cmd.trim();
  for (const re of OUTPUT_CAPTURE_WRAPPERS) {
    stripped = stripped.replace(re, "");
  }
  return stripped.trim();
}

function extractBaseCommand(cmd: string): string {
  let base = stripCaptureWrapper(cmd);
  base = base.replace(/\s+-v\b/, "");
  base = base.replace(/\s+-count=\d+/g, "");
  base = base.replace(/\s+-timeout=\S+/g, "");
  return base.trim();
}

function isLikelyHighOutputCommand(baseCommand: string): boolean {
  const cmd = baseCommand.toLowerCase();
  return /\b(go test|go build|go vet|npm test|pnpm test|yarn test|pytest|vitest|jest|cargo test|cargo build|mvn|gradle|ruff|eslint|tsc|docker build|podman build|kubectl logs|oc logs|git log|npm install|pnpm install|yarn install)\b/.test(cmd);
}

export interface StdoutCaptureLoopResult {
  detected: boolean;
  baseCommand: string;
  retryCount: number;
  guidance: string;
}

/**
 * Scan recent Bash tool calls for the stdout-capture retry pattern.
 * Returns guidance text when 2+ retries of the same base command are found
 * with different output-capture strategies.
 */
export function detectStdoutCaptureLoop(
  recentCalls: RecentToolCall[],
  windowSize = 8,
): StdoutCaptureLoopResult | null {
  const bashCalls: { raw: string; base: string }[] = [];
  const tail = recentCalls.slice(-windowSize);

  for (const call of tail) {
    const tool = call.toolName.trim().toLowerCase();
    if (tool !== "bash" && tool !== "execute_command") continue;
    const cmd = typeof call.args?.command === "string" ? call.args.command : "";
    if (!cmd.trim()) continue;
    bashCalls.push({ raw: cmd.trim(), base: extractBaseCommand(cmd) });
  }

  if (bashCalls.length < 2) return null;

  const groups = new Map<string, string[]>();
  for (const { raw, base } of bashCalls) {
    const existing = groups.get(base);
    if (existing) {
      existing.push(raw);
    } else {
      groups.set(base, [raw]);
    }
  }

  for (const [base, variants] of groups) {
    if (variants.length < 2) continue;
    const uniqueVariants = new Set(variants);
    if (uniqueVariants.size < 2) continue;

    const likelyHighOutput = isLikelyHighOutputCommand(base);
    const commandHint = likelyHighOutput
      ? `For this command family, always capture once to a stable file and inspect slices from that file.`
      : `Capture once to a stable file and inspect slices from that file instead of re-running.`;
    return {
      detected: true,
      baseCommand: base,
      retryCount: variants.length,
      guidance: [
        `<SYNESIS_OUTPUT_CAPTURE_HINT>`,
        `The command \`${base}\` has been run ${variants.length} times with different output-capture strategies.`,
        `The client is truncating stdout — retrying the same command with | cat, | tee, or | head will not recover the missing output.`,
        ``,
        commandHint,
        ``,
        `Instead, redirect output to a temp file and read the relevant section:`,
        `  ${base} > /tmp/_test_out.txt 2>&1; echo "EXIT:$?"; tail -80 /tmp/_test_out.txt`,
        ``,
        `If you need specific failures, run: rg -n "error|fail|panic|exception|traceback" /tmp/_test_out.txt`,
        `If you need the full output, use the Read/cat tool on /tmp/_test_out.txt afterward.`,
        `Do NOT re-run the command with another pipe variant.`,
        `</SYNESIS_OUTPUT_CAPTURE_HINT>`,
      ].join("\n"),
    };
  }

  return null;
}
