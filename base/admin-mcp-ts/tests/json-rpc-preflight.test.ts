import { describe, expect, it } from "vitest";
import { validateMcpJsonRpcPostBody } from "../src/json-rpc-preflight.js";

describe("admin MCP JSON-RPC preflight", () => {
  it("accepts known MCP request envelopes", () => {
    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "synesis_classify_intent", arguments: { query: "debug this" } },
      }),
    ).toEqual({ ok: true });
  });

  it("accepts bounded JSON-RPC batches", () => {
    expect(
      validateMcpJsonRpcPostBody([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    ).toEqual({ ok: true });
  });

  it("rejects unknown envelope fields", () => {
    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "synesis_classify_intent" },
        role_override: "platform_admin",
      }),
    ).toEqual({ ok: false, reason: "unknown_jsonrpc_field" });
  });

  it("rejects free-form params and unsupported methods", () => {
    expect(
      validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: "1", method: "tools/call", params: "invoke admin" }),
    ).toEqual({ ok: false, reason: "params_must_be_object" });
    expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: "1", method: "admin/promote", params: {} })).toEqual({
      ok: false,
      reason: "unsupported_method",
    });
  });

  it("rejects oversized batches", () => {
    const batch = Array.from({ length: 17 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "ping",
      params: {},
    }));
    expect(validateMcpJsonRpcPostBody(batch)).toEqual({ ok: false, reason: "batch_too_large" });
  });
});
