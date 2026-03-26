import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class EsbuildReducer implements Reducer {
  readonly family = "esbuild" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    const outputFiles: string[] = [];
    let buildTime = "";

    for (const line of lines) {
      const t = line.trim();
      if (/✘\s*\[ERROR\]|^\[ERROR\]|error:\s/i.test(t)) {
        errors.push(t.slice(0, 240));
      } else if (/^\[WARN\]|warning:\s/i.test(t)) {
        warnings.push(t.slice(0, 240));
      } else if (/^\s+[\w./-]+\.(js|mjs|cjs|css|map)\s+[\d.]+\s*(b|kb|mb|bytes?)\b/i.test(t)) {
        outputFiles.push(t.slice(0, 180));
      } else if (/Done in [\d.]+(ms|s)\b/i.test(t)) {
        const m = t.match(/Done in ([\d.]+(?:ms|s))/i);
        if (m) buildTime = m[1]!;
      }
    }

    const fileFromSummary = raw.match(/(\d+)\s+files?\b/i);
    const inferredFiles = fileFromSummary ? parseInt(fileFromSummary[1]!, 10) : outputFiles.length;

    const looksEsbuild =
      /esbuild\b/i.test(raw) ||
      /✘\s*\[ERROR\]/.test(raw) ||
      /^\s+[\w./-]+\.js\s+\d/i.test(raw) ||
      /Done in [\d.]+ms/i.test(raw);

    if (!looksEsbuild && errors.length === 0 && warnings.length === 0 && outputFiles.length === 0) {
      return null;
    }

    const fileN = Math.max(inferredFiles, outputFiles.length);
    const errN = errors.length;
    const limit = input.context.profile === "ultra" ? 4 : 8;
    const parts: string[] = [
      `<TOOL_REDUCED family="esbuild" files="${fileN}" errors="${errN}">`
    ];
    if (buildTime) parts.push(`build: ${buildTime}`);
    if (outputFiles.length > 0) {
      parts.push("output:");
      outputFiles.slice(0, limit).forEach((f) => parts.push(`  ${f}`));
      if (outputFiles.length > limit) parts.push(`  ... ${outputFiles.length - limit} more`);
    }
    if (errors.length > 0) {
      parts.push("errors:");
      errors.slice(0, limit).forEach((e) => parts.push(`  ${e}`));
      if (errors.length > limit) parts.push(`  ... ${errors.length - limit} more`);
    }
    if (warnings.length > 0) {
      parts.push("warnings:");
      warnings.slice(0, limit).forEach((w) => parts.push(`  ${w}`));
      if (warnings.length > limit) parts.push(`  ... ${warnings.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.89,
      actionableCount: errN + warnings.length,
      summary: parts.join("\n")
    };
  }
}
