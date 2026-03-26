import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class DotnetReducer implements Reducer {
  readonly family = "dotnet" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const raw = input.raw;
    const lines = raw.split("\n");

    let buildOk: boolean | null = null;
    if (/Build succeeded/i.test(raw)) buildOk = true;
    if (/Build FAILED/i.test(raw)) buildOk = false;

    const errLines: string[] = [];
    const warnLines: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (/\berror\s+CS\d{4}\b/i.test(t) || /:\s*error\s+CS\d{4}\b/i.test(t)) {
        errLines.push(t.slice(0, 280));
      } else if (/\bwarning\s+CS\d{4}\b/i.test(t) || /:\s*warning\s+CS\d{4}\b/i.test(t)) {
        warnLines.push(t.slice(0, 280));
      }
    }

    const summaryErrors = raw.match(/(\d+)\s+Error\(s\)/i);
    const summaryWarnings = raw.match(/(\d+)\s+Warning\(s\)/i);
    const errorN = summaryErrors ? parseInt(summaryErrors[1]!, 10) : errLines.length;
    const warningN = summaryWarnings ? parseInt(summaryWarnings[1]!, 10) : warnLines.length;

    let totalTests = 0;
    let failedTests = 0;
    const totalM = raw.match(/\bTotal:\s*(\d+)/i);
    if (totalM) {
      totalTests = parseInt(totalM[1]!, 10);
    }
    const totalTestsAlt = raw.match(/Total tests:\s*(\d+)/i);
    if (totalTests === 0 && totalTestsAlt) {
      totalTests = parseInt(totalTestsAlt[1]!, 10);
    }
    const failedM = raw.match(/\bFailed:\s*(\d+)/i);
    const passedM = raw.match(/\bPassed:\s*(\d+)/i);
    const skippedM = raw.match(/\bSkipped:\s*(\d+)/i);
    if (failedM) failedTests = parseInt(failedM[1]!, 10);
    if (totalTests === 0 && (passedM || failedM || skippedM)) {
      const p = passedM ? parseInt(passedM[1]!, 10) : 0;
      const f = failedM ? parseInt(failedM[1]!, 10) : 0;
      const sk = skippedM ? parseInt(skippedM[1]!, 10) : 0;
      totalTests = p + f + sk;
    }

    const looksDotnet =
      buildOk !== null ||
      /error\s+CS\d{4}/i.test(raw) ||
      /warning\s+CS\d{4}/i.test(raw) ||
      /Total tests:/i.test(raw) ||
      /\bPassed:\s*\d+/i.test(raw) ||
      /\bFailed:\s*\d+/i.test(raw) ||
      /Microsoft\s*\(R\)\s*Build Engine/i.test(raw) ||
      /Determining projects to restore/i.test(raw);

    if (!looksDotnet) return null;

    const limit = input.context.profile === "ultra" ? 6 : 12;
    const parts: string[] = [
      `<TOOL_REDUCED family="dotnet" errors="${errorN}" warnings="${warningN}" tests="${totalTests}">`
    ];
    if (buildOk === true) parts.push("build: succeeded");
    if (buildOk === false) parts.push("build: FAILED");
    if (failedTests > 0) parts.push(`tests failed: ${failedTests}`);
    if (errLines.length > 0) {
      parts.push("errors:");
      errLines.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
      if (errLines.length > limit) parts.push(`  ... ${errLines.length - limit} more`);
    }
    if (warnLines.length > 0) {
      parts.push("warnings:");
      warnLines.slice(0, limit).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
      if (warnLines.length > limit) parts.push(`  ... ${warnLines.length - limit} more`);
    }
    parts.push("</TOOL_REDUCED>");

    return {
      family: this.family,
      confidence: 0.87,
      actionableCount: errorN + failedTests,
      summary: parts.join("\n")
    };
  }
}
