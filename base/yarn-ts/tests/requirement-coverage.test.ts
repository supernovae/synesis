import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildChecklistFromPrompt,
  evaluateRequirementCoverage,
} from "../src/validation/requirement-coverage.js";

describe("requirement coverage", () => {
  const prompt = readFileSync(
    join(import.meta.dirname, "fixtures", "rosa-root-prompt.txt"),
    "utf8",
  );

  it("extracts generic requirement clauses from complex prompt", () => {
    const checklist = buildChecklistFromPrompt(prompt, "abc123");
    expect(checklist.must.length).toBeGreaterThan(0);
    const mustTitles = checklist.must.map((m) => m.title.toLowerCase()).join("\n");
    expect(mustTitles).toContain("aws apis");
    expect(checklist.must.concat(checklist.should).map((m) => m.title.toLowerCase()).join("\n")).toContain("json/yaml");
    expect(checklist.must.concat(checklist.should).map((m) => m.title.toLowerCase()).join("\n")).toContain("resume");
  });

  it("flags missing must-have requirements for simplified output", () => {
    const checklist = buildChecklistFromPrompt(prompt, "abc123");
    const report = evaluateRequirementCoverage(
      checklist,
      "Implemented local hourly/monthly/annual calculations with JSON and markdown output.",
    );
    const missingTitles = report.missingMust.map((m) => m.title.toLowerCase()).join("\n");
    expect(missingTitles).toContain("aws apis");
  });

  it("passes when evidence includes major requested capability coverage", () => {
    const checklist = buildChecklistFromPrompt(prompt, "abc123");
    const report = evaluateRequirementCoverage(
      checklist,
      [
        "Uses aws-sdk-go-v2 Pricing API GetProducts for live pricing.",
        "Supports hourly monthly annual and 1-year 3-year commitments.",
        "Exports JSON and YAML and includes markdown report.",
        "Can resume from input-file JSON and add machine pools.",
      ].join("\n"),
    );
    expect(report.missingMust.length).toBeLessThan(2);
  });
});
