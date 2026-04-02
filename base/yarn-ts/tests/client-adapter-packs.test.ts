import { describe, expect, it } from "vitest";
import { appendWorkspaceRootAdapterBlock, ClientAdapterPacks } from "../src/adapters/client-adapter-packs.js";

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

describe("appendWorkspaceRootAdapterBlock", () => {
  it("passes through when header missing", () => {
    expect(appendWorkspaceRootAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", undefined)).toBe(
      "<CLIENT_ADAPTER>x</CLIENT_ADAPTER>",
    );
  });

  it("appends WORKSPACE_ROOT when header set", () => {
    const out = appendWorkspaceRootAdapterBlock("base", "/Users/me/calc");
    expect(out).toContain("base");
    expect(out).toContain("<WORKSPACE_ROOT>");
    expect(out).toContain("path=/Users/me/calc");
  });
});
