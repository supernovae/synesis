import { describe, it, expect } from "vitest";
import { classifyProject, assessComplexity, classify } from "../src/manifest/classifier.js";

describe("classifyProject", () => {
  it("classifies a Go CLI request", () => {
    const result = classifyProject("Create a Go CLI tool with subcommands and flags");
    expect(result.projectKind).toBe("go_cli");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.signals).toContain("cli");
  });

  it("classifies a Go HTTP service request", () => {
    const result = classifyProject("Build a Go HTTP API server with a health endpoint and middleware");
    expect(result.projectKind).toBe("go_http_service");
    expect(result.signals).toContain("http");
  });

  it("classifies a Terraform request", () => {
    const result = classifyProject("Create a Terraform project for Azure infrastructure with modules");
    expect(result.projectKind).toBe("terraform_iac");
    expect(result.signals).toContain("terraform");
  });

  it("returns unknown for unrecognized input", () => {
    const result = classifyProject("What is the meaning of life?");
    expect(result.projectKind).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("detects language independently of project kind", () => {
    const result = classifyProject("Fix a bug in the main.go file");
    expect(result.language).toBe("go");
  });

  it("prefers higher-weighted signals", () => {
    const result = classifyProject("I need a cobra CLI with subcommands");
    expect(result.projectKind).toBe("go_cli");
    expect(result.signals).toContain("cobra");
    expect(result.signals).toContain("subcommands");
  });
});

describe("assessComplexity", () => {
  it("classifies greetings as tiny", () => {
    const result = assessComplexity("Hello, can you help me?");
    expect(result.complexity).toBe("tiny");
    expect(result.planRequired).toBe(false);
  });

  it("classifies explanations as tiny", () => {
    const result = assessComplexity("Explain how Go interfaces work");
    expect(result.complexity).toBe("tiny");
  });

  it("classifies scaffolding as medium", () => {
    const result = assessComplexity("Scaffold a new project for a REST API");
    expect(result.complexity).toBe("medium");
  });

  it("classifies architecture work as large", () => {
    const result = assessComplexity("Redesign the multi-service platform architecture");
    expect(result.complexity).toBe("large");
    expect(result.planRequired).toBe(true);
  });

  it("considers file count for medium classification", () => {
    const result = assessComplexity("Add a new handler", 8);
    expect(result.complexity).toBe("medium");
  });

  it("defaults to small for generic requests", () => {
    const result = assessComplexity("Fix the login function");
    expect(result.complexity).toBe("small");
    expect(result.planRequired).toBe(false);
  });
});

describe("classify (combined)", () => {
  it("returns both classification and complexity", () => {
    const result = classify("Create a new Go CLI project with subcommands");
    expect(result.classification.projectKind).toBe("go_cli");
    expect(result.complexity.complexity).toBe("medium");
  });
});
