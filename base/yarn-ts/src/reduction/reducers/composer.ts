import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

function parseOperationsTotal(segment: string): number {
  let total = 0;
  const inst = /(\d+)\s+installs?/i.exec(segment);
  if (inst) total += parseInt(inst[1]!, 10);
  const upd = /(\d+)\s+updates?/i.exec(segment);
  if (upd) total += parseInt(upd[1]!, 10);
  const rem = /(\d+)\s+removals?/i.exec(segment);
  if (rem) total += parseInt(rem[1]!, 10);
  return total;
}

export class ComposerReducer implements Reducer {
  readonly family = "composer" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");

    const looksComposer =
      /^Installing\s+/m.test(raw) ||
      /^Updating\s+/m.test(raw) ||
      /^Upgrading\s+/m.test(raw) ||
      /^Removing\s+/m.test(raw) ||
      /-\s*Installing\s+/im.test(raw) ||
      /-\s*Updating\s+/im.test(raw) ||
      /-\s*Upgrading\s+/im.test(raw) ||
      /-\s*Removing\s+/im.test(raw) ||
      /^Package\s+operations:/m.test(raw) ||
      /Writing lock file/i.test(raw) ||
      /Generating autoload files/i.test(raw) ||
      /Loading composer repositories/i.test(raw) ||
      /Composer (version|plugins)/i.test(raw);

    if (!looksComposer) return null;

    const opLines: string[] = [];
    const metaLines: string[] = [];
    const warnings: string[] = [];

    for (const line of lines) {
      const t = line.trim();
      if (
        /^-?\s*Installing\s+/i.test(t) ||
        /^-?\s*Updating\s+/i.test(t) ||
        /^-?\s*Upgrading\s+/i.test(t) ||
        /^-?\s*Removing\s+/i.test(t)
      ) {
        opLines.push(t.slice(0, 240));
      } else if (/^(Package|Lock file)\s+operations:/i.test(t)) {
        metaLines.push(t.slice(0, 200));
      } else if (
        /abandoned/i.test(t) ||
        /^Warning:/i.test(t) ||
        /does not satisfy/i.test(t) ||
        /security advisory/i.test(t)
      ) {
        warnings.push(t.slice(0, 280));
      }
    }

    if (/Writing lock file/i.test(raw)) metaLines.push("Writing lock file");
    if (/Generating autoload files/i.test(raw)) metaLines.push("Generating autoload files");

    let declaredTotal = 0;
    for (const m of metaLines) {
      if (/operations:/i.test(m)) {
        declaredTotal = Math.max(declaredTotal, parseOperationsTotal(m));
      }
    }

    const packageAttr = Math.max(opLines.length, declaredTotal, metaLines.length > 0 ? 1 : 0);
    const warnN = warnings.length;

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [
      `<TOOL_REDUCED family="composer" packages="${packageAttr}" warnings="${warnN}">`
    ];
    if (metaLines.length > 0) {
      parts.push("meta:");
      metaLines.slice(0, 4).forEach((p, i) => parts.push(`  ${i + 1}. ${p}`));
    }
    if (opLines.length > 0) {
      parts.push("operations:");
      opLines.slice(0, limit).forEach((p, i) => parts.push(`  ${i + 1}. ${p}`));
      if (opLines.length > limit) parts.push(`  ... ${opLines.length - limit} more`);
    }
    if (warnings.length > 0) {
      parts.push("warnings:");
      warnings.slice(0, limit).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
    }
    parts.push("</TOOL_REDUCED>");

    return {
      family: this.family,
      confidence: 0.87,
      actionableCount: warnN,
      summary: parts.join("\n")
    };
  }
}
