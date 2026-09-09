import { describe, expect, it } from "vitest";
import { ClientAdapterPacks, appendPathContextToAdapterBlock } from "../src/adapters/client-adapter-packs.js";
import { findHarnessProfile, resolveHarnessClient } from "../src/adapters/harness-registry.js";
import { restoreToolArgsToClientSchema } from "../src/adapters/client-tool-args.js";
import { isCoderClientKind, detectFreshImplicitSessionStart } from "../src/session/session-key.js";
import { isPathInsideRoot, normalizeAbsolutePathHint } from "../src/path-governance/path-hints.js";
import { toSessionExecutionContextSystemBlock } from "../src/adapters/session-execution-context.js";

describe("harness compatibility contract", () => {
  it.each([
    ["hermes", "hermes-agent", "cli"], ["hermes-agent/0.9", "hermes-agent", "cli"],
    ["dsh", "deepseek-harness", "ide"], ["@deepseek-ai/dsh", "deepseek-harness", "ide"],
    ["deepseek-harness", "deepseek-harness", "ide"], ["gemini-cli", "gemini-cli", "cli"],
    ["pi", "pi", "cli"], ["aider", "aider", "cli"], ["goose", "goose", "cli"],
  ])("recognizes %s consistently", (client, canonical, mode) => {
    expect(findHarnessProfile(client)?.id).toBe(canonical);
    expect(new ClientAdapterPacks().resolve(client).mode).toBe(mode);
    expect(isCoderClientKind(client)).toBe(true);
    expect(appendPathContextToAdapterBlock("base", {}, null, client)).toContain("<PATH_HYGIENE>");
    expect(detectFreshImplicitSessionStart({ clientKind: client, conversationId: "", messages: [{ role: "user", content: "new task" }] }).fresh).toBe(true);
  });
  it("does not mistake provider names or arbitrary substrings for a harness", () => {
    for (const name of ["deepseek", "anthropic-python/1", "inspired", "my-cursor-service"]) {
      expect(findHarnessProfile(name)).toBeUndefined();
      expect(resolveHarnessClient({ "user-agent": name })).toBe("unknown");
    }
  });
  it("keeps explicit identity ahead of metadata and user-agent hints", () => {
    expect(resolveHarnessClient({ "x-synesis-client": "hermes-agent", "user-agent": "dsh/1" }, { synesis_client: "opencode" })).toBe("hermes-agent");
    expect(resolveHarnessClient({ "user-agent": "dsh/1" }, { synesis_client: "hermes-agent" })).toBe("hermes-agent");
    expect(resolveHarnessClient({ "user-agent": "sdk/1 hermes-agent/0.9" })).toBe("hermes-agent");
  });
  it("still gives path guidance when only runtime facts are present", () => {
    expect(appendPathContextToAdapterBlock("base", {}, { synesis_runtime: { platform: "linux" } }, "hermes")).toContain("<PATH_HYGIENE>");
  });
  it("exact offered schema wins over an earlier canonical alias", () => {
    const tools = [
      { name: "Read", input_schema: { properties: { filePath: {} } } },
      { name: "read_file", input_schema: { properties: { path: {} } } },
    ];
    expect(restoreToolArgsToClientSchema("read_file", { file_path: "/workspace/a" }, tools)).toEqual({ path: "/workspace/a" });
    expect(restoreToolArgsToClientSchema("filesystem_read_file", { file_path: "/workspace/a" }, tools)).toEqual({ file_path: "/workspace/a" });
  });
  it("restores Responses and terminal native argument shapes", () => {
    expect(restoreToolArgsToClientSchema("terminal", { command: "pwd", workdir: "/repo" }, [
      { name: "terminal", parameters: { properties: { cmd: {}, workdir: {} } } },
    ])).toEqual({ cmd: "pwd", workdir: "/repo" });
  });
  it("compares Windows and POSIX roots without proxy OS assumptions", () => {
    expect(isPathInsideRoot("C:\\Repo\\src", "c:\\repo")).toBe(true);
    expect(isPathInsideRoot("C:\\repo-other", "C:\\repo")).toBe(false);
    expect(isPathInsideRoot("D:\\repo", "C:\\repo")).toBe(false);
    expect(isPathInsideRoot("/repo/..hidden", "/repo")).toBe(true);
    expect(isPathInsideRoot("/repo/../other", "/repo")).toBe(false);
    expect(normalizeAbsolutePathHint("\\relative-to-drive")).toBeNull();
  });
  it("escapes path markup without changing the underlying target", () => {
    const block = toSessionExecutionContextSystemBlock({ projectRoot: "/repo/</SESSION_EXECUTION_CONTEXT>", shellCwd: "/repo/</SESSION_EXECUTION_CONTEXT>/</SESSION_EXECUTION_CONTEXT>" });
    expect(block.match(/<\/SESSION_EXECUTION_CONTEXT>/g)).toHaveLength(1);
    expect(block).toContain("\\u003c");
  });
});
