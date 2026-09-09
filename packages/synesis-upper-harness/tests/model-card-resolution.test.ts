import { describe, expect, it } from "vitest";
import { resolveHarnessCard } from "../src/cards.js";

describe("model card precedence", () => {
  it.each(["openrouter", "vllm", "generic"])("does not let shared provider %s imply Qwen", provider => {
    expect(resolveHarnessCard({ modelId: "deepseek-v4-pro", provider }).id).toBe("deepseek");
    expect(resolveHarnessCard({ modelId: "unknown", provider }).id).toBe("generic-openai");
    expect(resolveHarnessCard({ modelId: "MiniMax-M2.5", provider }).id).toBe("minimax");
  });
  it("prefers specific variants to broad family hints", () => {
    const card = resolveHarnessCard({ modelId: "Qwen/Qwen3-Coder-Next", provider: "openrouter", family: "qwen3-coder" });
    expect(card.id).toBe("qwen3-coder-next");
    expect(card.sampling_defaults.temperature).toBe(1);
    expect(resolveHarnessCard({ modelId: "Qwen3.6-27B" }).capabilities.supports_thinking).toBe(true);
  });
});
