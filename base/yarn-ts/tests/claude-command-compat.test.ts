import { describe, expect, it } from "vitest";
import {
  buildClaudeBootstrapTemplate,
  executeClaudeCompatCommand,
  resolveClaudeModelSelection,
} from "../src/claude-compat.js";
import {
  ClaudeBootstrapQuerySchema,
  ClaudeCommandExecuteRequestSchema,
  ClaudeModelResolutionQuerySchema,
} from "../src/schemas.js";

describe("Claude compatibility schemas", () => {
  it("parses bootstrap preset query", () => {
    const parsed = ClaudeBootstrapQuerySchema.parse({ preset: "go-strict" });
    expect(parsed.preset).toBe("go-strict");
  });

  it("parses model resolution query", () => {
    const parsed = ClaudeModelResolutionQuerySchema.parse({ model: "claude-opus-4-6" });
    expect(parsed.model).toBe("claude-opus-4-6");
  });

  it("accepts extensible command payloads", () => {
    const parsed = ClaudeCommandExecuteRequestSchema.parse({
      command: "compact",
      args: { reason: "manual" },
      conversation_id: "abc",
    });
    expect(parsed.command).toBe("compact");
    expect(parsed.args?.reason).toBe("manual");
  });
});

describe("Claude compatibility command execution", () => {
  it("returns baseline CLAUDE.md template for init", () => {
    const result = executeClaudeCompatCommand({
      tierMap: {},
      availableModels: ["synesis-core"],
      command: "init",
    });
    expect(result.supported).toBe(true);
    expect(result.action).toBe("return_bootstrap_template");
    const data = result.data as {
      template: { content: string };
      writePolicy: { mode: string; existingFileAction: string; emptyWorkspaceAction: string };
    };
    expect(data.template.content.includes("# CLAUDE.md")).toBe(true);
    expect(data.writePolicy.mode).toBe("create_only");
    expect(data.writePolicy.existingFileAction).toContain("do_not_overwrite");
    expect(data.writePolicy.emptyWorkspaceAction).toContain("workspace_root");
    expect(result.notes.join("\n")).toContain("merge/review");
  });

  it("resolves model mappings for model command", () => {
    const result = executeClaudeCompatCommand({
      tierMap: {},
      availableModels: ["synesis-pulse", "synesis-core", "synesis-horizon"],
      command: "model",
      model: "claude-sonnet-4-5",
    });
    const data = result.data as { resolution: { resolvedTier: string | null } };
    expect(result.supported).toBe(true);
    expect(result.action).toBe("model_resolution");
    expect(data.resolution.resolvedTier).toBe("synesis-core");
  });

  it("returns Synesis-mode compaction action for compact command", () => {
    const result = executeClaudeCompatCommand({
      tierMap: {},
      availableModels: ["synesis-core"],
      command: "compact",
      conversationId: "conv-1",
      sessionKey: "synesis:u:claude:conv-1",
    });
    expect(result.supported).toBe(true);
    expect(result.action).toBe("session_compaction_requested");
    expect(result.data?.mode).toBe("synesis_session_compaction");
  });

  it("marks unknown commands unsupported", () => {
    const result = executeClaudeCompatCommand({
      tierMap: {},
      availableModels: ["synesis-core"],
      command: "totally-unknown",
    });
    expect(result.supported).toBe(false);
    expect(result.action).toBe("unsupported_command");
  });
});

describe("Claude bootstrap template", () => {
  it("applies preset addendum", () => {
    const template = buildClaudeBootstrapTemplate("python-strict");
    expect(template.preset).toBe("python-strict");
    expect(template.content.includes("Python preset addendum")).toBe(true);
  });

  it("resolves tier with env map first", () => {
    const resolution = resolveClaudeModelSelection("custom-opus", { opus: "synesis-core" });
    expect(resolution.resolvedTier).toBe("synesis-core");
    expect(resolution.resolutionReason).toBe("env_map");
  });
});
