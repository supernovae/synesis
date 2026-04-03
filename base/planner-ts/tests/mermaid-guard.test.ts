import { describe, expect, it } from "vitest";
import {
  enforceMermaidHygiene,
  extractMermaidBlocks,
  normalizeMermaidBlock,
} from "../src/security/mermaid-guard.js";

describe("mermaid guard", () => {
  it("extracts mermaid fenced blocks", () => {
    const text = "before\n```mermaid\ngraph TD\nA-->B\n```\nafter";
    const blocks = extractMermaidBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain("graph TD");
  });

  it("quotes node labels with special characters", () => {
    const normalized = normalizeMermaidBlock([
      "graph TD",
      "A[User Browser/App] --> B[Amazon API Gateway]",
    ].join("\n"));
    expect(normalized).toContain('A["User Browser/App"]');
    expect(normalized).toContain('B["Amazon API Gateway"]');
  });

  it("quotes edge labels with special characters", () => {
    const normalized = normalizeMermaidBlock([
      "graph TD",
      "A -->|O(1) lookup| B",
    ].join("\n"));
    expect(normalized).toContain('A -->|"O(1) lookup"| B');
  });

  it("marks forbidden directives as violations", () => {
    const raw = [
      "prefix",
      "```mermaid",
      "graph TD",
      "A[Start] --> B[End]",
      "classDef bad fill:#fff",
      "```",
    ].join("\n");
    const guarded = enforceMermaidHygiene(raw);
    expect(guarded.violations.some((v) => v.code === "mermaid_forbidden_directive")).toBe(true);
  });
});
