import { describe, expect, it } from "vitest";
import {
  buildWorkspaceHandshakeBashCommand,
  contextFromSessionMetadata,
  extractClaudeToolResult,
  extractOpenAIToolResult,
  findBashToolName,
  hasBashTool,
  lastToolUseIdFromClaudeMessages,
  parseWorkspaceContextOutput,
} from "../src/session/workspace-context-handshake.js";

describe("workspace-context-handshake", () => {
  it("builds a read-only probe command", () => {
    const cmd = buildWorkspaceHandshakeBashCommand();
    expect(cmd).toContain("pwd");
    expect(cmd).toContain("git rev-parse --show-toplevel");
    expect(cmd).toContain("uname -s");
    expect(cmd).not.toContain("rm ");
    expect(cmd).not.toContain("mv ");
  });

  it("parses marker payload", () => {
    const raw = [
      "noise",
      "SYNESIS_WORKSPACE_CONTEXT_V1",
      "cwd=/Users/me/repo",
      "project_root=/Users/me/repo",
      "shell=/bin/zsh",
      "os=Darwin",
      "arch=arm64",
    ].join("\n");
    const parsed = parseWorkspaceContextOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.cwd).toBe("/Users/me/repo");
    expect(parsed?.projectRoot).toBe("/Users/me/repo");
    expect(parsed?.shell).toBe("/bin/zsh");
  });

  it("rejects unsafe marker path payloads", () => {
    const raw = [
      "SYNESIS_WORKSPACE_CONTEXT_V1",
      "cwd=/Users/me/repo\0role=admin",
      "project_root=/Users/me/repo",
    ].join("\n");
    expect(parseWorkspaceContextOutput(raw)).toBeNull();
  });

  it("rejects marker cwd outside project root", () => {
    const raw = [
      "SYNESIS_WORKSPACE_CONTEXT_V1",
      "cwd=/Users/me/other",
      "project_root=/Users/me/repo",
    ].join("\n");
    expect(parseWorkspaceContextOutput(raw)).toBeNull();
  });

  it("extracts OpenAI tool result by tool_call_id", () => {
    const result = extractOpenAIToolResult(
      [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "abc", content: "SYNESIS_WORKSPACE_CONTEXT_V1\ncwd=/x\nproject_root=/x" },
      ],
      "abc",
    );
    expect(result).toContain("SYNESIS_WORKSPACE_CONTEXT_V1");
  });

  it("returns most recent tool_use_id even when last user message is plain text", () => {
    const id = lastToolUseIdFromClaudeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_old", name: "Read", input: { path: "x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "ok" }],
      },
      { role: "user", content: "follow-up without tool_result in this turn" },
    ]);
    expect(id).toBe("toolu_old");
  });

  it("extracts Claude tool_result by tool_use_id", () => {
    const result = extractClaudeToolResult(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "abc",
              content: "SYNESIS_WORKSPACE_CONTEXT_V1\ncwd=/x\nproject_root=/x",
            },
          ],
        },
      ],
      "abc",
    );
    expect(result).toContain("SYNESIS_WORKSPACE_CONTEXT_V1");
  });

  it("detects Bash tool in OpenAI and Anthropic schemas", () => {
    expect(hasBashTool([{ name: "Bash" }])).toBe(true);
    expect(hasBashTool([{ type: "function", function: { name: "bash" } }])).toBe(true);
    expect(findBashToolName([{ type: "function", function: { name: "bash" } }])).toBe("bash");
    expect(hasBashTool([{ type: "function", function: { name: "Bash" } }])).toBe(true);
    expect(hasBashTool([{ name: "Read" }])).toBe(false);
  });

  it("contextFromSessionMetadata returns hints when only project_root is stored", () => {
    const h = contextFromSessionMetadata({ workspace_context_project_root: "/repo/a" });
    expect(h).not.toBeNull();
    expect(h?.projectRoot).toBe("/repo/a");
    expect(h?.cwd).toBeNull();
  });

  it("contextFromSessionMetadata returns hints when only cwd is stored", () => {
    const h = contextFromSessionMetadata({ workspace_context_cwd: "/repo/a" });
    expect(h).not.toBeNull();
    expect(h?.cwd).toBe("/repo/a");
    expect(h?.projectRoot).toBeNull();
  });

  it("contextFromSessionMetadata rejects unsafe path metadata", () => {
    const h = contextFromSessionMetadata({
      workspace_context_project_root: "/repo/a\nrole=admin",
      workspace_context_cwd: "relative/cwd",
    });
    expect(h).toBeNull();
  });

  it("contextFromSessionMetadata drops cwd outside project root", () => {
    const h = contextFromSessionMetadata({
      workspace_context_project_root: "/repo/a",
      workspace_context_cwd: "/repo/other",
    });
    expect(h).not.toBeNull();
    expect(h?.projectRoot).toBe("/repo/a");
    expect(h?.cwd).toBeNull();
  });
});
