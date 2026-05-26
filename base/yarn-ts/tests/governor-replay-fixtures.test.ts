import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateExecutionGovernor,
  type ExecutionGovernorOptions,
  type GovernorInputMessage,
  type SessionPhase,
} from "../src/governance/execution-governor.js";

interface GovernorReplayFixture {
  name: string;
  description?: string;
  tags?: string[];
  source?: "manual" | "trace" | "model_draft";
  profile?: "strict_control" | "balanced_completion" | "safety_strict";
  options?: ExecutionGovernorOptions;
  messages: GovernorInputMessage[];
  expected: {
    pause: boolean;
    reason?: string;
    phase?: SessionPhase;
    matchedRulesIncludes?: string[];
    matchedRulesExcludes?: string[];
    forbiddenRules?: string[];
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
      const decision = evaluateExecutionGovernor(fx.messages, fx.options ?? fx.profile ?? "balanced_completion");
      expect(decision.pause).toBe(fx.expected.pause);
      if (fx.expected.reason) {
        expect(decision.reason).toBe(fx.expected.reason);
      }
      if (fx.expected.phase) {
        expect(decision.telemetry.phase).toBe(fx.expected.phase);
      }
      for (const rule of fx.expected.matchedRulesIncludes ?? []) {
        expect(decision.matchedRules).toContain(rule);
      }
      for (const rule of fx.expected.matchedRulesExcludes ?? []) {
        expect(decision.matchedRules).not.toContain(rule);
      }
      for (const rule of fx.expected.forbiddenRules ?? []) {
        expect(decision.matchedRules, `${fx.name}:${rule}`).not.toContain(rule);
      }
    });
  }
});
