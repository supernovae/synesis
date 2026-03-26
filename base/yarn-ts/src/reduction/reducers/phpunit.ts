import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class PhpunitReducer implements Reducer {
  readonly family = "phpunit" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");

    let tests = 0;
    let assertions = 0;
    let failures = 0;
    let errors = 0;

    const tail = raw.match(/Tests:\s*(\d+)\s*,\s*Assertions:\s*(\d+)\s*,\s*Failures:\s*(\d+)\s*,\s*Errors:\s*(\d+)/i);
    if (tail) {
      tests = parseInt(tail[1]!, 10);
      assertions = parseInt(tail[2]!, 10);
      failures = parseInt(tail[3]!, 10);
      errors = parseInt(tail[4]!, 10);
    } else {
      const ok = raw.match(/OK\s*\(\s*(\d+)\s+tests?/i);
      if (ok) tests = parseInt(ok[1]!, 10);
    }

    const failedBlocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (/^\d+\)\s+/.test(t) && /::/.test(t)) {
        failedBlocks.push(t.slice(0, 260));
        const msg = lines[i + 1]?.trim();
        if (msg && !/^\d+\)\s+/.test(msg)) {
          failedBlocks.push(`  ${msg.slice(0, 220)}`);
        }
      }
    }

    const looksPhpunit =
      /PHPUnit\s+[\d.]+/i.test(raw) ||
      /FAILURES!/i.test(raw) ||
      /Tests:\s*\d+\s*,\s*Assertions:/i.test(raw) ||
      /^OK\s*\(\s*\d+\s+tests?/im.test(raw);

    if (!looksPhpunit) return null;

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const failTotal = failures + errors;
    const parts: string[] = [
      `<TOOL_REDUCED family="phpunit" tests="${tests}" failures="${failTotal}">`
    ];
    if (assertions > 0) parts.push(`assertions: ${assertions}`);
    if (failures > 0) parts.push(`failures: ${failures}`);
    if (errors > 0) parts.push(`errors: ${errors}`);
    if (failedBlocks.length > 0) {
      parts.push("failed:");
      failedBlocks.slice(0, limit * 2).forEach((b, i) => parts.push(`  ${i + 1}. ${b}`));
      if (failedBlocks.length > limit * 2) parts.push(`  ... ${failedBlocks.length - limit * 2} more`);
    }
    parts.push("</TOOL_REDUCED>");

    return {
      family: this.family,
      confidence: 0.89,
      actionableCount: failTotal,
      summary: parts.join("\n")
    };
  }
}
