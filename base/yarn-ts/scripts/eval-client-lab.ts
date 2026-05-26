#!/usr/bin/env tsx
/**
 * Eval Client Lab — run eval-gym scenarios through multiple client profiles
 * to compare OpenCode/Claude Code/Codex/raw OpenAI-compatible semantics.
 */

import { writeFileSync } from "node:fs";
import { ALL_SCENARIOS, getScenarioById, getScenariosByCategory } from "../src/eval/scenarios/index.js";
import type { EvalCategory, EvalRunnerConfig } from "../src/eval/types.js";
import {
  renderEvalClientLabMarkdown,
  resolveEvalClientProfiles,
  runEvalClientLab,
} from "../src/eval/client-lab.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const targetUrl = (process.env.SYNESIS_EVAL_TARGET_URL ?? "").replace(/\/+$/, "");
  const apiKey = (
    process.env.SYNESIS_EVAL_TARGET_KEY ??
    process.env.SYNESIS_TEST_PAT_TOKEN ??
    process.env.SYNESIS_TEST_AUTH ??
    ""
  ).trim();

  if (!targetUrl) {
    console.error("ERROR: SYNESIS_EVAL_TARGET_URL is required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("ERROR: SYNESIS_EVAL_TARGET_KEY or SYNESIS_TEST_PAT_TOKEN is required");
    process.exit(1);
  }

  const scenarioArg = getArg("scenario");
  const categoryArg = getArg("category") as EvalCategory | undefined;
  const scenarios = scenarioArg
    ? [getScenarioById(scenarioArg)].filter((scenario) => scenario !== undefined)
    : categoryArg
      ? getScenariosByCategory(categoryArg)
      : hasFlag("all")
        ? ALL_SCENARIOS
        : [];

  if (scenarios.length === 0) {
    console.error("ERROR: specify --scenario, --category, or --all");
    process.exit(1);
  }

  const profilesArg = getArg("profiles");
  const profiles = resolveEvalClientProfiles(profilesArg?.split(",").map((value) => value.trim()).filter(Boolean));
  const config: EvalRunnerConfig = {
    targetUrl,
    apiKey,
    model: process.env.SYNESIS_EVAL_MODEL ?? getArg("model"),
    adminUrl: process.env.SYNESIS_EVAL_ADMIN_URL ?? targetUrl,
    adminToken: process.env.SYNESIS_EVAL_ADMIN_TOKEN ?? apiKey,
    timeoutMs: Number(process.env.SYNESIS_EVAL_TIMEOUT_MS ?? 120_000),
    conversationIdPrefix: "eval-client-lab",
  };
  const rounds = Number(getArg("rounds") ?? "1");
  const result = await runEvalClientLab({ config, scenarios, profiles, rounds });

  const outPath = getArg("out");
  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf-8");
    console.log(`Eval client lab JSON written to ${outPath}`);
  } else if (hasFlag("json")) {
    console.log(json);
  }

  const markdownPath = getArg("markdown");
  if (markdownPath) {
    writeFileSync(markdownPath, renderEvalClientLabMarkdown(result), "utf-8");
    console.log(`Eval client lab markdown written to ${markdownPath}`);
  }

  if (!outPath && !hasFlag("json")) {
    console.log(renderEvalClientLabMarkdown(result));
  }

  if (!hasFlag("allow-failures") && result.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
