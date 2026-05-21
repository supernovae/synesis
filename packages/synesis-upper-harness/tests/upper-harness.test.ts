import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASTER_HARNESS_POLICY,
  evaluateTokenBudget,
  evaluateUpperHarness,
  resolveHarnessCard,
  type HarnessDecisionEvent,
  type HarnessPlugin,
} from "../src/index.js";

describe("upper harness", () => {
  it("resolves model behavior cards without making safety model-specific", () => {
    const qwen = resolveHarnessCard({ modelId: "qwen3-coder-plus", provider: "dashscope" });
    const kimi = resolveHarnessCard({ modelId: "moonshot-kimi-k2.6", provider: "kimi_coding" });

    expect(qwen.id).toBe("qwen3-coder");
    expect(kimi.id).toBe("kimi");
    expect(qwen.repairs.argument_aliases.Bash?.cmd).toBe("command");
    expect(kimi.repairs.argument_aliases.Bash?.cmd).toBe("command");
  });

  it("repairs model-specific tool aliases before applying universal shell safety", () => {
    const decision = evaluateUpperHarness({
      modelId: "qwen3-coder-plus",
      provider: "dashscope",
      toolCall: {
        toolName: "Bash",
        input: { cmd: "rm -rf /tmp/synesis-test" },
      },
    });

    expect(decision.action).toBe("block");
    expect(decision.repaired_tool_call?.input.command).toBe("rm -rf /tmp/synesis-test");
    expect(decision.trace.model_rules).toContain("model_card.qwen3-coder.arg_alias.cmd_to_command");
    expect(decision.trace.systemic_rules).toContain("safety.shell.rm_rf");
  });

  it("applies universal path safety after model-specific argument repair", () => {
    const decision = evaluateUpperHarness({
      modelId: "qwen3-coder-plus",
      provider: "dashscope",
      toolCall: {
        toolName: "Write",
        input: { path: "/etc/passwd", text: "not allowed" },
      },
    });

    expect(decision.action).toBe("block");
    expect(decision.repaired_tool_call?.input.file_path).toBe("/etc/passwd");
    expect(decision.repaired_tool_call?.input.content).toBe("not allowed");
    expect(decision.trace.model_rules).toContain("model_card.qwen3-coder.arg_alias.path_to_file_path");
    expect(decision.trace.systemic_rules).toContain("safety.path.blocked_prefix");
  });

  it("reports token budget decisions with explicit zones and headroom", () => {
    const budget = evaluateTokenBudget(486_000, DEFAULT_MASTER_HARNESS_POLICY);

    expect(budget.zone).toBe("emergency");
    expect(budget.hardLimitTokens).toBe(495_000);
    expect(budget.headroomTokens).toBe(9_000);
    expect(budget.matchedRules).toContain("token_budget:emergency");
  });

  it("blocks requests that exceed the master hard token budget", () => {
    const decision = evaluateUpperHarness({
      modelId: "claude-sonnet-4.5",
      provider: "anthropic",
      tokenBudget: { estimatedInputTokens: 500_000 },
    });

    expect(decision.action).toBe("block");
    expect(decision.budget?.zone).toBe("reject");
    expect(decision.trace.systemic_rules).toContain("token_budget:hard_limit_exceeded");
  });

  it("supports optional plugins without moving universal policy into model cards", () => {
    const pluginEvent: HarnessDecisionEvent = {
      domain: "plugin",
      action: "nudge",
      reason: "plugin saw repeated WebFetch calls",
      matched_rules: ["plugin.kimi.webfetch_repeat"],
    };
    const plugin: HarnessPlugin = {
      id: "kimi-loop-plugin",
      detectLoopRisk(recentToolNames) {
        return recentToolNames.slice(-2).every((name) => name === "WebFetch") ? pluginEvent : null;
      },
    };
    const decision = evaluateUpperHarness({
      modelId: "kimi-k2.6",
      provider: "kimi_coding",
      cards: [
        {
          ...resolveHarnessCard({ modelId: "kimi-k2.6", provider: "kimi_coding" }),
          plugin_id: "kimi-loop-plugin",
        },
      ],
      pluginRegistry: new Map([[plugin.id, plugin]]),
      recentToolNames: ["Read", "WebFetch", "WebFetch"],
    });

    expect(decision.action).toBe("nudge");
    expect(decision.trace.plugin_rules).toContain("plugin.kimi.webfetch_repeat");
  });
});
