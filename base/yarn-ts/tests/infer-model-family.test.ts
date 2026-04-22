import { describe, expect, it } from "vitest";
import { inferModelFamily } from "../src/prompt/infer-model-family.js";

/**
 * `inferModelFamily` must match Admin Prompt Library `model_family` slugs
 * and `PROMPT_MODEL_FAMILY_OPTIONS` in the admin UI.
 */
describe("inferModelFamily (yarn prompt context)", () => {
  it("maps Kimi / Moonshot backend ids to slug kimi", () => {
    expect(inferModelFamily("kimi-v1")).toBe("kimi");
    expect(inferModelFamily("moonshot-v1-128k")).toBe("kimi");
  });

  it("maps MiniMax / abab backend ids to slug minimax", () => {
    expect(inferModelFamily("minimax-m2.5")).toBe("minimax");
    expect(inferModelFamily("abab6.5s-chat")).toBe("minimax");
  });

  it("maps Qwen3 Coder variants to qwen3-coder", () => {
    expect(inferModelFamily("Qwen/Qwen3-Coder-480B-A35B-Instruct")).toBe("qwen3-coder");
    expect(inferModelFamily("qwen3-coder-next")).toBe("qwen3-coder");
  });

  it("maps DeepSeek to deepseek", () => {
    expect(inferModelFamily("deepseek-ai/DeepSeek-V3-0324")).toBe("deepseek");
  });

  it("falls back to generic for unknown families", () => {
    expect(inferModelFamily("")).toBe("generic");
    expect(inferModelFamily("gpt-4.1")).toBe("generic");
  });
});
