import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildMcpSessionAttribution,
  filterMcpCatalogForOpenClaw,
  isOpenClawClientHeader,
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

describe("MCP project root binding", () => {
  it("normalizes and injects the header-bound project root", () => {
    const root = path.resolve("/workspace/app");
    const result = validateMcpProjectRootBinding({ filePath: "src/index.ts" }, root, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectRoot).toBe(root);
      expect(result.args.projectRoot).toBe(root);
      expect(result.args.filePath).toBe("src/index.ts");
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
