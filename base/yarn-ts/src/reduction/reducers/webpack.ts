import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class WebpackReducer implements Reducer {
  readonly family = "webpack" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");
    const errors: string[] = [];
    const warnings: string[] = [];
    const assets: string[] = [];
    let moduleCount: number | null = null;
    let buildTime = "";

    for (const line of lines) {
      const t = line.trim();
      if (/^ERROR\s+in\s/i.test(t) || /^ERROR\s/.test(t)) {
        errors.push(t.slice(0, 200));
      } else if (/^WARNING\s+in\s/i.test(t) || /^WARNING\s/.test(t)) {
        warnings.push(t.slice(0, 200));
      } else if (
        /^(asset|Entrypoint)/i.test(t) &&
        /\s\d+\.?\d*\s*(?:KiB|MiB|GiB|bytes?)\b/i.test(t)
      ) {
        assets.push(t.slice(0, 160));
      } else if (/(\d+)\s+modules?\b/i.test(t)) {
        const m = t.match(/(\d+)\s+modules?\b/i);
        if (m) moduleCount = parseInt(m[1]!, 10);
      } else if (/compiled\s+with|webpack\s+[\d.]+.*\bin\s+/i.test(t)) {
        const tm = t.match(/\bin\s+([\d.]+\s*(?:ms|s|sec))\b/i);
        if (tm) buildTime = tm[1]!;
        else if (/built\s+in\s+([\d.]+\s*(?:ms|s))/i.test(t)) {
          const b = t.match(/built\s+in\s+([\d.]+\s*(?:ms|s))/i);
          if (b) buildTime = b[1]!;
        }
      }
    }

    const chunkHint = raw.match(/\((\d+)\s+assets?\)/i);
    const chunks = chunkHint ? parseInt(chunkHint[1]!, 10) : assets.length > 0 ? Math.min(assets.length, 99) : 0;

    const looksWebpack =
      /webpack|compiled\s+with|Entrypoint|asset\s+[\w.-]+\.(js|css|mjs)/i.test(raw) ||
      errors.some((e) => /ERROR\s+in/i.test(e)) ||
      warnings.some((w) => /WARNING\s+in/i.test(w));

    if (!looksWebpack && errors.length === 0 && warnings.length === 0 && assets.length === 0 && moduleCount === null) {
      return null;
    }

    const errN = errors.length;
    const warnN = warnings.length;
    const chunkN = Math.max(chunks, assets.length > 0 ? Math.min(assets.length, 50) : 0);

    const limit = input.context.profile === "ultra" ? 4 : 8;
    const parts: string[] = [
      `<TOOL_REDUCED family="webpack" errors="${errN}" warnings="${warnN}" chunks="${chunkN || 0}">`
    ];
    if (moduleCount !== null) parts.push(`modules: ${moduleCount}`);
    if (buildTime) parts.push(`build: ${buildTime}`);
    if (assets.length > 0) {
      parts.push("assets:");
      assets.slice(0, limit).forEach((a) => parts.push(`  ${a}`));
      if (assets.length > limit) parts.push(`  ... ${assets.length - limit} more`);
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
      confidence: 0.91,
      actionableCount: errN + warnN,
      summary: parts.join("\n")
    };
  }
}
