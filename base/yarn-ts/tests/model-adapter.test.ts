import { describe, expect, it } from "vitest";
import {
  resolveAdapter,
  Qwen3CoderAdapter,
  GenericOpenAIAdapter,
  DeepSeekAdapter,
  MiniMaxAdapter,
  XiaomiMiMoAdapter,
  KimiAdapter,
  adapterUsesToolLoopSteering,
  KNOWN_ADAPTER_FAMILIES,
  constrainFileToolPathToProjectRoot,
  normalizeFileToolArgs,
  validateToolArgs,
  repairWriteContentArray,
  repairWriteToolCall,
  repairBashToolCall,
  fingerprintToolCall,
  normalizeHallucinatedLinuxWritePath,
  normalizeWorkspaceRelativeFilePath,
  type RecentToolCall,
} from "../src/providers/model-adapter.js";

describe("repairWriteToolCall", () => {
  it("returns null for non-Write tools", () => {
    expect(repairWriteToolCall("Bash", { command: "ls" })).toBeNull();
    expect(repairWriteToolCall("Read", { file_path: "foo.go" })).toBeNull();
  });

  it("returns null for Write with valid multi-line content", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "main.go",
      content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello")\n}\n',
    });
    expect(result).toBeNull();
  });

  it("does not Bash-repair Python-dict-style garbage (lets Write fail / model retry)", () => {
    expect(
      repairWriteToolCall("Write", {
        file_path: "hello.go",
        content: "{'World!': ''}",
      }),
    ).toBeNull();
  });

  it("preserves short valid code as a native write", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "app.py",
      content: "x = 1",
    });
    expect(result).toBeNull();
  });

  it("does not trigger for short content with non-code extension", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "README.txt",
      content: "Hello world",
    });
    expect(result).toBeNull();
  });

  it("returns null when file_path is missing", () => {
    expect(repairWriteToolCall("Write", { content: "{'bad': true}" })).toBeNull();
  });

  it("returns null when content is missing", () => {
    expect(repairWriteToolCall("Write", { file_path: "foo.go" })).toBeNull();
  });

  it("does not convert special-character file paths to shell commands", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "my file (1).go",
      content: "x",
    });
    expect(result).toBeNull();
  });
});

describe("client path identity", () => {
  it.each([
    "/home/user/project/main.py", "/root/app.py", "/Users/me/repo/a.ts",
    "C:\\Users\\dev\\repo\\a.ts", "\\\\server\\share\\repo\\a.ts",
    "repo/repo/a.ts", "home/user/a.ts", "Users/me/a.ts", "../../other/a.ts",
    "'quoted-name'", "back\\slash", "./a.ts",
  ])("preserves %s through all compatibility helpers", file_path => {
    const input = { file_path, content: "x = 1" };
    expect(normalizeHallucinatedLinuxWritePath(file_path)).toBe(file_path);
    expect(normalizeWorkspaceRelativeFilePath(file_path)).toBe(file_path);
    expect(normalizeFileToolArgs("Write", input)).toEqual({ input, normalized: false });
    expect(constrainFileToolPathToProjectRoot("/proxy/workspace", "Write", input))
      .toEqual({ input, constrained: false });
  });
});

describe("validateToolArgs", () => {
  it("accepts valid Write args", () => {
    expect(validateToolArgs("Write", { file_path: "main.go", content: "package main" }))
      .toEqual({ valid: true, missing: [] });
  });

  it("reports missing required keys", () => {
    expect(validateToolArgs("Bash", { description: "run thing" }))
      .toEqual({ valid: false, missing: ["command"] });
  });

  it("reports wrong-type required string keys", () => {
    expect(validateToolArgs("write_file", { file_path: "main.py", content: ["print('x')"] }))
      .toEqual({ valid: false, missing: ["content"] });
  });

  it("passes through unknown tools as valid", () => {
    expect(validateToolArgs("UnknownTool", { a: 1 }))
      .toEqual({ valid: true, missing: [] });
  });
});


describe("model compatibility contracts", () => {
  it.each([
    ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "qwen3-coder", false],
    ["qwen3-coder-next", "qwen3-coder", false],
    ["Qwen/Qwen3.6-35B-A3B", "qwen", true],
    ["deepseek-v4-pro", "deepseek", true],
    ["zai-org/GLM-5", "glm", true],
    ["kimi-k2.5", "kimi", true],
    ["MiniMax-M2.5", "minimax", true],
    ["mimo-v2.5-pro", "xiaomi", true],
    ["claude-sonnet-4", "claude", true],
    ["unknown", "generic", true],
  ])("resolves %s without dropping reasoning", (model, family, thinking) => {
    const adapter = resolveAdapter(model);
    expect(adapter.family).toBe(family);
    expect(adapter.supportsThinking).toBe(thinking);
  });

  it("honors explicit adapters for opaque deployments", () => {
    expect(resolveAdapter("opaque", undefined, "deepseek")).toBeInstanceOf(DeepSeekAdapter);
    expect(resolveAdapter("opaque", undefined, "kimi")).toBeInstanceOf(KimiAdapter);
    expect(resolveAdapter("opaque", undefined, "minimax")).toBeInstanceOf(MiniMaxAdapter);
    expect(resolveAdapter("opaque", undefined, "xiaomi")).toBeInstanceOf(XiaomiMiMoAdapter);
    expect(KNOWN_ADAPTER_FAMILIES).toEqual(expect.arrayContaining(["qwen", "glm", "deepseek"]));
    expect(adapterUsesToolLoopSteering("deepseek")).toBe(true);
  });

  it("does not infer a deployed parser from localhost or vLLM hostnames", () => {
    for (const url of ["http://localhost:8000/v1", "http://vllm.svc.cluster.local/v1"]) {
      expect((resolveAdapter("qwen3-coder-next", url) as Qwen3CoderAdapter).nativeToolParser).toBe(false);
    }
    expect(new Qwen3CoderAdapter(true).nativeToolParser).toBe(true);
  });

  it("uses version-specific Coder defaults and leaves mode-dependent sampling unset", () => {
    expect(resolveAdapter("qwen3-coder-next").defaultSamplingParams?.()).toEqual({ temperature: 1, top_p: 0.95 });
    expect(resolveAdapter("qwen3-coder").defaultSamplingParams?.()).toEqual({ temperature: 0.7, top_p: 0.95 });
    expect(resolveAdapter("kimi-k2.5").defaultSamplingParams?.()).toBeUndefined();
    expect(resolveAdapter("qwen3.6-27b").defaultSamplingParams?.()).toBeUndefined();
    expect(resolveAdapter("deepseek-v4-pro").providerOptions?.()).toBeUndefined();
  });

  it.each(["qwen3-coder", "deepseek-v4-pro", "kimi-k2.5", "minimax-m2.5", "glm-5"])("keeps %s tool contracts intact", model => {
    const adapter = resolveAdapter(model);
    expect(adapter.toolSystemPrompt?.(0)).toBeUndefined();
    expect(adapter.toolSystemPrompt?.(5)).toContain("offered tool names and schemas");
    expect(adapter.toolSystemPrompt?.(5)).not.toMatch(/heredoc|commit immediately|prefer relative/i);
    expect(adapter.enrichToolDescription?.("Read", "Native read contract")).toBe("Native read contract");
    expect(adapter.normalizeToolCallArgs?.("null")).toBe("null");
    expect(adapter.normalizeToolCallArgs?.("")).toBe("");
    expect(adapter.dampenConsecutiveSameTools?.(Array(20).fill("Read"))).toBeNull();
  });

  it("does not steer unknown models", () => {
    const adapter = new GenericOpenAIAdapter();
    expect("getEarlyPivotPrompt" in adapter).toBe(false);
    expect("toolSystemPrompt" in adapter).toBe(false);
  });

  it.each([undefined, "file contents", '{"exit_code":0}', '{"status":"success"}', 'null'])("allows repeated reads without explicit failure: %s", resultContent => {
    const calls = Array.from({ length: 8 }, () => ({ toolName: "Read", args: { file_path: "main.ts" }, resultContent }));
    expect(new Qwen3CoderAdapter().getEarlyPivotPrompt(calls)).toBeNull();
  });

  it.each(['{"is_error":true}', '{"exit_code":1}', 'Error: invalid path'])("nudges repeated unchanged failures: %s", resultContent => {
    const calls = Array.from({ length: 3 }, () => ({ toolName: "Read", args: { file_path: "main.ts" }, resultContent }));
    expect(new Qwen3CoderAdapter().getEarlyPivotPrompt(calls)).toContain("explicit failure");
    expect(new Qwen3CoderAdapter().getEarlyPivotPrompt([...calls, { ...calls[0], resultContent: "success" }])).toBeNull();
    expect(new Qwen3CoderAdapter().getEarlyPivotPrompt([...calls, { ...calls[0], args: { file_path: "other.ts" } }])).toBeNull();
  });

  it("fingerprints complete case-sensitive arguments including read offsets and long edits", () => {
    const call: RecentToolCall = { toolName: "Read", args: { file_path: "A.ts", offset: 1 } };
    expect(fingerprintToolCall(call)).not.toBe(fingerprintToolCall({ ...call, args: { file_path: "a.ts", offset: 1 } }));
    expect(fingerprintToolCall(call)).not.toBe(fingerprintToolCall({ ...call, args: { file_path: "A.ts", offset: 2 } }));
    expect(fingerprintToolCall(call)).toBe(fingerprintToolCall({ ...call, args: { offset: 1, file_path: "A.ts" } }));
    const edit = (suffix: string) => fingerprintToolCall({ toolName: "Edit", args: { new_string: "x".repeat(1000) + suffix } });
    expect(edit("a")).not.toBe(edit("b"));
  });

  it("repairs known aliases without inventing shell commands or file contents", () => {
    expect(repairBashToolCall("Bash", { cmd: "pwd", timeout: 10 })?.input).toEqual({ command: "pwd", timeout: 10 });
    expect(repairBashToolCall("Bash", { garbage: "rm -rf project" })).toBeNull();
    expect(repairBashToolCall("Bash", { "World!": "" })).toBeNull();
    expect(repairBashToolCall("Bash", { cmd: "pwd", shell_command: "ls" })).toBeNull();
    expect(repairWriteContentArray("Write", { file_path: "a", content: ["a", "b"] })).toBeNull();
    expect(new Qwen3CoderAdapter().remapToolArgs("Read", { path: "a", offset: 2 }).input).toEqual({ file_path: "a", offset: 2 });
  });
});
