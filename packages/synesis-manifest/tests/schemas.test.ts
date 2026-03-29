import { describe, it, expect } from "vitest";
import {
  ProjectManifestSchema,
  WorkingFrameSchema,
  ClassificationResultSchema,
  ComplexityAssessmentSchema,
  ManifestComparisonSchema,
  ProjectTemplateSchema,
  getTemplate,
  listTemplateKinds,
  getAllTemplates,
} from "../src/index.js";

describe("ProjectManifestSchema", () => {
  it("parses a minimal manifest with defaults", () => {
    const m = ProjectManifestSchema.parse({});
    expect(m.detectedKind).toBe("unknown");
    expect(m.source).toBe("observed");
    expect(m.languages).toEqual([]);
    expect(m.expectedFiles).toEqual([]);
  });

  it("parses a full go_cli target manifest", () => {
    const m = ProjectManifestSchema.parse({
      projectName: "acmectl",
      detectedKind: "go_cli",
      confidence: 0.95,
      languages: ["go", "markdown"],
      frameworks: ["cobra"],
      summary: "Go CLI tool",
      expectedFiles: [
        { path: "go.mod", required: true, purpose: "Go module" },
      ],
      source: "target",
    });
    expect(m.projectName).toBe("acmectl");
    expect(m.detectedKind).toBe("go_cli");
    expect(m.expectedFiles).toHaveLength(1);
    expect(m.expectedFiles[0].status).toBe("recommended");
  });

  it("rejects invalid project kind", () => {
    expect(() =>
      ProjectManifestSchema.parse({ detectedKind: "java_spring" })
    ).toThrow();
  });

  it("rejects confidence out of range", () => {
    expect(() =>
      ProjectManifestSchema.parse({ confidence: 1.5 })
    ).toThrow();
  });
});

describe("WorkingFrameSchema", () => {
  it("parses a minimal frame with defaults", () => {
    const f = WorkingFrameSchema.parse({});
    expect(f.complexity).toBe("small");
    expect(f.planRequired).toBe(false);
    expect(f.phase).toBe("implement");
    expect(f.taskType).toBe("general");
  });

  it("parses a full scaffold frame", () => {
    const f = WorkingFrameSchema.parse({
      taskId: "task-001",
      userIntent: "Create a Go CLI",
      taskType: "scaffold_project",
      phase: "plan",
      domain: "go",
      subdomain: "cli",
      currentGoal: "Scaffold project",
      complexity: "medium",
      planRequired: true,
      doneCriteria: ["Project builds", "Root command exists"],
      validationFocus: ["go test ./...", "go vet ./..."],
    });
    expect(f.taskId).toBe("task-001");
    expect(f.complexity).toBe("medium");
    expect(f.planRequired).toBe(true);
    expect(f.doneCriteria).toHaveLength(2);
  });
});

describe("ClassificationResultSchema", () => {
  it("parses classification output", () => {
    const c = ClassificationResultSchema.parse({
      language: "go",
      projectKind: "go_cli",
      confidence: 0.91,
      signals: ["user requested CLI tool", "mentions subcommands"],
    });
    expect(c.projectKind).toBe("go_cli");
    expect(c.signals).toHaveLength(2);
  });
});

describe("ComplexityAssessmentSchema", () => {
  it("parses assessment", () => {
    const a = ComplexityAssessmentSchema.parse({
      complexity: "tiny",
      planRequired: false,
      signals: ["single concept"],
    });
    expect(a.complexity).toBe("tiny");
  });
});

describe("ManifestComparisonSchema", () => {
  it("parses an empty comparison", () => {
    const c = ManifestComparisonSchema.parse({
      target: {},
      observed: {},
    });
    expect(c.structuralScore).toBe(0);
    expect(c.missingFiles).toEqual([]);
  });
});

describe("Template registry", () => {
  it("lists known template kinds", () => {
    const kinds = listTemplateKinds();
    expect(kinds).toContain("go_cli");
    expect(kinds).toContain("go_http_service");
    expect(kinds).toContain("terraform_iac");
  });

  it("retrieves a template by kind", () => {
    const t = getTemplate("go_cli");
    expect(t).toBeDefined();
    expect(t!.manifest.detectedKind).toBe("go_cli");
  });

  it("validates all templates against ProjectTemplateSchema", () => {
    for (const t of getAllTemplates()) {
      expect(() => ProjectTemplateSchema.parse(t)).not.toThrow();
    }
  });

  it("returns undefined for unknown kind", () => {
    expect(getTemplate("unknown")).toBeUndefined();
  });
});
