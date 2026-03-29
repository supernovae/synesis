import { describe, it, expect } from "vitest";
import { scanForManifest } from "../src/manifest/repo-scanner.js";

describe("scanForManifest", () => {
  it("detects Go CLI from file paths", () => {
    const manifest = scanForManifest({
      filePaths: ["go.mod", "cmd/acmectl/main.go", "internal/cli/root.go", "README.md"],
    });
    expect(manifest.languages).toContain("go");
    expect(manifest.source).toBe("observed");
    expect(manifest.expectedFiles.length).toBe(4);
  });

  it("detects Go HTTP service from directory structure", () => {
    const manifest = scanForManifest({
      filePaths: [
        "go.mod",
        "cmd/svc/main.go",
        "internal/server/server.go",
        "internal/http/routes.go",
      ],
    });
    expect(manifest.detectedKind).toBe("go_http_service");
  });

  it("detects Terraform from .tf files", () => {
    const manifest = scanForManifest({
      filePaths: ["main.tf", "variables.tf", "outputs.tf", "providers.tf"],
    });
    expect(manifest.detectedKind).toBe("terraform_iac");
    expect(manifest.languages).toContain("hcl");
  });

  it("detects frameworks from conversation text", () => {
    const manifest = scanForManifest({
      filePaths: ["go.mod"],
      conversationText: "We're using cobra for the CLI framework",
    });
    expect(manifest.frameworks).toContain("cobra");
  });

  it("detects tools from conversation text", () => {
    const manifest = scanForManifest({
      filePaths: [],
      conversationText: "Run pytest and ruff check before committing",
    });
    expect(manifest.recommendedTools.map((t) => t.name)).toContain("pytest");
    expect(manifest.recommendedTools.map((t) => t.name)).toContain("ruff");
  });

  it("extracts directories from file paths", () => {
    const manifest = scanForManifest({
      filePaths: ["cmd/svc/main.go", "internal/http/handler.go"],
    });
    const dirPaths = manifest.expectedDirectories.map((d) => d.path);
    expect(dirPaths).toContain("cmd/");
    expect(dirPaths).toContain("internal/");
  });

  it("handles empty input gracefully", () => {
    const manifest = scanForManifest({ filePaths: [] });
    expect(manifest.detectedKind).toBe("unknown");
    expect(manifest.confidence).toBe(0);
  });
});
