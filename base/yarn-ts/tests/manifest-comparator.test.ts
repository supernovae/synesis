import { describe, it, expect } from "vitest";
import { getTemplate, type ProjectManifest } from "@synesis/manifest";
import { compareManifests } from "../src/manifest/comparator.js";
import { critiquStructure } from "../src/manifest/structural-critic.js";

describe("compareManifests", () => {
  const goCliTemplate = getTemplate("go_cli")!;

  it("reports all files missing when observed is empty", () => {
    const observed: ProjectManifest = {
      projectName: "",
      detectedKind: "go_cli",
      confidence: 0,
      languages: ["go"],
      frameworks: [],
      summary: "",
      expectedFiles: [],
      expectedDirectories: [],
      recommendedTools: [],
      documentationPatterns: [],
      codingPatterns: [],
      styleRules: [],
      observedStrengths: [],
      observedGaps: [],
      source: "observed",
    };

    const comparison = compareManifests(goCliTemplate.manifest, observed);
    expect(comparison.missingFiles.length).toBe(goCliTemplate.manifest.expectedFiles.length);
    expect(comparison.structuralScore).toBeLessThan(0.5);
    expect(comparison.gapSummary).toContain("missing");
  });

  it("reports no gaps when observed matches target", () => {
    const comparison = compareManifests(goCliTemplate.manifest, goCliTemplate.manifest);
    expect(comparison.missingFiles.length).toBe(0);
    expect(comparison.missingDirectories.length).toBe(0);
    expect(comparison.structuralScore).toBe(1);
  });

  it("detects extra files in observed", () => {
    const observed: ProjectManifest = {
      ...goCliTemplate.manifest,
      expectedFiles: [
        ...goCliTemplate.manifest.expectedFiles,
        { path: "internal/extra/bonus.go", required: false, purpose: "", status: "present" },
      ],
      source: "observed",
    };

    const comparison = compareManifests(goCliTemplate.manifest, observed);
    expect(comparison.extraFiles.length).toBeGreaterThan(0);
    expect(comparison.strengthSummary).toContain("extra file");
  });

  it("detects missing tools", () => {
    const observed: ProjectManifest = {
      ...goCliTemplate.manifest,
      recommendedTools: [],
      source: "observed",
    };

    const comparison = compareManifests(goCliTemplate.manifest, observed);
    expect(comparison.missingTools.length).toBeGreaterThan(0);
  });
});

describe("critiquStructure", () => {
  const goCliTemplate = getTemplate("go_cli")!;

  it("fails when required files are missing", () => {
    const emptyObserved: ProjectManifest = {
      projectName: "",
      detectedKind: "go_cli",
      confidence: 0,
      languages: [],
      frameworks: [],
      summary: "",
      expectedFiles: [],
      expectedDirectories: [],
      recommendedTools: [],
      documentationPatterns: [],
      codingPatterns: [],
      styleRules: [],
      observedStrengths: [],
      observedGaps: [],
      source: "observed",
    };

    const comparison = compareManifests(goCliTemplate.manifest, emptyObserved);
    const critique = critiquStructure(comparison);
    expect(critique.passed).toBe(false);
    expect(critique.requiredMissing).toBeGreaterThan(0);
    expect(critique.summary).toContain("required");
  });

  it("passes when all required elements present", () => {
    const comparison = compareManifests(goCliTemplate.manifest, goCliTemplate.manifest);
    const critique = critiquStructure(comparison);
    expect(critique.passed).toBe(true);
    expect(critique.requiredMissing).toBe(0);
  });
});
