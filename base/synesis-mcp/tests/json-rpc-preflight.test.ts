import { describe, expect, it } from "vitest";
import { validateMcpJsonRpcPostBody } from "../src/json-rpc-preflight.js";

describe("Synesis MCP JSON-RPC preflight", () => {
  it("accepts known MCP request envelopes", () => {
    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "synesis_search", arguments: { query: "hello" } },
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
        params: { name: "synesis_search" },
        org_id: "attacker-org",
      }),
    ).toEqual({ ok: false, reason: "unknown_jsonrpc_field" });
  });

  it("rejects free-form params and unsupported methods", () => {
    expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: "1", method: "tools/call", params: "search" })).toEqual({
      ok: false,
      reason: "params_must_be_object",
    });
    expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: "1", method: "planner/admin", params: {} })).toEqual({
      ok: false,
      reason: "unsupported_method",
    });
  });

  it("rejects malformed IDs", () => {
    expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: { nested: true }, method: "ping", params: {} })).toEqual({
      ok: false,
      reason: "invalid_id",
    });
  });
});
