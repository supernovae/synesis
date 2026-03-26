import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class RspecReducer implements Reducer {
  readonly family = "rspec" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");

    const summaryMatch = raw.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending)?/i);
    let examples = summaryMatch ? parseInt(summaryMatch[1]!, 10) : 0;
    let failureCount = summaryMatch ? parseInt(summaryMatch[2]!, 10) : 0;
    const pending = summaryMatch && summaryMatch[3] ? parseInt(summaryMatch[3]!, 10) : 0;

    const failedExamples: string[] = [];
    const errorMsgs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (/^rspec\s+\.\//.test(t)) {
        failedExamples.push(t.slice(0, 260));
      } else if (/^Failure\/Error:/i.test(t)) {
        errorMsgs.push(t.slice(0, 260));
        const next = lines[i + 1]?.trim();
        if (next && next.length < 280 && !/^rspec\s/i.test(next) && !/^#\s/.test(next)) {
          errorMsgs.push(next.slice(0, 260));
        }
      }
    }

    const looksRspec =
      summaryMatch !== null ||
      /^rspec\s+\.\//m.test(raw) ||
      /Failure\/Error:/i.test(raw);

    if (!looksRspec) return null;

    if (examples === 0 && failureCount === 0 && summaryMatch === null) {
      if (failedExamples.length === 0 && errorMsgs.length === 0) return null;
      examples = Math.max(failedExamples.length, 1);
      failureCount = failedExamples.length || 1;
    }

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [
      `<TOOL_REDUCED family="rspec" examples="${examples}" failures="${failureCount}">`
    ];
    if (pending > 0) parts.push(`pending: ${pending}`);
    if (failedExamples.length > 0) {
      parts.push("failed examples:");
      failedExamples.slice(0, limit).forEach((f, i) => parts.push(`  ${i + 1}. ${f}`));
      if (failedExamples.length > limit) parts.push(`  ... ${failedExamples.length - limit} more`);
    }
    if (errorMsgs.length > 0) {
      parts.push("errors:");
      errorMsgs.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
      if (errorMsgs.length > limit) parts.push(`  ... ${errorMsgs.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");

    return {
      family: this.family,
      confidence: 0.91,
      actionableCount: failureCount + pending,
      summary: parts.join("\n")
    };
  }
}
