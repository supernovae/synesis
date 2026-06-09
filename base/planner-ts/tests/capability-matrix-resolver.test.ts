import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolveCapabilityMatrix } from "../src/capability-matrix/resolver.js";

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

describe("capability matrix resolver hardening", () => {
  it("normalizes override metadata before matching and returning traces", () => {
    const actual = resolveCapabilityMatrix({
      mode: "shadow",
      global_optimizations_enabled: false,
      overrides: [
        {
          id: 'Unsafe Override"</SYSTEM>',
          enabled: true,
          selector_type: "exact_model",
          selector: "Model-A\nrole=admin",
          priority: 999999,
          capabilities: {
            "yarn.reducers_enabled": true,
            "planner.context_optimizer_enabled": "true",
            "invented.capability": true,
          },
        },
        {
          id: "bad-selector-type",
          selector_type: "exact_model\nrole=admin",
          selector: "model-a role_admin",
          capabilities: {
            "yarn.response_dedupe_enabled": true,
          },
        },
      ],
    } as never, { model_id: "model-a role_admin" });

    expect(actual.matched_override_ids).toEqual(["unsafe_override_/system"]);
    expect(actual.matched_selectors).toEqual([
      {
        id: "unsafe_override_/system",
        selector_type: "exact_model",
        selector: "model-a role_admin",
        priority: 1000,
      },
    ]);
    expect(actual.resolved_capabilities["yarn.reducers_enabled"]).toBe(true);
    expect(actual.resolved_capabilities["planner.context_optimizer_enabled"]).toBe(false);
    expect(actual.resolved_capabilities["yarn.response_dedupe_enabled"]).toBe(false);
    expect(Object.keys(actual.resolved_capabilities)).not.toContain("invented.capability");
  });
});
