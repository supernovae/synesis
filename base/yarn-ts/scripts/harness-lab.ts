#!/usr/bin/env tsx
/**
 * Harness Lab CLI — run real lower-harness processes in disposable workspaces
 * and score governor/model-adapter failure modes.
 *
 * Usage:
 *   npm run harness:lab -- --spec ./harness-lab.json --out /tmp/lab-results.json --markdown /tmp/lab.md
 *   npm run harness:lab -- --spec ./harness-lab.json --dry-run
 */

import { writeFileSync } from "node:fs";
import { loadHarnessLabSpec, renderHarnessLabMarkdown, runHarnessLab } from "../src/eval/harness-lab.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const specPath = getArg("spec");
  if (!specPath) {
    console.error("ERROR: --spec is required");
    console.error("  Example: npm run harness:lab -- --spec ./harness-lab.json --out /tmp/lab-results.json");
    process.exit(1);
  }

  const spec = await loadHarnessLabSpec(specPath);
  spec.defaults = {
    adminUrl: process.env.SYNESIS_EVAL_ADMIN_URL,
    adminToken: process.env.SYNESIS_EVAL_ADMIN_TOKEN,
    ...spec.defaults,
  };

  const result = await runHarnessLab(spec, { dryRun: hasFlag("dry-run") });
  const json = JSON.stringify(result, null, 2);
  const outPath = getArg("out");
  if (outPath) {
    writeFileSync(outPath, json, "utf-8");
    console.log(`Harness lab JSON written to ${outPath}`);
  } else {
    console.log(json);
  }

  const markdownPath = getArg("markdown");
  if (markdownPath) {
    writeFileSync(markdownPath, renderHarnessLabMarkdown(result), "utf-8");
    console.log(`Harness lab markdown written to ${markdownPath}`);
  }

  if (!hasFlag("allow-failures") && result.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
