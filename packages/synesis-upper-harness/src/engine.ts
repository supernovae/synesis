import { evaluateTokenBudget } from "./budget.js";
import { resolveHarnessCard } from "./cards.js";
import { DEFAULT_MASTER_HARNESS_POLICY } from "./master-policy.js";
import { evaluateUniversalSafety } from "./safety.js";
import {
  UPPER_HARNESS_DECISION_SCHEMA_VERSION,
  type HarnessCardV1,
  type HarnessDecisionAction,
  type HarnessDecisionEvent,
  type HarnessPlugin,
  type HarnessToolCall,
  type MasterHarnessPolicyV1,
  type ToolRepairDecision,
  type UpperHarnessDecision,
  type UpperHarnessInput,
} from "./types.js";

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function aliasesForTool(card: HarnessCardV1, toolName: string): Record<string, string> {
  const aliases = card.repairs.argument_aliases;
  const direct = aliases[toolName];
  if (direct) return direct;
  const normalized = normalizeToolName(toolName);
  for (const [candidate, map] of Object.entries(aliases)) {
    if (normalizeToolName(candidate) === normalized) return map;
  }
  return {};
}

function repairToolArgsWithCard(card: HarnessCardV1, toolCall: HarnessToolCall): ToolRepairDecision {
  const aliases = aliasesForTool(card, toolCall.toolName);
  const next: Record<string, unknown> = { ...toolCall.input };
  const matchedRules: string[] = [];
  for (const [from, to] of Object.entries(aliases)) {
    if (from in next && !(to in next)) {
      next[to] = next[from];
      delete next[from];
      matchedRules.push(`model_card.${card.id}.arg_alias.${from}_to_${to}`);
    }
  }
  if (card.repairs.empty_arguments === "normalize_to_empty_object" && Object.keys(next).length === 0) {
    matchedRules.push(`model_card.${card.id}.empty_args_normalized`);
  }
  return {
    input: next,
    repaired: matchedRules.length > 0,
    matchedRules,
  };
}

function event(
  domain: HarnessDecisionEvent["domain"],
  action: HarnessDecisionAction,
  reason: string,
  matchedRules: string[],
): HarnessDecisionEvent {
  return {
    domain,
    action,
    reason,
    matched_rules: matchedRules,
  };
}

function decideAction(events: HarnessDecisionEvent[]): HarnessDecisionAction {
  if (events.some((e) => e.action === "block")) return "block";
  if (events.some((e) => e.action === "nudge")) return "nudge";
  if (events.some((e) => e.action === "repair")) return "repair";
  return "allow";
}

function pluginFor(
  card: HarnessCardV1,
  registry?: ReadonlyMap<string, HarnessPlugin>,
): HarnessPlugin | undefined {
  if (!card.plugin_id) return undefined;
  return registry?.get(card.plugin_id);
}

export class UpperHarnessEngine {
  evaluate(input: UpperHarnessInput): UpperHarnessDecision {
    const masterPolicy: MasterHarnessPolicyV1 = input.masterPolicy ?? DEFAULT_MASTER_HARNESS_POLICY;
    const card = resolveHarnessCard({
      modelId: input.modelId,
      provider: input.provider,
      family: input.family,
      cards: input.cards,
    });
    const events: HarnessDecisionEvent[] = [];
    let repairedToolCall: HarnessToolCall | undefined;
    let safety;
    let budget;

    if (input.tokenBudget) {
      budget = evaluateTokenBudget(input.tokenBudget.estimatedInputTokens, masterPolicy);
      const action: HarnessDecisionAction = budget.zone === "reject" ? "block" : "allow";
      events.push(event(
        "master",
        action,
        `token budget zone is ${budget.zone}`,
        budget.matchedRules,
      ));
    }

    const plugin = pluginFor(card, input.pluginRegistry);
    if (input.toolCall) {
      const cardRepair = repairToolArgsWithCard(card, input.toolCall);
      let nextToolCall: HarnessToolCall = {
        toolName: input.toolCall.toolName,
        input: cardRepair.input,
      };
      if (cardRepair.repaired) {
        repairedToolCall = nextToolCall;
        events.push(event(
          "model_card",
          "repair",
          `tool arguments repaired by ${card.display_name}`,
          cardRepair.matchedRules,
        ));
      }

      if (plugin?.normalizeToolArgs) {
        const pluginRepair = plugin.normalizeToolArgs(nextToolCall, {
          modelId: input.modelId,
          provider: input.provider,
          card,
        });
        if (pluginRepair.repaired) {
          nextToolCall = { toolName: nextToolCall.toolName, input: pluginRepair.input };
          repairedToolCall = nextToolCall;
          events.push(event(
            "plugin",
            "repair",
            `tool arguments repaired by plugin ${plugin.id}`,
            pluginRepair.matchedRules,
          ));
        }
      }

      safety = evaluateUniversalSafety(nextToolCall, masterPolicy);
      if (safety.action === "block") {
        events.push(event(
          "master",
          "block",
          safety.reason ?? "tool call blocked by master harness safety policy",
          safety.matchedRules,
        ));
      } else {
        events.push(event("master", "allow", "tool call passed universal safety", safety.matchedRules));
      }
    }

    if (plugin?.detectLoopRisk && input.recentToolNames?.length) {
      const pluginEvent = plugin.detectLoopRisk(input.recentToolNames, {
        modelId: input.modelId,
        provider: input.provider,
        card,
      });
      if (pluginEvent) events.push(pluginEvent);
    } else if (card.loop_controls.repeated_tool_dampening && input.recentToolNames?.length) {
      const tail = input.recentToolNames.slice(-3).map(normalizeToolName);
      if (tail.length === 3 && tail.every((name) => name === tail[0])) {
        events.push(event(
          "model_card",
          "nudge",
          `repeated ${tail[0]} calls should pivot to a narrower action`,
          [`model_card.${card.id}.repeated_tool_dampening`],
        ));
      }
    }

    const action = decideAction(events);
    const systemicRules = events.filter((e) => e.domain === "master").flatMap((e) => e.matched_rules);
    const modelRules = events.filter((e) => e.domain === "model_card").flatMap((e) => e.matched_rules);
    const pluginRules = events.filter((e) => e.domain === "plugin").flatMap((e) => e.matched_rules);

    return {
      schema_version: UPPER_HARNESS_DECISION_SCHEMA_VERSION,
      action,
      master_policy_id: masterPolicy.id,
      master_policy_mode: masterPolicy.mode,
      harness_card_id: card.id,
      harness_card_display_name: card.display_name,
      model_id: input.modelId,
      provider: input.provider,
      events,
      repaired_tool_call: repairedToolCall,
      budget,
      safety,
      trace: {
        event_kind: "upper_harness_decision_v1",
        systemic_rules: systemicRules,
        model_rules: modelRules,
        plugin_rules: pluginRules,
      },
    };
  }
}

export function evaluateUpperHarness(input: UpperHarnessInput): UpperHarnessDecision {
  return new UpperHarnessEngine().evaluate(input);
}
