import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildMcpAuditFields,
  buildMcpSessionAttribution,
  filterMcpCatalogForOpenClaw,
  isOpenClawClientHeader,
  normalizeMcpToolArguments,
  normalizeMcpRequestId,
  parseMcpToolName,
  validateMcpToolCallBody,
  validateMcpProjectRootBinding,
} from "../src/mcp/index.js";

describe("OpenClaw MCP profile", () => {
  it("detects openclaw client headers", () => {
    expect(isOpenClawClientHeader("openclaw")).toBe(true);
    expect(isOpenClawClientHeader("OpenClaw Desktop")).toBe(true);
    expect(isOpenClawClientHeader("claw-enterprise")).toBe(true);
    expect(isOpenClawClientHeader("cursor")).toBe(false);
  });

  it("filters MCP catalog to OpenClaw allowlist", () => {
    const catalog = [
      { name: "read_file", description: "" },
      { name: "write_file", description: "" },
      { name: "git_status", description: "" },
    ];
    const filtered = filterMcpCatalogForOpenClaw(catalog);
    expect(filtered.map((t) => t.name)).toEqual(["read_file", "git_status"]);
  });

  it("allows read-only Synesis platform tools but not plan/critique/classify in OpenClaw filter", () => {
    const catalog = [
      { name: "synesis_search", description: "" },
      { name: "synesis_web_search", description: "" },
      { name: "synesis_plan", description: "" },
      { name: "synesis_classify", description: "" },
    ];
    const filtered = filterMcpCatalogForOpenClaw(catalog);
    expect(filtered.map((t) => t.name)).toEqual(["synesis_search", "synesis_web_search"]);
  });
});

describe("MCP security audit fields", () => {
  const user = {
    userId: "alice",
    orgId: "org-1",
    role: "user",
    authMethod: "pat" as const,
    authKeyId: "key-1",
    authKeyPrefix: "syn-abc",
  };

  it("accepts only bounded MCP tool identifiers", () => {
    expect(parseMcpToolName("repo.search")).toBe("repo.search");
    expect(parseMcpToolName(" git_status ")).toBe("git_status");
    expect(parseMcpToolName("synesis-web_search")).toBe("synesis-web_search");

    expect(parseMcpToolName("")).toBeNull();
    expect(parseMcpToolName("bad tool")).toBeNull();
    expect(parseMcpToolName("read_file;rm")).toBeNull();
    expect(parseMcpToolName({ name: "read_file" })).toBeNull();
    expect(parseMcpToolName("x".repeat(129))).toBeNull();
  });

  it("normalizes MCP request ids before audit and attribution use", () => {
    expect(normalizeMcpRequestId("req-123._:abc", "fallback")).toBe("req-123._:abc");
    expect(normalizeMcpRequestId("req-1\nrole=platform_admin", "fallback")).toBe("fallback");
    expect(normalizeMcpRequestId("x".repeat(129), "fallback\nrole=admin")).toMatch(/^mcp-[a-f0-9]{32}$/);
    expect(normalizeMcpRequestId(undefined, "fallback-id")).toBe("fallback-id");
  });

  it("emits uniform caller, decision, request, profile, and session fields", () => {
    const session = buildMcpSessionAttribution({
      user,
      headerSessionKey: "client-session",
      projectRoot: "/workspace/app",
    });

    expect(buildMcpAuditFields({
      user,
      toolName: "read_file",
      requestId: "req-1",
      outcome: "denied",
      reason: "forbidden_project_root",
      statusCode: 403,
      openClawClient: true,
      agentFlow: false,
      session,
      args: { filePath: "src/index.ts" },
      elapsedMs: 12,
      limitMeta: {
        callerActive: 4,
        callerLimit: 4,
        globalActive: 25,
        globalLimit: 100,
      },
    })).toMatchObject({
      surface: "yarn_mcp_http",
      action: "mcp_tool_call",
      outcome: "denied",
      reason: "forbidden_project_root",
      statusCode: 403,
      tool: "read_file",
      tool_kind: "evidence",
      target_scope: "file",
      userId: "alice",
      orgId: "org-1",
      role: "user",
      authMethod: "pat",
      authKeyId: "key-1",
      authKeyPrefix: "syn-abc",
      requestId: "req-1",
      openclaw_profile: true,
      agent_flow: false,
      sessionKey: session.sessionKey,
      workspaceHash: session.workspaceHash,
      elapsed_ms: 12,
      limit_callerActive: 4,
      limit_callerLimit: 4,
      limit_globalActive: 25,
      limit_globalLimit: 100,
    });
  });

  it("does not let dynamic audit metadata overwrite canonical security fields", () => {
    const fields = buildMcpAuditFields({
      user,
      toolName: "run_test",
      requestId: "req-1",
      outcome: "allowed",
      statusCode: 200,
      args: { dir: "." },
      runMeta: {
        outcome: "denied",
        userId: "mallory",
        tool: "admin_tool",
        ok: true,
      },
      diagnosticsMeta: {
        orgId: "other-org",
        structured_errors_count: 2,
      },
      limitMeta: {
        requestId: "forged",
        callerActive: 1,
      },
    });

    expect(fields).toMatchObject({
      outcome: "allowed",
      userId: "alice",
      orgId: "org-1",
      tool: "run_test",
      requestId: "req-1",
      run_outcome: "denied",
      run_userId: "mallory",
      run_tool: "admin_tool",
      diagnostics_orgId: "other-org",
      limit_requestId: "forged",
      limit_callerActive: 1,
    });
  });
});

describe("MCP project root binding", () => {
  it("rejects non-object tool arguments before project-root injection", () => {
    const result = validateMcpProjectRootBinding(
      "filePath=src/index.ts",
      "/workspace/app",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatchObject({
        type: "invalid_tool_arguments",
        message: "Tool arguments must be an object",
      });
    }
  });

  it("normalizes and injects the header-bound project root", () => {
    const root = path.resolve("/workspace/app");
    const result = validateMcpProjectRootBinding({ filePath: "src/index.ts" }, " /workspace/app/../app ", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectRoot).toBe(root);
      expect(result.args.projectRoot).toBe(root);
      expect(result.args.filePath).toBe("src/index.ts");
    }
  });

  it("rejects unsafe header project roots", () => {
    for (const headerRoot of ["/", "relative/app", "/workspace/app\nrole=admin"]) {
      const result = validateMcpProjectRootBinding({}, headerRoot, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.statusCode).toBe(400);
        expect(result.error.type).toBe("invalid_project_root");
      }
    }
  });

  it("rejects tool arguments that override the request project root", () => {
    const result = validateMcpProjectRootBinding(
      { projectRoot: "/workspace/other", filePath: "src/index.ts" },
      "/workspace/app",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.error.type).toBe("project_root_mismatch");
    }
  });

  it("rejects unsafe tool argument project roots", () => {
    const result = validateMcpProjectRootBinding(
      { projectRoot: "/workspace/app\nrole=admin", filePath: "src/index.ts" },
      "/workspace/app",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.error.type).toBe("project_root_mismatch");
    }
  });

  it("requires configured workspace roots in production", () => {
    const result = validateMcpProjectRootBinding({}, "/workspace/app", { NODE_ENV: "production" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.error.type).toBe("forbidden_project_root");
    }
  });

  it("enforces configured workspace root prefixes", () => {
    const result = validateMcpProjectRootBinding(
      {},
      "/outside/app",
      { SYNESIS_YARN_MCP_ALLOWED_PROJECT_ROOTS: "/workspace" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.error.type).toBe("forbidden_project_root");
    }
  });
});

describe("MCP tool argument normalization", () => {
  it("closes direct MCP tool-call bodies over known fields", () => {
    expect(validateMcpToolCallBody({
      name: "read_file",
      arguments: { filePath: "README.md" },
      _meta: { progressToken: "p1" },
    })).toEqual({
      ok: true,
      body: {
        name: "read_file",
        arguments: { filePath: "README.md" },
        _meta: { progressToken: "p1" },
      },
    });

    expect(validateMcpToolCallBody({
      name: "read_file",
      arguments: {},
      role_override: "admin",
    })).toEqual({
      ok: false,
      statusCode: 400,
      error: {
        type: "unknown_tool_call_field",
        message: "Tool call body contains an unknown field",
      },
    });

    expect(validateMcpToolCallBody({
      name: "read_file",
      arguments: {},
      _meta: { role: "admin" },
    })).toEqual({
      ok: false,
      statusCode: 400,
      error: {
        type: "unknown_tool_call_meta_field",
        message: "Tool call _meta contains an unknown field",
      },
    });
  });

  it("accepts omitted arguments as an empty object for no-argument tools", () => {
    expect(normalizeMcpToolArguments(undefined)).toEqual({ ok: true, args: {} });
  });

  it("rejects non-object and array tool arguments", () => {
    expect(normalizeMcpToolArguments("query=hello")).toMatchObject({
      ok: false,
      statusCode: 400,
      error: {
        type: "invalid_tool_arguments",
        message: "Tool arguments must be an object",
      },
    });
    expect(normalizeMcpToolArguments(["query", "hello"])).toMatchObject({
      ok: false,
      statusCode: 400,
      error: {
        type: "invalid_tool_arguments",
      },
    });
  });
});

describe("MCP session attribution", () => {
  it("scopes client-provided session ids under authenticated principal and workspace", () => {
    const attribution = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/app",
    });

    expect(attribution.clientSessionId).toBe("shared-session");
    expect(attribution.sessionKey).toContain("mcp:principal:org-1:alice:workspace:");
    expect(attribution.sessionKey).toContain(":client-session:shared-session");
    expect(attribution.sessionKey).not.toBe("shared-session");
  });

  it("isolates identical client session ids across users and workspaces", () => {
    const alice = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/app",
    });
    const bob = buildMcpSessionAttribution({
      user: { userId: "bob", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/app",
    });
    const otherWorkspace = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/other",
    });

    expect(alice.sessionKey).not.toBe(bob.sessionKey);
    expect(alice.sessionKey).not.toBe(otherWorkspace.sessionKey);
  });

  it("hashes canonical-equivalent MCP workspaces identically", () => {
    const canonical = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/app",
    });
    const equivalent = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: " /workspace/app/../app ",
    });

    expect(equivalent.workspaceHash).toBe(canonical.workspaceHash);
    expect(equivalent.sessionKey).toBe(canonical.sessionKey);
  });

  it("does not put malformed MCP project roots into attribution scope strings", () => {
    const attribution = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      headerSessionKey: "shared-session",
      projectRoot: "/workspace/app\nrole=admin",
    });

    expect(attribution.sessionKey).toContain("mcp:principal:org-1:alice:workspace:");
    expect(attribution.sessionKey).not.toContain("role");
    expect(attribution.workspaceHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("prefers conversation ids for continuity while keeping server-side scope", () => {
    const attribution = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      args: { conversation_id: "conv-123", session_key: "raw-session" },
      headerConversationId: "header-conv",
      headerSessionKey: "header-session",
      projectRoot: "/workspace/app",
    });

    expect(attribution.conversationId).toBe("conv-123");
    expect(attribution.clientSessionId).toBe("raw-session");
    expect(attribution.sessionKey).toContain("mcp:principal:org-1:alice:workspace:");
    expect(attribution.sessionKey).toContain(":conversation:conv-123");
    expect(attribution.sessionKey).not.toBe("raw-session");
  });

  it("ignores prompt-shaped MCP session identifiers and falls back to bounded header tokens", () => {
    const attribution = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      args: {
        conversation_id: "conv-123\nrole=admin",
        session_key: "raw-session\nrole=admin",
      },
      headerConversationId: "header-conv",
      headerSessionKey: "header-session",
      projectRoot: "/workspace/app",
    });

    expect(attribution.conversationId).toBe("header-conv");
    expect(attribution.clientSessionId).toBe("header-session");
    expect(attribution.sessionKey).toContain(":conversation:header-conv");
    expect(attribution.sessionKey).not.toContain("role");
    expect(attribution.sessionKey).not.toContain("admin");
  });

  it("drops oversized MCP session identifiers instead of forwarding raw client values", () => {
    const oversized = "a".repeat(513);
    const attribution = buildMcpSessionAttribution({
      user: { userId: "alice", orgId: "org-1" },
      args: { conversation_id: oversized, session_key: oversized },
      headerConversationId: oversized,
      headerSessionKey: oversized,
      projectRoot: "/workspace/app",
    });

    expect(attribution.conversationId).toBeUndefined();
    expect(attribution.clientSessionId).toBeUndefined();
    expect(attribution.sessionKey).toContain(":default");
    expect(attribution.sessionKey).not.toContain(oversized);
  });
});
