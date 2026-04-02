import { describe, expect, it } from "vitest";
import {
  appendPathContextToAdapterBlock,
  ClientAdapterPacks,
  parseSessionExecutionContext,
} from "../src/adapters/client-adapter-packs.js";

describe("ClientAdapterPacks", () => {
  it("resolves IDE clients to ide mode by default", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("cursor");
    expect(p.mode).toBe("ide");
    expect(p.workflow).toBe("mixed");
  });

  it("resolves CLI clients to cli mode", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("codex-cli");
    expect(p.mode).toBe("cli");
    expect(p.workflow).toBe("validation");
  });

  it("respects explicitly requested mode", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("cursor", "background");
    expect(p.mode).toBe("background");
    expect(p.workflow).toBe("planning");
  });

  it("returns adapter system block", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("claude-code");
    const block = packs.toSystemBlock(p);
    expect(block).toContain("<CLIENT_ADAPTER>");
    expect(block).toContain("client=claude-code");
  });

  it("tracks stats by mode", () => {
    const packs = new ClientAdapterPacks();
    packs.resolve("cursor");
    packs.resolve("codex-cli");
    packs.resolve("continue", "mcp_native");
    const s = packs.getStats();
    expect(s.resolutions).toBe(3);
    expect(s.byMode.ide).toBe(1);
    expect(s.byMode.cli).toBe(1);
    expect(s.byMode.mcp_native).toBe(1);
  });
});

describe("appendPathContextToAdapterBlock", () => {
  it("passes through when no path context", () => {
    expect(
      appendPathContextToAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", {}, null),
    ).toBe("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>");
  });

  it("appends SESSION_EXECUTION_CONTEXT when workspace root header set", () => {
    const out = appendPathContextToAdapterBlock("base", { "x-synesis-workspace-root": "/Users/me/calc" }, null);
    expect(out).toContain("base");
    expect(out).toContain("<SESSION_EXECUTION_CONTEXT>");
    expect(out).toContain("project_root=/Users/me/calc");
  });

  it("prefers metadata synesis_project_root over header", () => {
    const ctx = parseSessionExecutionContext(
      { "x-synesis-workspace-root": "/hdr" },
      { synesis_project_root: "/meta" },
    );
    expect(ctx.projectRoot).toBe("/meta");
  });
});
