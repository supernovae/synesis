import type { RecentToolCall } from "../providers/model-adapter.js";
import {
  isDependencySetupCommand,
  isStandardVerificationCommand,
} from "../verification/command-taxonomy.js";

const WRAPPER_SUFFIXES = [
  /\s*2>&1\s*\|\s*cat\s*$/i,
  /\s*2>&1\s*\|\s*tee\s+\S+\s*$/i,
  /\s*\|\s*cat\s*$/i,
  /\s*\|\s*tee\s+\S+\s*$/i,
  /\s*\|\s*head\s+-n?\s*\d+\s*$/i,
  /\s*\|\s*tail\s+-n?\s*\d+\s*$/i,
  /\s*>\s*\S+\s*2>&1\s*;\s*(echo\s+"[^"]*"\s*;\s*)?(cat|head|tail|sed|rg)\b.*$/i,
];

function normalizeCommand(command: string): string {
  let out = command.trim();
  for (const re of WRAPPER_SUFFIXES) {
    out = out.replace(re, "").trim();
  }
  out = out
    .replace(/\s+-count=\d+/g, "")
    .replace(/\s+-run\s+\S+/g, " -run <target>")
    .replace(/\s+-k\s+\S+/g, " -k <target>")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

function extractVerificationFingerprint(call: RecentToolCall): string | null {
  const tool = call.toolName.trim().toLowerCase();
  if (tool === "run_test" || tool === "run_build" || tool === "run_lint") {
    const preset = typeof call.args?.preset === "string" ? call.args.preset.trim() : "";
    const command = typeof call.args?.command === "string" ? normalizeCommand(call.args.command) : "";
    if (preset) return `${tool}:preset=${preset.toLowerCase()}`;
    if (command) return `${tool}:command=${command.toLowerCase()}`;
    return tool;
  }

  const shellLike = tool === "bash"
    || tool === "execute_command"
    || tool === "run_terminal_cmd"
    || tool === "run_shell"
    || tool === "shell";
  if (!shellLike) return null;

  const command = typeof call.args?.command === "string"
    ? normalizeCommand(call.args.command)
    : (typeof call.args?.cmd === "string" ? normalizeCommand(call.args.cmd) : "");
  if (!command || !isStandardVerificationCommand(command)) return null;
  return `shell:${command.toLowerCase()}`;
}

export interface VerificationRerunLoopResult {
  detected: boolean;
  fingerprint: string;
  repeatCount: number;
  guidance: string;
}

export function detectVerificationRerunLoop(
  recentCalls: RecentToolCall[],
  windowSize = 10,
): VerificationRerunLoopResult | null {
  const tail = recentCalls.slice(-windowSize);
  const fingerprints: string[] = [];
  for (const c of tail) {
    const command = typeof c.args?.command === "string"
      ? c.args.command
      : (typeof c.args?.cmd === "string" ? c.args.cmd : "");
    if (command && isDependencySetupCommand(command)) {
      fingerprints.length = 0;
      continue;
    }
    const fp = extractVerificationFingerprint(c);
    if (fp) fingerprints.push(fp);
  }
  if (fingerprints.length < 2) return null;

  const counts = new Map<string, number>();
  for (const fp of fingerprints) counts.set(fp, (counts.get(fp) ?? 0) + 1);

  let bestFp = "";
  let bestCount = 0;
  for (const [fp, count] of counts) {
    if (count > bestCount) {
      bestFp = fp;
      bestCount = count;
    }
  }
  if (!bestFp || bestCount < 2) return null;

  return {
    detected: true,
    fingerprint: bestFp,
    repeatCount: bestCount,
    guidance: [
      "<SYNESIS_VERIFICATION_RERUN_HINT>",
      `Verification rerun loop detected: \`${bestFp}\` repeated ${bestCount} times.`,
      "Do NOT run this verification command again until you either (a) make a code/test edit, or (b) narrow verification scope.",
      "",
      "Next step:",
      "1) Read the failing location or assertion line.",
      "2) Apply exactly one focused fix.",
      "3) Re-run one targeted verification (single file/package/test), not the broad command.",
      "",
      "If the latest verification is already green, stop rerunning and continue implementation/finalize.",
      "</SYNESIS_VERIFICATION_RERUN_HINT>",
    ].join("\n"),
  };
}
