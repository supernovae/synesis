import { describe, expect, it } from "vitest";
import {
  resolveAdapter,
  Qwen3CoderAdapter,
  GenericOpenAIAdapter,
  DeepSeekAdapter,
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
});

describe("Qwen3CoderAdapter", () => {
  const adapter = new Qwen3CoderAdapter();

  it("has correct family and capability flags", () => {
    expect(adapter.family).toBe("qwen3-coder");
    expect(adapter.supportsThinking).toBe(false);
    expect(adapter.maxEffectiveTools).toBe(40);
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
