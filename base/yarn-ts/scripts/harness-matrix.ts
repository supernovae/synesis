#!/usr/bin/env tsx
/**
 * Harness Matrix CLI — coordinates lower-harness validation sweeps through the
 * existing Harness Lab runner and emits comparable JSON/Markdown reports.
 */

import { writeFileSync } from "node:fs";
import {
  loadHarnessMatrixSpec,
  renderHarnessMatrixMarkdown,
  runHarnessMatrix,
} from "../src/eval/harness-matrix.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const matrixPath = getArg("matrix");
  if (!matrixPath) {
    console.error("ERROR: --matrix is required");
    console.error("  Example: npm run harness:matrix -- --matrix ./matrix.json --dry-run");
    process.exit(1);
  }

  const spec = await loadHarnessMatrixSpec(matrixPath);
  const result = await runHarnessMatrix(spec, {
    dryRun: hasFlag("dry-run"),
    artifactsRoot: getArg("artifacts-root") ?? spec.defaults?.artifactsRoot,
  });
  const json = JSON.stringify(result, null, 2);
  const outPath = getArg("out");
  if (outPath) {
    writeFileSync(outPath, `${json}\n`, "utf-8");
    console.log(`Harness matrix JSON written to ${outPath}`);
  } else {
    console.log(json);
  }

  const markdownPath = getArg("markdown");
  if (markdownPath) {
    writeFileSync(markdownPath, renderHarnessMatrixMarkdown(result), "utf-8");
    console.log(`Harness matrix markdown written to ${markdownPath}`);
  }

  if (!hasFlag("allow-failures") && result.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
