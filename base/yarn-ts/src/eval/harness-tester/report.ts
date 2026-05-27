import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessTesterReport } from "./types.js";

export async function writeHarnessTesterReport(params: {
  report: HarnessTesterReport;
  artifactsRoot: string;
}): Promise<string> {
  const runDir = join(params.artifactsRoot, params.report.run_id);
  await mkdir(runDir, { recursive: true });
  const reportPath = join(runDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(params.report, null, 2)}\n`, "utf-8");
  await writeFile(join(runDir, "summary.md"), renderHarnessTesterMarkdown(params.report), "utf-8");
  return reportPath;
}

export async function readHarnessTesterReport(path: string): Promise<HarnessTesterReport> {
  return JSON.parse(await readFile(path, "utf-8")) as HarnessTesterReport;
}

export function renderHarnessTesterSummaryTable(reports: HarnessTesterReport[]): string {
  const lines = ["Task                         Harness   Status   Validation   Flags"];
  for (const report of reports) {
    const validation = report.validation_results.length === 0
      ? "none"
      : report.validation_results.every((result) => result.exitCode === 0 && !result.timedOut)
        ? "passed"
        : "failed";
    const flags = report.behavioral_flags.map((flag) => flag.flag).join(",") || "none";
    lines.push(
      `${pad(report.task_id, 28)} ${pad(report.harness_name, 9)} ${pad(report.status, 8)} ${pad(validation, 12)} ${flags}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderHarnessTesterMarkdown(report: HarnessTesterReport): string {
  const lines = [
    `# Harness Tester Run ${report.run_id}`,
    "",
    `Task: ${report.task_id} (${report.task_name})`,
    `Harness: ${report.harness_name}`,
    `Model: ${report.model}`,
    `Status: ${report.status}`,
    `Duration: ${report.duration_seconds.toFixed(3)}s`,
    "",
    "## Validation",
    "",
  ];
  if (report.validation_results.length === 0) {
    lines.push("- no validation commands configured");
  } else {
    for (const result of report.validation_results) {
      lines.push(`- ${result.exitCode === 0 && !result.timedOut ? "pass" : "fail"}: ${result.command}`);
    }
  }
  lines.push("", "## Changed Files", "");
  if (report.changed_files.length === 0) {
    lines.push("- none");
  } else {
    for (const file of report.changed_files) lines.push(`- ${file}`);
  }
  lines.push("", "## Behavioral Flags", "");
  if (report.behavioral_flags.length === 0) {
    lines.push("- none");
  } else {
    for (const signal of report.behavioral_flags) {
      lines.push(`- ${signal.severity} ${signal.flag} (${signal.owner}): ${signal.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) : value.padEnd(width, " ");
}
