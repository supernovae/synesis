import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateExecutionGovernor, type GovernorInputMessage } from "../src/governance/execution-governor.js";

interface GovernorReplayFixture {
  name: string;
  profile?: "strict_control" | "balanced_completion" | "safety_strict";
  messages: GovernorInputMessage[];
  expected: {
    pause: boolean;
    reason?: string;
    matchedRulesIncludes?: string[];
  };
}

function fixtureDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "fixtures/governor-replay");
}

function loadFixtures(): GovernorReplayFixture[] {
  return readdirSync(fixtureDir())
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const full = path.join(fixtureDir(), name);
      const parsed = JSON.parse(readFileSync(full, "utf8")) as GovernorReplayFixture;
      return parsed;
    });
}

describe("governor replay fixtures", () => {
  const fixtures = loadFixtures();

  it("loads at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`replays ${fx.name}`, () => {
      const decision = evaluateExecutionGovernor(fx.messages, fx.profile ?? "balanced_completion");
      expect(decision.pause).toBe(fx.expected.pause);
      if (fx.expected.reason) {
        expect(decision.reason).toBe(fx.expected.reason);
      }
      for (const rule of fx.expected.matchedRulesIncludes ?? []) {
        expect(decision.matchedRules).toContain(rule);
      }
    });
  }
});
