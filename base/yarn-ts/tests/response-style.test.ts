import { describe, expect, it } from "vitest";
import { applyMarkdownGuardrail, buildResponseStyleBlock } from "../src/response-style.js";

describe("buildResponseStyleBlock", () => {
  it("returns null in off mode", () => {
    expect(
      buildResponseStyleBlock({ mode: "off", allowMermaid: true }),
    ).toBeNull();
  });

  it("builds default block in guidance mode", () => {
    const block = buildResponseStyleBlock({
      mode: "guidance",
      allowMermaid: true,
    });
    expect(block).toContain("<RESPONSE_STYLE>");
    expect(block).toContain("fenced code blocks");
    expect(block).toContain("mermaid diagrams");
  });

  it("uses admin override when provided", () => {
    const block = buildResponseStyleBlock({
      mode: "guidance",
      allowMermaid: true,
      adminOverride: "Use short headings only.",
    });
    expect(block).toContain("Use short headings only.");
    expect(block).not.toContain("fenced code blocks");
  });
});

describe("applyMarkdownGuardrail", () => {
  it("is a no-op outside guardrail mode", () => {
    const src = "##Title\ntext";
    expect(applyMarkdownGuardrail(src, "guidance")).toBe(src);
  });

  it("normalizes heading spacing and closes unbalanced fences", () => {
    const src = "##Title\ntext\n```ts\nconst a = 1;";
    const out = applyMarkdownGuardrail(src, "guardrail");
    expect(out).toContain("##Title\ntext");
    const fenceCount = (out.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0);
  });
});

