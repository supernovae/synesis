import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolveCapabilityMatrix } from "../src/policy/capability-matrix.js";

type FixtureCase = {
  name: string;
  matrix: Record<string, unknown>;
  input: {
    model_id: string;
    model_path?: string;
    family?: string;
  };
  expected: {
    mode: "enforced" | "shadow";
    global_optimizations_enabled: boolean;
    resolved_capabilities: Record<string, boolean>;
    matched_override_ids: string[];
  };
};

function loadFixtures(): FixtureCase[] {
  const currentFile = fileURLToPath(import.meta.url);
  const fixturePath = path.resolve(
    path.dirname(currentFile),
    "../../../docs/coder/capability-matrix-resolver-fixtures.json",
  );
  const raw = readFileSync(fixturePath, "utf-8");
  const parsed = JSON.parse(raw) as { cases: FixtureCase[] };
  return parsed.cases;
}

describe("capability matrix resolver fixtures", () => {
  const cases = loadFixtures();

  for (const row of cases) {
    it(row.name, () => {
      const actual = resolveCapabilityMatrix(row.matrix as never, row.input);
      expect(actual.mode).toBe(row.expected.mode);
      expect(actual.global_optimizations_enabled).toBe(row.expected.global_optimizations_enabled);
      expect(actual.resolved_capabilities).toEqual(row.expected.resolved_capabilities);
      expect(actual.matched_override_ids).toEqual(row.expected.matched_override_ids);
    });
  }
});
