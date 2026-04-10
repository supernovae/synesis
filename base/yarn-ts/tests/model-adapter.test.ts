import { describe, expect, it } from "vitest";
import {
  resolveAdapter,
  Qwen3CoderAdapter,
  GenericOpenAIAdapter,
  DeepSeekAdapter,
  KNOWN_ADAPTER_FAMILIES,
  constrainFileToolPathToProjectRoot,
  normalizeFileToolArgs,
  validateToolArgs,
  repairWriteToolCall,
  repairBashToolCall,
  fingerprintToolCall,
  normalizeHallucinatedLinuxWritePath,
  normalizeWorkspaceRelativeFilePath,
  type RecentToolCall,
} from "../src/providers/model-adapter.js";

describe("resolveAdapter", () => {
  it("resolves Qwen3-Coder model names to Qwen3CoderAdapter", () => {
    const adapter = resolveAdapter("Qwen/Qwen3-Coder-480B-A35B-Instruct");
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
    expect(adapter.family).toBe("qwen3-coder");
  });

  it("resolves DeepSeek model names to DeepSeekAdapter", () => {
    const adapter = resolveAdapter("deepseek-ai/DeepSeek-V3-0324");
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    expect(adapter.family).toBe("deepseek");
  });

  it("resolves Kimi/Moonshot model names to GenericOpenAIAdapter(kimi)", () => {
    const adapter = resolveAdapter("moonshot-v1-128k");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("kimi");
  });

  it("resolves MiniMax model names to GenericOpenAIAdapter(minimax)", () => {
    const adapter = resolveAdapter("abab6.5s-chat");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("minimax");
  });

  it("falls back to GenericOpenAIAdapter for unknown models", () => {
    const adapter = resolveAdapter("some-unknown-model/v1");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("generic");
  });

  it("is case-insensitive", () => {
    const adapter = resolveAdapter("qwen/qwen3-coder-something");
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
  });

  it("enables nativeToolParser for DashScope URLs", () => {
    const adapter = resolveAdapter(
      "qwen3-coder-next",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    ) as Qwen3CoderAdapter;
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
    expect(adapter.nativeToolParser).toBe(true);
  });

  it("enables nativeToolParser for DashScope US URLs", () => {
    const adapter = resolveAdapter(
      "qwen3-coder-next",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
    ) as Qwen3CoderAdapter;
    expect(adapter.nativeToolParser).toBe(true);
  });

  it("enables nativeToolParser for local vLLM (svc.cluster.local)", () => {
    const adapter = resolveAdapter(
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "http://synesis-coder.synesis-models.svc.cluster.local:8080/v1"
    ) as Qwen3CoderAdapter;
    expect(adapter.nativeToolParser).toBe(true);
  });

  it("disables nativeToolParser for DeepInfra URLs", () => {
    const adapter = resolveAdapter(
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "https://api.deepinfra.com/v1/openai"
    ) as Qwen3CoderAdapter;
    expect(adapter.nativeToolParser).toBe(false);
  });

  it("disables nativeToolParser for OpenRouter URLs", () => {
    const adapter = resolveAdapter(
      "qwen/qwen3-coder",
      "https://openrouter.ai/api/v1"
    ) as Qwen3CoderAdapter;
    expect(adapter.nativeToolParser).toBe(false);
  });
});

describe("resolveAdapter with adapterHint", () => {
  it("overrides auto-detect when hint is qwen3-coder", () => {
    const adapter = resolveAdapter("some-unknown-model", undefined, "qwen3-coder");
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
    expect(adapter.family).toBe("qwen3-coder");
  });

  it("overrides auto-detect when hint is deepseek", () => {
    const adapter = resolveAdapter("my-custom-model-v1", undefined, "deepseek");
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    expect(adapter.family).toBe("deepseek");
  });

  it("overrides auto-detect when hint is kimi", () => {
    const adapter = resolveAdapter("custom-finetuned-v2", undefined, "kimi");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("kimi");
  });

  it("overrides auto-detect when hint is minimax", () => {
    const adapter = resolveAdapter("my-model", undefined, "minimax");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("minimax");
  });

  it("overrides auto-detect when hint is generic", () => {
    const adapter = resolveAdapter("qwen3-coder-next", undefined, "generic");
    expect(adapter).toBeInstanceOf(GenericOpenAIAdapter);
    expect(adapter.family).toBe("generic");
  });

  it("falls back to auto-detect when hint is null", () => {
    const adapter = resolveAdapter("deepseek-v3-0324", undefined, null);
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
  });

  it("falls back to auto-detect when hint is empty string", () => {
    const adapter = resolveAdapter("qwen3-coder-next", undefined, "");
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
  });

  it("falls back to auto-detect when hint is unknown value", () => {
    const adapter = resolveAdapter("qwen3-coder-next", undefined, "nonexistent-family");
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
  });

  it("hint qwen3-coder respects baseUrl for nativeToolParser", () => {
    const adapter = resolveAdapter(
      "my-custom-model",
      "http://my-vllm.synesis-models.svc.cluster.local:8080/v1",
      "qwen3-coder",
    ) as Qwen3CoderAdapter;
    expect(adapter).toBeInstanceOf(Qwen3CoderAdapter);
    expect(adapter.nativeToolParser).toBe(true);
  });

  it("hint qwen3-coder sets nativeToolParser false for OpenRouter", () => {
    const adapter = resolveAdapter(
      "my-custom-model",
      "https://openrouter.ai/api/v1",
      "qwen3-coder",
    ) as Qwen3CoderAdapter;
    expect(adapter.nativeToolParser).toBe(false);
  });

  it("KNOWN_ADAPTER_FAMILIES contains all expected families", () => {
    expect(KNOWN_ADAPTER_FAMILIES).toContain("qwen3-coder");
    expect(KNOWN_ADAPTER_FAMILIES).toContain("deepseek");
    expect(KNOWN_ADAPTER_FAMILIES).toContain("kimi");
    expect(KNOWN_ADAPTER_FAMILIES).toContain("minimax");
    expect(KNOWN_ADAPTER_FAMILIES).toContain("generic");
    expect(KNOWN_ADAPTER_FAMILIES).toHaveLength(5);
  });
});

describe("Qwen3CoderAdapter", () => {
  const adapter = new Qwen3CoderAdapter();

  it("has correct family and capability flags", () => {
    expect(adapter.family).toBe("qwen3-coder");
    expect(adapter.supportsThinking).toBe(false);
    expect(adapter.maxEffectiveTools).toBe(40);
    expect(adapter.nativeToolParser).toBe(false);
  });

  it("returns tool system prompt when tools are present", () => {
    const prompt = adapter.toolSystemPrompt!(10);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("Tool Calling");
  });

  it("returns undefined when no tools", () => {
    const prompt = adapter.toolSystemPrompt!(0);
    expect(prompt).toBeUndefined();
  });

  it("normalizes empty/missing arguments to '{}'", () => {
    expect(adapter.normalizeToolCallArgs!("")).toBe("{}");
    expect(adapter.normalizeToolCallArgs!("null")).toBe("{}");
    expect(adapter.normalizeToolCallArgs!("undefined")).toBe("{}");
    expect(adapter.normalizeToolCallArgs!("  ")).toBe("{}");
  });

  it("passes through valid arguments unchanged", () => {
    const valid = '{"path": "/foo/bar"}';
    expect(adapter.normalizeToolCallArgs!(valid)).toBe(valid);
  });

  it("toolSystemPrompt is deterministic (cache-safe)", () => {
    const a = adapter.toolSystemPrompt!(5);
    const b = adapter.toolSystemPrompt!(5);
    expect(a).toBe(b);
  });

  it("remaps 'path' to 'file_path' for Write", () => {
    const result = adapter.remapToolArgs!("Write", { path: "hello.go", content: "code" });
    expect(result.remapped).toBe(true);
    expect(result.input).toEqual({ file_path: "hello.go", content: "code" });
  });

  it("remaps 'cmd' to 'command' for Bash", () => {
    const result = adapter.remapToolArgs!("Bash", { cmd: "ls -la" });
    expect(result.remapped).toBe(true);
    expect(result.input).toEqual({ command: "ls -la" });
  });

  it("remaps file-path aliases for Update tool", () => {
    const result = adapter.remapToolArgs!("Update", { path: "cmd/main.go", find: "old", replace: "new" });
    expect(result.remapped).toBe(true);
    expect(result.input).toEqual({ file_path: "cmd/main.go", old_string: "old", new_string: "new" });
  });

  it("remaps 'input' to 'command' for Bash", () => {
    const result = adapter.remapToolArgs!("Bash", { input: "whoami" });
    expect(result.remapped).toBe(true);
    expect(result.input).toEqual({ command: "whoami" });
  });

  it("does not remap when correct names already present", () => {
    const result = adapter.remapToolArgs!("Write", { file_path: "hello.go", content: "code" });
    expect(result.remapped).toBe(false);
    expect(result.input).toEqual({ file_path: "hello.go", content: "code" });
  });

  it("returns unchanged for unknown tools", () => {
    const result = adapter.remapToolArgs!("UnknownTool", { foo: "bar" });
    expect(result.remapped).toBe(false);
    expect(result.input).toEqual({ foo: "bar" });
  });

  it("toolSystemPrompt recommends Bash heredoc for code files (JSON backend)", () => {
    const prompt = adapter.toolSystemPrompt!(10);
    expect(prompt).toContain("heredoc");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("Never emit XML");
  });
});

describe("Qwen3CoderAdapter (nativeToolParser)", () => {
  const adapter = new Qwen3CoderAdapter(true);

  it("nativeToolParser flag is set", () => {
    expect(adapter.nativeToolParser).toBe(true);
  });

  it("returns minimal prompt without heredoc workaround", () => {
    const prompt = adapter.toolSystemPrompt!(10);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("RELATIVE");
    expect(prompt).toContain("workspace-relative");
    expect(prompt).not.toContain("heredoc");
    expect(prompt).not.toContain("cat >");
  });

  it("still returns undefined for zero tools", () => {
    expect(adapter.toolSystemPrompt!(0)).toBeUndefined();
  });
});

describe("GenericOpenAIAdapter", () => {
  it("defaults to generic family", () => {
    const adapter = new GenericOpenAIAdapter();
    expect(adapter.family).toBe("generic");
    expect(adapter.supportsThinking).toBe(false);
  });

  it("accepts custom family name", () => {
    const adapter = new GenericOpenAIAdapter("kimi");
    expect(adapter.family).toBe("kimi");
  });

  it("has no toolSystemPrompt or normalizeToolCallArgs", () => {
    const adapter = new GenericOpenAIAdapter();
    expect(adapter.toolSystemPrompt).toBeUndefined();
    expect(adapter.normalizeToolCallArgs).toBeUndefined();
  });
});

describe("defaultSamplingParams", () => {
  it("Qwen3CoderAdapter returns recommended sampling", () => {
    const adapter = new Qwen3CoderAdapter();
    const params = adapter.defaultSamplingParams();
    expect(params).toEqual({ temperature: 1.0, top_p: 0.95 });
  });

  it("GenericOpenAIAdapter has no defaultSamplingParams", () => {
    const adapter = new GenericOpenAIAdapter();
    expect(adapter.defaultSamplingParams).toBeUndefined();
  });

  it("DeepSeekAdapter has no defaultSamplingParams", () => {
    const adapter = new DeepSeekAdapter();
    expect(adapter.defaultSamplingParams).toBeUndefined();
  });
});

describe("DeepSeekAdapter", () => {
  const adapter = new DeepSeekAdapter();

  it("supports thinking", () => {
    expect(adapter.supportsThinking).toBe(true);
  });

  it("returns provider options for reasoning", () => {
    const opts = adapter.providerOptions!();
    expect(opts).toEqual({ openai: { reasoningParser: "deepseek_r1" } });
  });
});

describe("repairBashToolCall", () => {
  it("returns null when command is already set", () => {
    expect(repairBashToolCall("Bash", { command: "ls -la" })).toBeNull();
    expect(repairBashToolCall("Read", { file_path: "x" })).toBeNull();
  });

  it("promotes a single non-empty string value to command", () => {
    const r = repairBashToolCall("Bash", { wrong_key: "echo ok" });
    expect(r?.repaired).toBe(true);
    expect(r?.input).toEqual({ command: "echo ok" });
  });

  it("replaces stray empty-value key (Qwen garbage) with explanatory failing command", () => {
    const r = repairBashToolCall("Bash", { "World!": "" });
    expect(r?.repaired).toBe(true);
    expect(r?.input.command).toMatch(/exit 1/);
    expect(r?.input.command).toMatch(/Synesis Yarn/);
    expect(String(r?.input.description)).toContain("stray key");
  });
});

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

  it("detects suspiciously short content for code files", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "app.py",
      content: "x = 1",
    });
    expect(result).not.toBeNull();
    expect(result!.rewrittenToolName).toBe("Bash");
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

  it("shell-escapes file paths with special characters", () => {
    const result = repairWriteToolCall("Write", {
      file_path: "my file (1).go",
      content: "x",
    });
    expect(result).not.toBeNull();
    expect(result!.rewrittenInput.command).toContain("'my file (1).go'");
  });
});

describe("normalizeHallucinatedLinuxWritePath", () => {
  it("strips /home/<user>/ prefix", () => {
    expect(normalizeHallucinatedLinuxWritePath("/home/user/hello.go")).toBe("hello.go");
    expect(normalizeHallucinatedLinuxWritePath("/home/ubuntu/proj/main.go")).toBe("proj/main.go");
  });

  it("passes through normal relative paths", () => {
    expect(normalizeHallucinatedLinuxWritePath("hello.go")).toBe("hello.go");
    expect(normalizeHallucinatedLinuxWritePath("cmd/main.go")).toBe("cmd/main.go");
  });

  it("strips /root/ prefix", () => {
    expect(normalizeHallucinatedLinuxWritePath("/root/app.go")).toBe("app.go");
  });
});

describe("normalizeWorkspaceRelativeFilePath", () => {
  it("normalizes quotes, slashes, and leading ./", () => {
    expect(normalizeWorkspaceRelativeFilePath("'./cmd\\\\main.go'")).toBe("cmd/main.go");
  });

  it("preserves non-hallucinated absolute macOS paths", () => {
    expect(normalizeWorkspaceRelativeFilePath("/Users/bymiller/src/calc/main.go"))
      .toBe("/Users/bymiller/src/calc/main.go");
  });

  it("preserves Windows drive-letter absolute-looking paths for downstream clamping", () => {
    expect(normalizeWorkspaceRelativeFilePath("C:\\Users\\dev\\proj\\main.go"))
      .toBe("C:/Users/dev/proj/main.go");
  });

  it("collapses duplicated leading repo segment", () => {
    expect(normalizeWorkspaceRelativeFilePath("rosa-cost-calculator/rosa-cost-calculator/internal/main.go"))
      .toBe("rosa-cost-calculator/internal/main.go");
  });

  it("collapses multiply duplicated leading segment", () => {
    expect(
      normalizeWorkspaceRelativeFilePath(
        "aws-cost-calculator/aws-cost-calculator/aws-cost-calculator/main.go",
      ),
    ).toBe("aws-cost-calculator/main.go");
  });
});

describe("constrainFileToolPathToProjectRoot", () => {
  it("passes through without project root", () => {
    const r = constrainFileToolPathToProjectRoot(null, "Write", { file_path: "../x.go" });
    expect(r.constrained).toBe(false);
    expect(r.input.file_path).toBe("../x.go");
  });

  it("leaves in-repo relative paths unchanged", () => {
    const r = constrainFileToolPathToProjectRoot("/tmp/proj", "Write", { file_path: "pkg/a.go" });
    expect(r.constrained).toBe(false);
  });

  it("converts in-root absolute paths to project-relative paths", () => {
    const r = constrainFileToolPathToProjectRoot(
      "/Users/bymiller/src/calc",
      "Edit",
      { file_path: "/Users/bymiller/src/calc/main.go" },
    );
    expect(r.constrained).toBe(true);
    expect(r.input.file_path).toBe("main.go");
  });

  it("handles missing-leading-slash host paths by treating them as absolute", () => {
    const r = constrainFileToolPathToProjectRoot(
      "/Users/bymiller/src/calc",
      "Write",
      { file_path: "Users/bymiller/src/calc/main.go" },
    );
    expect(r.constrained).toBe(true);
    expect(r.input.file_path).toBe("main.go");
  });

  it("clamps Windows absolute paths on non-Windows hosts", () => {
    const r = constrainFileToolPathToProjectRoot(
      "/Users/bymiller/src/calc",
      "Update",
      { file_path: "C:/Users/dev/other/secret.go" },
    );
    expect(r.constrained).toBe(true);
    expect(r.input.file_path).toBe("secret.go");
  });

  it("passes through out-of-root absolute paths to the client", () => {
    const plans = constrainFileToolPathToProjectRoot(
      "/Users/bymiller/src/calc",
      "Write",
      { file_path: "/Users/bymiller/.claude/plans/steady-mixing-dewdrop.md" },
    );
    expect(plans.constrained).toBe(false);
    expect(plans.input.file_path).toBe("/Users/bymiller/.claude/plans/steady-mixing-dewdrop.md");

    const tmp = constrainFileToolPathToProjectRoot(
      "/Users/me/repo",
      "Edit",
      { file_path: "/tmp/scratch.go" },
    );
    expect(tmp.constrained).toBe(false);
    expect(tmp.input.file_path).toBe("/tmp/scratch.go");
  });

  it("passes through relative traversals to the client", () => {
    const r = constrainFileToolPathToProjectRoot("/tmp/proj", "Write", { file_path: "../../etc/passwd" });
    expect(r.constrained).toBe(false);
    expect(r.input.file_path).toBe("../../etc/passwd");
  });
});

describe("normalizeFileToolArgs", () => {
  it("normalizes file_path for file tools", () => {
    const result = normalizeFileToolArgs("Update", { file_path: "'./repo\\\\repo/main.go'" });
    expect(result.normalized).toBe(true);
    expect(result.input.file_path).toBe("repo/main.go");
  });

  it("does nothing for non-file tools", () => {
    const result = normalizeFileToolArgs("Bash", { command: "pwd" });
    expect(result.normalized).toBe(false);
    expect(result.input).toEqual({ command: "pwd" });
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

  it("passes through unknown tools as valid", () => {
    expect(validateToolArgs("UnknownTool", { a: 1 }))
      .toEqual({ valid: true, missing: [] });
  });
});

describe("Qwen3CoderAdapter.toolSystemPrompt workflow discipline", () => {
  it("includes workflow discipline section (JSON backend)", () => {
    const adapter = new Qwen3CoderAdapter(false);
    const prompt = adapter.toolSystemPrompt(10)!;
    expect(prompt).toContain("## Workflow discipline");
    expect(prompt).toContain("Read-then-act");
    expect(prompt).toContain("Plan commitment");
    expect(prompt).toContain("Progressive narrowing");
    expect(prompt).toContain("File offset awareness");
    expect(prompt).toContain("Edit failures");
  });

  it("includes workflow discipline section (native parser)", () => {
    const adapter = new Qwen3CoderAdapter(true);
    const prompt = adapter.toolSystemPrompt(10)!;
    expect(prompt).toContain("## Workflow discipline");
    expect(prompt).toContain("Read-then-act");
  });

  it("workflow discipline is deterministic (cache-safe)", () => {
    const adapter = new Qwen3CoderAdapter(false);
    const a = adapter.toolSystemPrompt(10);
    const b = adapter.toolSystemPrompt(10);
    expect(a).toBe(b);
  });
});

describe("Qwen3CoderAdapter.getEarlyPivotPrompt", () => {
  const adapter = new Qwen3CoderAdapter();

  it("returns null for fewer than 3 tool calls", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "main.go" },
      { toolName: "Read", filePath: "main.go" },
    ];
    expect(adapter.getEarlyPivotPrompt!(calls)).toBeNull();
  });

  it("returns pivot when 3+ consecutive reads of same file", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "main.go" },
      { toolName: "Read", filePath: "main.go" },
      { toolName: "Read", filePath: "main.go" },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls);
    expect(result).not.toBeNull();
    expect(result).toContain("main.go");
    expect(result).toContain("repeating the same intent");
  });

  it("returns pivot when 3+ reads of different files without edits", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "a.go" },
      { toolName: "Read", filePath: "b.go" },
      { toolName: "Read", filePath: "a.go" },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls);
    expect(result).not.toBeNull();
    expect(result).toContain("a.go");
  });

  it("returns null when reads are broken by an edit", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "main.go" },
      { toolName: "Edit", filePath: "main.go" },
      { toolName: "Read", filePath: "main.go" },
    ];
    expect(adapter.getEarlyPivotPrompt!(calls)).toBeNull();
  });

  it("detects edit retry loop (3+ identical edits)", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Edit", filePath: "output.go", args: { old_string: "foo" } },
      { toolName: "Edit", filePath: "output.go", args: { old_string: "foo" } },
      { toolName: "Edit", filePath: "output.go", args: { old_string: "foo" } },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls);
    expect(result).not.toBeNull();
    expect(result).toContain("output.go");
    expect(result).toContain("keeps failing");
    expect(result).toContain("Re-read the file");
  });

  it("returns null for mixed tool calls without a loop", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "a.go" },
      { toolName: "Grep", filePath: undefined },
      { toolName: "Bash", filePath: undefined },
    ];
    expect(adapter.getEarlyPivotPrompt!(calls)).toBeNull();
  });

  it("detects plan-without-action when implementation intent is stated", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "doctor.go" },
      { toolName: "Read", filePath: "doctor.go" },
      { toolName: "Grep", args: { pattern: "stream" } },
      { toolName: "Read", filePath: "doctor.go" },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls, {
      recentAssistantText: "Let me implement the enhanced doctor diagnostics feature now.",
      planNoActionLimit: 4,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("implementation plan");
  });

  it("does not trigger plan-without-action when an edit action exists", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", filePath: "doctor.go" },
      { toolName: "Edit", filePath: "doctor.go", args: { old_string: "x", new_string: "y" } },
      { toolName: "Read", filePath: "doctor.go" },
      { toolName: "Read", filePath: "doctor.go" },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls, {
      recentAssistantText: "I'll implement this now.",
      planNoActionLimit: 4,
      stagnationThreshold: 4,
    });
    expect(result).toBeNull();
  });

  it("collapses path/file_path aliases into the same stagnation fingerprint", () => {
    const a = fingerprintToolCall({ toolName: "Read", args: { path: "cmd/main.go" } });
    const b = fingerprintToolCall({ toolName: "Read", args: { file_path: "cmd/main.go" } });
    expect(a).toBe(b);
  });

  it("detects repeated-intent loop across alias variants", () => {
    const calls: RecentToolCall[] = [
      { toolName: "Read", args: { path: "cmd/main.go" } },
      { toolName: "Read", args: { file_path: "cmd/main.go" } },
      { toolName: "Read", args: { path: "cmd/main.go" } },
      { toolName: "Read", args: { file_path: "cmd/main.go" } },
    ];
    const result = adapter.getEarlyPivotPrompt!(calls, {
      recentAssistantText: "Continue implementation.",
      planNoActionLimit: 10,
      stagnationWindow: 6,
      stagnationThreshold: 3,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("repeating the same intent");
  });
});

describe("Qwen3CoderAdapter.dampenConsecutiveSameTools", () => {
  const adapter = new Qwen3CoderAdapter();

  it("returns null for fewer than 3 tool names", () => {
    expect(adapter.dampenConsecutiveSameTools!(["Read", "Read"])).toBeNull();
  });

  it("returns dampening for 3 consecutive Read calls", () => {
    const result = adapter.dampenConsecutiveSameTools!(["Read", "Read", "Read"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Read");
    expect(result).toContain("3 times");
    expect(result).toContain("make your edit");
  });

  it("returns dampening for 3 consecutive Grep calls", () => {
    const result = adapter.dampenConsecutiveSameTools!(["Grep", "Grep", "Grep"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Grep");
    expect(result).toContain("Narrow your approach");
  });

  it("returns null for 3 consecutive Bash calls (higher threshold)", () => {
    expect(adapter.dampenConsecutiveSameTools!(["Bash", "Bash", "Bash"])).toBeNull();
  });

  it("returns dampening for 6 consecutive Bash calls", () => {
    const result = adapter.dampenConsecutiveSameTools!(["Bash", "Bash", "Bash", "Bash", "Bash", "Bash"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Bash");
    expect(result).toContain("6 times");
  });

  it("returns dampening for 4 consecutive unknown tool calls", () => {
    const result = adapter.dampenConsecutiveSameTools!(["Write", "Write", "Write", "Write"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Write");
    expect(result).toContain("4 times");
  });

  it("returns null when last tool differs from predecessors", () => {
    expect(adapter.dampenConsecutiveSameTools!(["Read", "Read", "Edit"])).toBeNull();
  });

  it("only counts from the tail", () => {
    const result = adapter.dampenConsecutiveSameTools!(["Bash", "Read", "Read", "Read"]);
    expect(result).not.toBeNull();
    expect(result).toContain("Read");
  });
});

describe("Qwen3CoderAdapter.enrichToolDescription", () => {
  const adapter = new Qwen3CoderAdapter();

  it("enriches Read tool description", () => {
    const result = adapter.enrichToolDescription!("Read", "Read a file.");
    expect(result).toContain("[Qwen hint:");
    expect(result).toContain("ONCE");
  });

  it("enriches Edit tool description", () => {
    const result = adapter.enrichToolDescription!("Edit", "Edit a file.");
    expect(result).toContain("[Qwen hint:");
    expect(result).toContain("PREFERRED");
  });

  it("enriches Update tool description", () => {
    const result = adapter.enrichToolDescription!("Update", "Update a file.");
    expect(result).toContain("[Qwen hint:");
    expect(result).toContain("PREFERRED");
  });

  it("enriches Bash tool description", () => {
    const result = adapter.enrichToolDescription!("Bash", "Run a command.");
    expect(result).toContain("[Qwen hint:");
    expect(result).toContain("Read tool");
  });

  it("enriches Grep tool description", () => {
    const result = adapter.enrichToolDescription!("Grep", "Search files.");
    expect(result).toContain("[Qwen hint:");
    expect(result).toContain("Search once");
  });

  it("enriches Glob tool description", () => {
    const result = adapter.enrichToolDescription!("Glob", "Find files.");
    expect(result).toContain("[Qwen hint:");
  });

  it("leaves unknown tool descriptions unchanged", () => {
    const desc = "Some unknown tool.";
    expect(adapter.enrichToolDescription!("UnknownTool", desc)).toBe(desc);
  });

  it("is idempotent (appending hint twice doesn't break)", () => {
    const first = adapter.enrichToolDescription!("Read", "Read a file.");
    const second = adapter.enrichToolDescription!("Read", first);
    expect(second).toContain("[Qwen hint:");
  });
});

describe("GenericOpenAIAdapter has no behavioral shim methods", () => {
  const adapter = new GenericOpenAIAdapter();

  it("has no getEarlyPivotPrompt", () => {
    expect(adapter.getEarlyPivotPrompt).toBeUndefined();
  });

  it("has no dampenConsecutiveSameTools", () => {
    expect(adapter.dampenConsecutiveSameTools).toBeUndefined();
  });

  it("has no enrichToolDescription", () => {
    expect(adapter.enrichToolDescription).toBeUndefined();
  });
});
