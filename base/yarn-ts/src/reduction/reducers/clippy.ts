import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

const LOC_ARROW = /^-->\s+(.+?):(\d+):(\d+)\s*$/;
const WARNING_INLINE = /^warning:\s*(.+?)\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
const WARNING_START = /^warning:\s*(.+)$/;
const ERROR_START = /^error(?:\[[^\]]+\])?:\s*(.+)$/;
const CLIPPY_LINT = /clippy::([A-Za-z0-9_]+)/;
const WARNINGS_GENERATED = /(\d+)\s+warnings?\s+generated/i;
const CRATE_WARN = /^warning:\s*`[^`]+`/;

export class ClippyReducer implements Reducer {
  readonly family = "clippy" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\n");
    const items: { kind: "W" | "E"; text: string }[] = [];
    let pendingW: string | null = null;
    let pendingE: string | null = null;
    let summaryWarnings: number | null = null;

    const flushPendingAt = (locStr: string) => {
      if (pendingW) {
        items.push({ kind: "W", text: `${locStr} ${pendingW}` });
        pendingW = null;
      }
      if (pendingE) {
        items.push({ kind: "E", text: `${locStr} ${pendingE}` });
        pendingE = null;
      }
    };

    for (const line of lines) {
      const t = line.trim();
      const loc = LOC_ARROW.exec(t);
      if (loc) {
        const locStr = `${loc[1]}:${loc[2]}:${loc[3]}`;
        flushPendingAt(locStr);
        continue;
      }
      const wg = WARNINGS_GENERATED.exec(t);
      if (wg) summaryWarnings = parseInt(wg[1], 10);

      const win = WARNING_INLINE.exec(t);
      if (win) {
        pendingW = null;
        pendingE = null;
        const lint = CLIPPY_LINT.exec(t);
        const detail = lint ? `${win[1]} [${lint[0]}]` : win[1];
        items.push({ kind: "W", text: `${win[2]}:${win[3]}:${win[4]} ${detail}` });
        continue;
      }
      const w = WARNING_START.exec(t);
      if (
        w &&
        !CRATE_WARN.test(t) &&
        !WARNINGS_GENERATED.test(t) &&
        !t.includes("warnings generated")
      ) {
        pendingE = null;
        const lint = CLIPPY_LINT.exec(t);
        pendingW = lint ? `${w[1]} [${lint[0]}]` : w[1];
        continue;
      }
      const e = ERROR_START.exec(t);
      if (e && !t.includes("could not compile") && !t.includes("aborting due to")) {
        pendingW = null;
        pendingE = e[1];
      }
    }

    const hasClippy = CLIPPY_LINT.test(input.raw) || /\[warn\(clippy::/i.test(input.raw);
    if (items.length === 0 && summaryWarnings === null && !hasClippy) return null;

    const errors = items.filter((x) => x.kind === "E").length;
    let warnings = items.filter((x) => x.kind === "W").length;
    if (summaryWarnings !== null) warnings = Math.max(warnings, summaryWarnings);

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [
      `<TOOL_REDUCED family="clippy" warnings="${warnings}" errors="${errors}">`
    ];
    if (summaryWarnings !== null) parts.push(`rustc summary: ${summaryWarnings} warnings generated`);
    items
      .slice(0, limit)
      .forEach((it, i) => parts.push(`  ${i + 1}. ${it.kind} ${it.text}`));
    if (items.length > limit) parts.push(`  ... ${items.length - limit} more`);
    parts.push("</TOOL_REDUCED>");
    return {
      family: this.family,
      confidence: 0.89,
      actionableCount: items.length,
      summary: parts.join("\n")
    };
  }
}
