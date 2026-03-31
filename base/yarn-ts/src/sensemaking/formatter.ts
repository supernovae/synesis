/**
 * Sensemaking Formatter — produces system blocks from exploration plans
 * for injection into the model's context.
 */

import type { SensemakingResult, ExplorationAction, GapClassification } from "./types.js";

export function formatExplorationPlanBlock(result: SensemakingResult): string {
  if (!result.triggered || !result.plan) return "";

  const lines: string[] = [
    "<EXPLORATION_PLAN>",
    `Sensemaking activated: ${result.reason ?? "exploration mode"}`,
    "",
  ];

  lines.push("## Evidence Classification");
  lines.push(...formatGapSummary(result.gaps));
  lines.push("");

  const { plan } = result;

  lines.push("## Desired End State");
  lines.push(plan.desiredEndState);
  lines.push("");

  if (plan.preconditions.length > 0) {
    lines.push("## Preconditions (work backward from end state)");
    for (const pre of plan.preconditions) {
      lines.push(`- ${pre}`);
    }
    lines.push("");
  }

  if (plan.evidenceCheckpoints.length > 0) {
    lines.push("## Evidence Checkpoints");
    for (const cp of plan.evidenceCheckpoints) {
      lines.push(`- [ ] ${cp}`);
    }
    lines.push("");
  }

  if (plan.forwardPath.length > 0) {
    lines.push("## Recommended Actions (execute before generating code)");
    const required = plan.forwardPath.filter((a) => a.priority === "required");
    const recommended = plan.forwardPath.filter((a) => a.priority === "recommended");

    if (required.length > 0) {
      lines.push("### Required");
      for (const action of required) {
        lines.push(formatAction(action));
      }
    }
    if (recommended.length > 0) {
      lines.push("### Recommended");
      for (const action of recommended) {
        lines.push(formatAction(action));
      }
    }
    lines.push("");
  }

  if (plan.fallbackBranches.length > 0) {
    lines.push("## Fallback Strategy");
    for (const fb of plan.fallbackBranches) {
      lines.push(`- ${fb}`);
    }
    lines.push("");
  }

  lines.push("IMPORTANT: Execute the exploration actions above to gather evidence before generating code.");
  lines.push("Present options and findings to the user rather than guessing when evidence is insufficient.");
  lines.push("</EXPLORATION_PLAN>");

  return lines.join("\n");
}

function formatGapSummary(gaps: GapClassification): string[] {
  const lines: string[] = [];

  if (gaps.known.length > 0) {
    lines.push(`**Known** (${gaps.known.length}): ${gaps.known.map((g) => g.domain).join(", ")}`);
  }
  if (gaps.unknown.length > 0) {
    lines.push(`**Unknown** (${gaps.unknown.length}): ${gaps.unknown.map((g) => g.description).join("; ")}`);
  }
  if (gaps.knowBetter.length > 0) {
    lines.push(`**Can Know Better** (${gaps.knowBetter.length}): ${gaps.knowBetter.map((g) => g.description).join("; ")}`);
  }

  if (lines.length === 0) {
    lines.push("No evidence gaps identified.");
  }

  return lines;
}

function formatAction(action: ExplorationAction): string {
  const tool = action.tool ? ` [${action.tool}]` : "";
  const kindLabel = action.kind === "tool" ? "Run" : action.kind === "search" ? "Search" : "Ask";
  return `- ${kindLabel}${tool}: ${action.description}`;
}
