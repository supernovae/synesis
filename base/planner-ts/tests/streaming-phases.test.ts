import { describe, expect, it } from "vitest";
import { chunkContent, describePhase } from "../src/streaming/phases.js";

describe("streaming phase helpers", () => {
  it("maps known nodes to readable phase descriptions", () => {
    expect(describePhase("router")).toContain("evidence");
    expect(describePhase("unknown-node")).toBe("Processing request");
  });

  it("chunks long content into bounded segments", () => {
    const text = "a".repeat(2100);
    const chunks = chunkContent(text, 900);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });
});
