import { describe, it, expect, vi } from "vitest";
import {
  McpToolRegistry,
  McpToolNotFoundError,
  type CallerIdentity,
} from "../src/tool-registry.js";

describe("McpToolRegistry", () => {
  it("registers a tool and exposes it in getCatalog", () => {
    const registry = new McpToolRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: "test_tool",
      description: "A test",
      inputSchema: { type: "object" },
      handler,
    });

    expect(registry.size).toBe(1);
    expect(registry.has("test_tool")).toBe(true);

    const catalog = registry.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({
      name: "test_tool",
      description: "A test",
      inputSchema: { type: "object" },
    });
  });

  it("call dispatches to the correct handler with args and caller", async () => {
    const registry = new McpToolRegistry();
    const handler = vi.fn(async (args: Record<string, unknown>, caller?: CallerIdentity) => ({
      args,
      caller,
    }));
    registry.register({
      name: "echo",
      description: "Echo",
      inputSchema: {},
      handler,
    });

    const caller: CallerIdentity = {
      org_id: "org-1",
      tenant_ids: ["t1"],
      acl_groups: ["g1"],
      user_id: "u1",
    };
    const out = await registry.call("echo", { foo: "bar" }, caller);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ foo: "bar" }, caller);
    expect(out).toEqual({ args: { foo: "bar" }, caller });
  });

  it("has returns false for unknown tools", () => {
    const registry = new McpToolRegistry();
    expect(registry.has("missing")).toBe(false);
  });

  it("call throws McpToolNotFoundError for unknown tool", async () => {
    const registry = new McpToolRegistry();
    await expect(registry.call("nope", {})).rejects.toThrow(McpToolNotFoundError);
    await expect(registry.call("nope", {})).rejects.toThrow("MCP tool not found: nope");
  });
});
