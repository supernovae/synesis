import { describe, expect, it } from "vitest";
import {
  applyUpperHarnessToolCall,
  buildYarnUpperHarnessContext,
  evaluateUpperHarnessBudget,
  upperHarnessBlockPayload,
} from "../src/upper-harness/bridge.js";
import { Qwen3CoderAdapter } from "../src/providers/model-adapter.js";

describe("upper harness bridge", () => {
  it("resolves provider paths into harness cards and repairs aliases", () => {
    const context = buildYarnUpperHarnessContext({
      surface: "openai",
      modelId: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      requestedModel: "coder",
      adapter: new Qwen3CoderAdapter(false),
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
    const result = applyUpperHarnessToolCall({
      context,
      toolName: "Bash",
      input: { cmd: "npm test" },
    });

    expect(result.blocked).toBe(false);
    expect(result.repaired).toBe(true);
    expect(result.input.command).toBe("npm test");
    expect(result.decision.harness_card_id).toBe("qwen3-coder");
  });

  it("blocks unsafe commands before provider-specific execution", () => {
    const context = buildYarnUpperHarnessContext({
      surface: "acp",
      modelId: "kimi-k2.7-code",
      provider: "moonshot",
    });
    const result = applyUpperHarnessToolCall({
      context,
      toolName: "Bash",
      input: { command: "rm -rf /tmp/synesis" },
    });
    const payload = upperHarnessBlockPayload(result.decision, "Bash");

    expect(result.blocked).toBe(true);
    expect(result.decision.trace.systemic_rules).toContain("safety.shell.rm_rf");
    expect(payload.category).toBe("upper_harness");
    expect(payload.retryable).toBe(false);
  });

  it("reports budget decisions using Yarn ceilings", () => {
    const context = buildYarnUpperHarnessContext({
      surface: "claude",
      modelId: "claude-sonnet-4.5",
      provider: "anthropic",
    });
    const result = evaluateUpperHarnessBudget({
      context,
      estimatedInputTokens: 199_000,
      ceilingTokens: 200_000,
      outputReserveTokens: 10_000,
    });

    expect(result.blocked).toBe(true);
    expect(result.decision.budget?.zone).toBe("reject");
    expect(result.decision.trace.systemic_rules).toContain("token_budget:hard_limit_exceeded");
  });
});
