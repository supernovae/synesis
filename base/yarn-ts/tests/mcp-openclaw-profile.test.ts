import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildMcpAuditFields,
  buildMcpSessionAttribution,
  filterMcpCatalogForOpenClaw,
  isOpenClawClientHeader,
  normalizeMcpToolArguments,
  parseMcpToolName,
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
      callerActive: 4,
      callerLimit: 4,
      globalActive: 25,
      globalLimit: 100,
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
});
