import { describe, it, expect } from "vitest";
import { createSynesisMcpServer } from "../src/index.js";

describe("createSynesisMcpServer", () => {
  it("throws when url is empty", () => {
    expect(() => createSynesisMcpServer({ url: "", pat: "syn-test" })).toThrow("url is required");
  });

  it("throws when pat is empty", () => {
    expect(() => createSynesisMcpServer({ url: "https://example.com", pat: "" })).toThrow("pat is required");
  });

  it("throws for an invalid URL", () => {
    expect(() => createSynesisMcpServer({ url: "not-a-url", pat: "syn-test" })).toThrow("Invalid URL");
  });

  it("creates a server with valid config", () => {
    const server = createSynesisMcpServer({
      url: "https://synesis.example.com",
      pat: "syn-abc123",
    });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("creates a server with allTools option", () => {
    const server = createSynesisMcpServer({
      url: "https://synesis.example.com",
      pat: "syn-abc123",
      allTools: true,
    });
    expect(server).toBeDefined();
  });
});
