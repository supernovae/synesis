import { describe, expect, it } from "vitest";
import {
  appendPathContextToAdapterBlock,
  ClientAdapterPacks,
  parseSessionExecutionContext,
} from "../src/adapters/client-adapter-packs.js";
import { toSessionExecutionContextSystemBlock } from "../src/adapters/session-execution-context.js";

describe("ClientAdapterPacks", () => {
  it("resolves IDE clients to ide mode by default", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("cursor");
    expect(p.mode).toBe("ide");
    expect(p.family).toBe("default");
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
    expect(block).toContain("family=default");
    expect(block).toContain("prefer Update/Edit-style targeted diffs");
    expect(block).toContain("do not delete or weaken failing tests");
  });

  it("resolves openclaw variants to openclaw family features", () => {
    const packs = new ClientAdapterPacks();
    const p = packs.resolve("openclaw-desktop");
    expect(p.family).toBe("openclaw");
    expect(p.features.strictWriteToolGovernance).toBe(true);
    expect(p.features.toolSchemaBudgetCap).toBe(8);
    const block = packs.toSystemBlock(p);
    expect(block).toContain("family=openclaw");
    expect(block).toContain("strict_write_tool_governance=true");
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
  it("passes through when no path context and no claude-code hint", () => {
    expect(
      appendPathContextToAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", {}, null),
    ).toBe("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>");
    expect(
      appendPathContextToAdapterBlock("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>", {}, null, "cursor"),
    ).toBe("<CLIENT_ADAPTER>x</CLIENT_ADAPTER>");
  });

  it("appends PATH_HYGIENE when claude-code hint and no session context", () => {
    const out = appendPathContextToAdapterBlock("base", {}, null, "claude-code");
    expect(out).toContain("base");
    expect(out).toContain("<PATH_HYGIENE>");
    expect(out).toContain("aws-cost-calculator/aws-cost-calculator");
    expect(out).toContain("human-readable paths");
  });

  it("shell_cwd without project_root includes duplicate-segment warning", () => {
    const block = toSessionExecutionContextSystemBlock({
      projectRoot: null,
      shellCwd: "/Users/me/aws-cost-calculator",
    });
    expect(block).toContain("shell_cwd=");
    expect(block).toContain("aws-cost-calculator/aws-cost-calculator");
    expect(block).toContain("human-readable paths");
  });

  it("appends SESSION_EXECUTION_CONTEXT when workspace root header set", () => {
    const out = appendPathContextToAdapterBlock("base", { "x-synesis-workspace-root": "/Users/me/calc" }, null);
    expect(out).toContain("base");
    expect(out).toContain("<SESSION_EXECUTION_CONTEXT>");
    expect(out).toContain("project_root=/Users/me/calc");
    expect(out).toContain("human-readable paths");
  });

  it("prefers metadata synesis_project_root over header", () => {
    const ctx = parseSessionExecutionContext(
      { "x-synesis-workspace-root": "/hdr" },
      { synesis_project_root: "/meta" },
    );
    expect(ctx.projectRoot).toBe("/meta");
  });
});
