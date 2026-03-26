#!/usr/bin/env tsx
/**
 * Scaffold a new reducer family: creates reducer, fixture, live fixture,
 * and prints instructions for wiring into the registry and live harness.
 *
 * Usage:
 *   npx tsx scripts/scaffold-reducer.ts <family-name>
 *
 * Example:
 *   npx tsx scripts/scaffold-reducer.ts docker
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const family = process.argv[2];
if (!family || !/^[a-z][a-z0-9_-]*$/.test(family)) {
  console.error("Usage: scaffold-reducer.ts <family-name>");
  console.error("  family must be lowercase alphanumeric (a-z, 0-9, -, _)");
  process.exit(1);
}

const ROOT = process.cwd();
const REDUCER_DIR = join(ROOT, "src", "reduction", "reducers");
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "reducers");
const LIVE_FIXTURE_DIR = join(ROOT, "tests", "fixtures", "live");

for (const dir of [REDUCER_DIR, FIXTURE_DIR, LIVE_FIXTURE_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const className = family.split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join("") + "Reducer";

// 1. Reducer implementation
const reducerPath = join(REDUCER_DIR, `${family}.ts`);
if (existsSync(reducerPath)) {
  console.log(`SKIP: ${reducerPath} already exists`);
} else {
  writeFileSync(reducerPath, `import type { Reducer, ReducerInput, ReducerOutput } from "../types.js";

export class ${className} implements Reducer {
  readonly family = "${family}" as const;

  reduce(input: ReducerInput): ReducerOutput | null {
    const lines = input.raw.split("\\n").filter((l) => l.trim());
    // TODO: Implement parsing logic for ${family} output
    // Return null if the content doesn't match this family's patterns
    if (lines.length === 0) return null;

    const findings: string[] = [];
    // TODO: Extract structured findings from raw output
    for (const line of lines) {
      findings.push(line.trim());
    }

    if (findings.length === 0) return null;
    const limit = input.context.profile === "ultra" ? 5 : input.context.profile === "aggressive" ? 8 : 12;
    const top = findings.slice(0, limit);
    const truncated = findings.length > limit;

    return {
      family: this.family,
      confidence: 0.8, // TODO: Adjust based on parsing confidence
      actionableCount: findings.length,
      summary: [
        \`<TOOL_REDUCED family="${family}" findings="\${findings.length}">\`,
        ...top.map((f, i) => \`\${i + 1}. \${f}\`),
        ...(truncated ? [\`... and \${findings.length - limit} more\`] : []),
        "</TOOL_REDUCED>"
      ].join("\\n")
    };
  }
}
`);
  console.log(`CREATED: ${reducerPath}`);
}

// 2. Unit test fixture
const fixturePath = join(FIXTURE_DIR, `${family}.txt`);
if (existsSync(fixturePath)) {
  console.log(`SKIP: ${fixturePath} already exists`);
} else {
  writeFileSync(fixturePath, `# TODO: Add representative ${family} output here (small/unit-test size)
# This fixture is used by unit tests and bench-reducers.ts
`);
  console.log(`CREATED: ${fixturePath}`);
}

// 3. Live fixture
const liveFixturePath = join(LIVE_FIXTURE_DIR, `${family}-large.txt`);
if (existsSync(liveFixturePath)) {
  console.log(`SKIP: ${liveFixturePath} already exists`);
} else {
  writeFileSync(liveFixturePath, `# TODO: Add realistic ${family} output here (large/production-like size)
# This fixture is used by the live verification harness.
# Aim for 500+ chars of realistic tool output.
`);
  console.log(`CREATED: ${liveFixturePath}`);
}

console.log(`
=== Wiring instructions ===

1. Update ReducerFamily type in src/reduction/types.ts:
   export type ReducerFamily = "pytest" | "tsc" | ... | "${family}" | "generic";

2. Register in src/reduction/registry.ts:
   import { ${className} } from "./reducers/${family}.js";
   // Add to REDUCERS:
   ${family}: new ${className}(),

3. Update classifier in src/reduction/classifier.ts:
   Add a classification rule for "${family}" before the "generic" fallback.

4. Update byFamily init in src/reduction/tool-result-reducer.ts:
   byFamily: { ..., ${family}: 0, generic: 0 },

5. Add to live-verify.ts buildScenarios():
   { name: "${family}-openai", family: "${family}", toolName: "<tool>",
     toolOutput: loadFixture("${family}"), protocol: "openai",
     expectedDelta: { "family.${family}": 1 } },

6. Add to ab-reducer-compare.ts SCENARIOS:
   { name: "${family}", family: "${family}", toolName: "<tool>",
     fixture: loadFixture("${family}") },

7. Add regression test in tests/reducer-regression.test.ts:
   it("reduces ${family} fixture", () => { ... });

8. Fill in both fixture files with real output.

9. Run: npm test && npm run bench:reducers
`);
