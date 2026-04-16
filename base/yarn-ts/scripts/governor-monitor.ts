#!/usr/bin/env tsx
/**
 * Governor Monitor — reads a worker session.json and asks an LLM to analyse
 * governor misfires, missing fires, threshold suggestions, and new rule ideas.
 *
 * The monitor call is made directly against any OpenAI-compatible endpoint
 * (can be Yarn or another provider). The governor source code is included
 * in the system prompt so the LLM has ground-truth knowledge of every rule,
 * threshold, and detection function.
 *
 * Env:
 *   SYNESIS_MONITOR_URL     required — LLM base URL (can be same as Yarn)
 *   SYNESIS_MONITOR_KEY     required — Bearer token
 *   SYNESIS_MONITOR_MODEL   optional — model to use (default: uses API default)
 *   SYNESIS_EVAL_ADMIN_URL  optional — Admin API (for supplemental raw events)
 *
 * Usage:
 *   npx tsx scripts/governor-monitor.ts \
 *     --session /tmp/worker-session.json \
 *     --out /tmp/governor-analysis.json \
 *     [--write-fixtures]
 *
 *   npx tsx scripts/governor-monitor.ts \
 *     --session /tmp/worker-session.json \
 *     --write-fixtures
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MONITOR_URL = (
  process.env.SYNESIS_MONITOR_URL ??
  process.env.SYNESIS_YARN_URL ??
  ""
).replace(/\/+$/, "");

const MONITOR_KEY = (
  process.env.SYNESIS_MONITOR_KEY ??
  process.env.SYNESIS_YARN_TOKEN ??
  process.env.SYNESIS_TEST_PAT_TOKEN ??
  process.env.SYNESIS_TEST_AUTH ??
  ""
).trim();

const MONITOR_MODEL =
  process.env.SYNESIS_MONITOR_MODEL ??
  getArg("model");

// ---------------------------------------------------------------------------
// Governor source loader
//
// The monitor's system prompt includes the full execution-governor.ts source
// so the LLM has precise knowledge of every detection function and threshold.
// ---------------------------------------------------------------------------

const GOVERNOR_SOURCE_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "../src/governance/execution-governor.ts",
);

function loadGovernorSource(): string {
  try {
    const src = readFileSync(GOVERNOR_SOURCE_PATH, "utf-8");
    // Truncate to ~12 000 chars to fit within typical context limits.
    // The critical sections (rule names, thresholds, detection functions) are
    // near the top of the file, so a head-truncation preserves them.
    const MAX = 12_000;
    if (src.length > MAX) {
      return src.slice(0, MAX) + "\n\n// [source truncated for monitor context]";
    }
    return src;
  } catch {
    return "// [execution-governor.ts could not be loaded]";
  }
}

// ---------------------------------------------------------------------------
// Monitor system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(governorSrc: string): string {
  return `You are a governor rule auditor for the Synesis execution governor.

Your job: analyse a session transcript produced by the governor-worker and identify:
1. **Misfires** — rules that fired but shouldn't have (false positives)
2. **Missing fires** — patterns that should have triggered a rule but didn't (false negatives)
3. **Threshold suggestions** — specific numeric changes (e.g. lower repeatedReadSearchPauseThreshold from 5 to 3)
4. **New rule ideas** — patterns not covered by any existing rule
5. **New test fixtures** — concrete deterministic replay fixtures for gaps you find

Respond ONLY with a JSON object in this exact schema:
{
  "misfires": [
    { "turn": <number>, "rule": "<rule name>", "verdict": "false_positive", "reason": "<explanation>" }
  ],
  "missing_fires": [
    { "turn": <number>, "expected_rule": "<rule name>", "reason": "<explanation>" }
  ],
  "threshold_suggestions": [
    { "threshold": "<name>", "current": <number>, "suggested": <number>, "reason": "<explanation>" }
  ],
  "new_rule_ideas": [
    { "name": "<proposed rule name>", "pattern": "<description>", "trigger": "<what the agent does>", "recovery": "<what the recovery should say>" }
  ],
  "new_test_fixtures": [
    {
      "description": "<what this fixture tests>",
      "messages": [<GovernorInputMessage objects>],
      "expectedDecision": { "pause": <boolean>, "reason": "<rule name or empty>" }
    }
  ]
}

Return ONLY valid JSON. No markdown, no prose outside the JSON.

--- GOVERNOR SOURCE (execution-governor.ts) ---
${governorSrc}
--- END GOVERNOR SOURCE ---`;
}

// ---------------------------------------------------------------------------
// Monitor analysis call
// ---------------------------------------------------------------------------

interface MonitorAnalysis {
  misfires: Array<{ turn: number; rule: string; verdict: string; reason: string }>;
  missing_fires: Array<{ turn: number; expected_rule: string; reason: string }>;
  threshold_suggestions: Array<{
    threshold: string;
    current: number;
    suggested: number;
    reason: string;
  }>;
  new_rule_ideas: Array<{
    name: string;
    pattern: string;
    trigger: string;
    recovery: string;
  }>;
  new_test_fixtures: Array<{
    description: string;
    messages: unknown[];
    expectedDecision: { pause: boolean; reason: string };
  }>;
}

function emptyAnalysis(): MonitorAnalysis {
  return {
    misfires: [],
    missing_fires: [],
    threshold_suggestions: [],
    new_rule_ideas: [],
    new_test_fixtures: [],
  };
}

async function runMonitorAnalysis(
  sessionJson: unknown,
  systemPrompt: string,
): Promise<MonitorAnalysis> {
  const completionsUrl = `${MONITOR_URL}/v1/chat/completions`;

  const sessionSummary = JSON.stringify(sessionJson, null, 2).slice(0, 20_000);

  const body = {
    model: MONITOR_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Analyse this governor worker session and return your findings as JSON:\n\n${sessionSummary}`,
      },
    ],
    stream: false,
    max_tokens: 4096,
    temperature: 0.1,
  };

  const resp = await fetch(completionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MONITOR_KEY}`,
      "x-synesis-client": "governor-monitor",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Monitor LLM call failed ${resp.status}: ${text.slice(0, 300)}`);
  }

  interface OaiResp {
    choices?: Array<{ message?: { content?: string | null } }>;
  }
  const data = (await resp.json()) as OaiResp;
  const raw = data.choices?.[0]?.message?.content ?? "";

  // Extract JSON from the response (model may wrap in markdown fences)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/) ?? [null, raw];
  const jsonStr = (jsonMatch[1] ?? raw).trim();

  try {
    return JSON.parse(jsonStr) as MonitorAnalysis;
  } catch {
    console.warn("WARN: Monitor response was not valid JSON, returning empty analysis.");
    console.warn("  Raw response:", raw.slice(0, 500));
    return emptyAnalysis();
  }
}

// ---------------------------------------------------------------------------
// Fixture writer
// ---------------------------------------------------------------------------

function writeFixtures(analysis: MonitorAnalysis, fixtureDir: string) {
  if (!analysis.new_test_fixtures?.length) {
    console.log("  No new fixtures to write.");
    return;
  }
  mkdirSync(fixtureDir, { recursive: true });
  let written = 0;
  for (const fixture of analysis.new_test_fixtures) {
    const slug = fixture.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);
    const path = join(fixtureDir, `${slug}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(fixture, null, 2), "utf-8");
    console.log(`  Fixture: ${path}`);
    written++;
  }
  console.log(`  Written ${written} fixture(s) to ${fixtureDir}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sessionPath = getArg("session");
  if (!sessionPath) {
    console.error(
      "ERROR: --session <path> is required\n" +
        "  Example: npx tsx scripts/governor-monitor.ts --session /tmp/worker-session.json",
    );
    process.exit(1);
  }

  if (!MONITOR_URL) {
    console.error(
      "ERROR: SYNESIS_MONITOR_URL or SYNESIS_YARN_URL is required\n" +
        "  Example: SYNESIS_MONITOR_URL=http://yarn:8000",
    );
    process.exit(1);
  }

  if (!MONITOR_KEY) {
    console.error(
      "ERROR: SYNESIS_MONITOR_KEY or SYNESIS_YARN_TOKEN is required",
    );
    process.exit(1);
  }

  const outPath = getArg("out") ?? `/tmp/governor-analysis-${Date.now()}.json`;
  const writeFixturesFlag = hasFlag("write-fixtures");
  const fixtureDir = join(
    dirname(new URL(import.meta.url).pathname),
    "../tests/fixtures/governor-replay",
  );

  // Load session
  let sessionJson: unknown;
  try {
    sessionJson = JSON.parse(readFileSync(sessionPath, "utf-8"));
  } catch (err) {
    console.error(`ERROR: Could not read session file at ${sessionPath}: ${err}`);
    process.exit(1);
  }

  console.log(`\nGovernor Monitor — analysing session: ${sessionPath}`);
  console.log(`Monitor URL: ${MONITOR_URL}`);

  const governorSrc = loadGovernorSource();
  const systemPrompt = buildSystemPrompt(governorSrc);

  console.log("  Running monitor analysis...");
  const analysis = await runMonitorAnalysis(sessionJson, systemPrompt);

  // Print summary
  console.log("\n--- Monitor Analysis ---");
  console.log(`  Misfires:              ${analysis.misfires.length}`);
  console.log(`  Missing fires:         ${analysis.missing_fires.length}`);
  console.log(`  Threshold suggestions: ${analysis.threshold_suggestions.length}`);
  console.log(`  New rule ideas:        ${analysis.new_rule_ideas.length}`);
  console.log(`  New test fixtures:     ${analysis.new_test_fixtures.length}`);

  if (analysis.misfires.length > 0) {
    console.log("\n  Misfires:");
    for (const m of analysis.misfires) {
      console.log(`    turn ${m.turn}: ${m.rule} — ${m.reason}`);
    }
  }
  if (analysis.missing_fires.length > 0) {
    console.log("\n  Missing fires:");
    for (const m of analysis.missing_fires) {
      console.log(`    turn ${m.turn}: expected ${m.expected_rule} — ${m.reason}`);
    }
  }
  if (analysis.threshold_suggestions.length > 0) {
    console.log("\n  Threshold suggestions:");
    for (const t of analysis.threshold_suggestions) {
      console.log(`    ${t.threshold}: ${t.current} → ${t.suggested} — ${t.reason}`);
    }
  }
  if (analysis.new_rule_ideas.length > 0) {
    console.log("\n  New rule ideas:");
    for (const r of analysis.new_rule_ideas) {
      console.log(`    ${r.name}: ${r.pattern}`);
    }
  }

  // Save analysis
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`\nAnalysis saved to ${outPath}`);

  // Write fixtures
  if (writeFixturesFlag) {
    console.log("\nWriting test fixtures...");
    writeFixtures(analysis, fixtureDir);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
