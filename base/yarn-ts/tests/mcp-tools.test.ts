import { describe, it, expect } from "vitest";
import { McpToolRegistry, McpToolNotFoundError } from "../src/mcp/tool-registry.js";
import { classifyProjectTool } from "../src/mcp/handlers/classify-project.js";
import { inspectRepoTool } from "../src/mcp/handlers/inspect-repo.js";
import { scaffoldTool } from "../src/mcp/handlers/scaffold.js";
import { compareManifestTool } from "../src/mcp/handlers/compare-manifest.js";

describe("McpToolRegistry", () => {
  it("registers and lists tools", () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);
    registry.register(inspectRepoTool);

    const catalog = registry.getCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.map((t) => t.name)).toContain("synesis_classify_project");
    expect(catalog.map((t) => t.name)).toContain("synesis_inspect_repo");
  });

  it("calls a registered tool", async () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);

    const result = await registry.call("synesis_classify_project", {
      task: "Create a Go CLI with cobra",
    });
    expect(result).toHaveProperty("classification");
    expect(result).toHaveProperty("complexity");
  });

  it("throws McpToolNotFoundError for unknown tool", async () => {
    const registry = new McpToolRegistry();
    await expect(registry.call("nonexistent", {})).rejects.toThrow(McpToolNotFoundError);
  });

  it("validates input against schema", async () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);

    await expect(
      registry.call("synesis_classify_project", { task: "" })
    ).rejects.toThrow();
  });
});

describe("classifyProjectTool handler", () => {
  it("classifies a Go CLI task", () => {
    const result = classifyProjectTool.handler({
      task: "Build a Go CLI with subcommands and flags",
    });
    expect(result.classification.projectKind).toBe("go_cli");
    expect(result.complexity.complexity).not.toBe("large");
  });

  it("classifies with fileCount", () => {
    const result = classifyProjectTool.handler({
      task: "Add some handlers",
      fileCount: 12,
    });
    expect(result.complexity.complexity).toBe("medium");
  });
});

describe("inspectRepoTool handler", () => {
  it("scans file paths into a manifest", () => {
    const result = inspectRepoTool.handler({
      filePaths: ["go.mod", "cmd/svc/main.go", "internal/http/routes.go"],
    });
    expect(result.languages).toContain("go");
    expect(result.source).toBe("observed");
  });
});

describe("scaffoldTool handler", () => {
  it("returns template for known kind", () => {
    const result = scaffoldTool.handler({ projectKind: "go_cli" });
    expect(result.found).toBe(true);
    expect(result.template).toBeDefined();
    expect(result.template!.kind).toBe("go_cli");
  });

  it("returns not found for unknown kind", () => {
    const result = scaffoldTool.handler({ projectKind: "unknown" });
    expect(result.found).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("substitutes project name in file paths", () => {
    const result = scaffoldTool.handler({ projectKind: "go_cli", projectName: "mytool" });
    expect(result.found).toBe(true);
    const paths = result.template!.manifest.expectedFiles.map((f) => f.path);
    expect(paths).toContain("cmd/mytool/main.go");
    expect(result.template!.manifest.projectName).toBe("mytool");
  });
});

describe("compareManifestTool handler", () => {
  it("compares two manifests with critique", () => {
    const target = {
      detectedKind: "go_cli" as const,
      expectedFiles: [
        { path: "go.mod", required: true, purpose: "Go module" },
        { path: "README.md", required: true, purpose: "Docs" },
      ],
    };
    const observed = {
      detectedKind: "go_cli" as const,
      expectedFiles: [{ path: "go.mod", required: false, purpose: "", status: "present" as const }],
    };

    const result = compareManifestTool.handler({
      target,
      observed,
      includeStructuralCritique: true,
    });
    expect(result.comparison.missingFiles.length).toBeGreaterThan(0);
    expect(result.critique).toBeDefined();
    expect(result.critique!.passed).toBe(false);
  });
});
