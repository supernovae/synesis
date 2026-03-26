import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class PipInstallReducer implements Reducer {
  readonly family = "pip-install" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    let installedCount = 0;
    let alreadySatisfied = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(ERROR|error):/.test(trimmed) || /Could not (find|install)/.test(trimmed)) {
        errors.push(trimmed);
      } else if (/^WARNING:/.test(trimmed) || trimmed.includes("deprecat")) {
        warnings.push(trimmed.replace(/^WARNING:\s*/, ""));
      } else if (/^Successfully installed/.test(trimmed)) {
        const pkgs = trimmed.replace("Successfully installed ", "").split(/\s+/);
        installedCount = pkgs.length;
      } else if (/^Requirement already satisfied/.test(trimmed)) {
        alreadySatisfied++;
      } else if (/^Collecting |^Downloading |^Using cached /.test(trimmed)) {
        installedCount = Math.max(installedCount, 1);
      }
    }

    if (errors.length === 0 && warnings.length === 0 && installedCount === 0 && alreadySatisfied === 0) return null;
    const parts: string[] = [`<TOOL_REDUCED family="pip-install">`];
    if (installedCount > 0) parts.push(`installed ${installedCount} packages`);
    if (alreadySatisfied > 0) parts.push(`${alreadySatisfied} already satisfied`);
    if (errors.length > 0) {
      parts.push(`errors (${errors.length}):`);
      errors.slice(0, 5).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
    }
    if (warnings.length > 0) {
      warnings.slice(0, 3).forEach((w, i) => parts.push(`  warn ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");
    return { family: this.family, confidence: 0.88, actionableCount: errors.length, summary: parts.join("\n") };
  }
}
