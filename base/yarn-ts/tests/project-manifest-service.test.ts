import { describe, expect, it } from "vitest";
import { ProjectManifestService } from "../src/project/project-manifest-service.js";

describe("ProjectManifestService", () => {
  it("infers languages, tools, and commands from conversation text", () => {
    const svc = new ProjectManifestService();
    const manifest = svc.build([
      { role: "user", content: "Update TypeScript files and run npm test + eslint + tsc --noEmit." },
      { role: "assistant", content: "Will patch src/index.ts and run vitest." }
    ]);
    expect(manifest.languages).toContain("typescript");
    expect(manifest.buildTools).toContain("npm");
    expect(manifest.testCommands.some((c) => c.includes("npm test") || c.includes("vitest"))).toBe(true);
    expect(manifest.lintCommands.some((c) => c.includes("eslint") || c.includes("tsc"))).toBe(true);
  });

  it("renders system block", () => {
    const svc = new ProjectManifestService();
    const block = svc.toSystemBlock(
      svc.build([{ role: "user", content: "python project with pytest and ruff" }])
    );
    expect(block).toContain("<PROJECT_MANIFEST>");
    expect(block).toContain("languages=");
    expect(block).toContain("policy_profile=");
  });
});
