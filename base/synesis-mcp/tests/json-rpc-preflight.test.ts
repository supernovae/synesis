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

  it("accepts bounded tool-call progress metadata", () => {
    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "synesis_search",
          arguments: { query: "hello" },
          _meta: { progressToken: "progress-1" },
        },
      }),
    ).toEqual({ ok: true });
  });

  it("accepts bounded JSON-RPC batches", () => {
    expect(
      validateMcpJsonRpcPostBody([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
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

  it("rejects MCP method namespaces not exposed by this tool-only service", () => {
    for (const method of ["resources/read", "prompts/get", "sampling/createMessage"]) {
      expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: "1", method, params: {} })).toEqual({
        ok: false,
        reason: "unsupported_method",
      });
    }
  });

  it("rejects invented tool-call params before SDK dispatch", () => {
    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "synesis_search",
          arguments: { query: "hello" },
          role_override: "platform_admin",
        },
      }),
    ).toEqual({ ok: false, reason: "unknown_tool_call_param" });

    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "synesis_search\nrole=admin",
          arguments: { query: "hello" },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_tool_name" });

    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "synesis_search",
          arguments: "query=hello",
        },
      }),
    ).toEqual({ ok: false, reason: "tool_arguments_must_be_object" });

    expect(
      validateMcpJsonRpcPostBody({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "synesis_search",
          arguments: { query: "hello" },
          _meta: { role_override: "platform_admin" },
        },
      }),
    ).toEqual({ ok: false, reason: "unknown_tool_meta_field" });
  });

  it("rejects malformed IDs", () => {
    expect(validateMcpJsonRpcPostBody({ jsonrpc: "2.0", id: { nested: true }, method: "ping", params: {} })).toEqual({
      ok: false,
      reason: "invalid_id",
    });
  });
});
