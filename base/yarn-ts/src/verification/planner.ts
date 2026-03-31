/**
 * Verification Planner — builds a language-aware verification plan from
 * the LanguagePackRegistry's verificationCommands.
 *
 * Given detected languages (from project manifest, working frame, or tool
 * context), produces an ordered list of verification commands the LLM
 * should use after making code changes.
 */

import type { LanguagePackRegistry } from "../language-packs/registry.js";
import type { VerificationCommand } from "../language-packs/types.js";
import type { PlannedVerification, VerificationPlan } from "./types.js";

const PRIORITY_TOOLS = new Set([
  "tsc", "cargo", "go", "dotnet", "javac",
  "ruff", "mypy", "eslint", "clippy", "pylint",
]);

export function buildVerificationPlan(
  languages: string[],
  registry: LanguagePackRegistry,
  maxRounds: number = 3,
  budgetMs: number = 30_000,
): VerificationPlan {
  const commands: PlannedVerification[] = [];
  const seen = new Set<string>();

  for (const lang of languages) {
    const pack = registry.getByLanguage(lang);
    if (!pack) continue;

    for (const vc of pack.verificationCommands) {
      const key = `${vc.tool}:${vc.command}`;
      if (seen.has(key)) continue;
      seen.add(key);

      commands.push({
        tool: vc.tool,
        command: vc.command,
        description: vc.description,
        priority: PRIORITY_TOOLS.has(vc.tool) ? "required" : "recommended",
      });
    }
  }

  commands.sort((a, b) => {
    if (a.priority === "required" && b.priority !== "required") return -1;
    if (a.priority !== "required" && b.priority === "required") return 1;
    return 0;
  });

  return { languages, commands, maxRounds, budgetMs };
}

/**
 * Format the verification plan as a structured system-prompt block.
 */
export function formatVerificationPlanBlock(plan: VerificationPlan): string | null {
  if (plan.commands.length === 0) return null;

  const lines: string[] = [
    `<synesis_verification_plan languages="${plan.languages.join(",")}" max_rounds="${plan.maxRounds}">`,
    "After making code changes, verify using these commands:",
    "",
  ];

  for (const cmd of plan.commands) {
    const marker = cmd.priority === "required" ? "[required]" : "[recommended]";
    lines.push(`  ${marker} ${cmd.command}`);
    lines.push(`    ${cmd.description}`);
  }

  lines.push("");
  lines.push("If verification finds issues, use the enriched error analysis to self-repair.");
  lines.push("Stop verification after issues stabilize or budget is exhausted.");
  lines.push("</synesis_verification_plan>");

  return lines.join("\n");
}

/**
 * Check whether a tool name matches any verification command in a plan.
 */
export function isVerificationTool(toolName: string, plan: VerificationPlan): boolean {
  const lower = toolName.toLowerCase();
  return plan.commands.some(
    (c) => lower.includes(c.tool.toLowerCase()) || c.command.toLowerCase().includes(lower),
  );
}

/**
 * Collect all verification tool names from all packs in the registry.
 * Used for quick tool-name matching without a specific plan.
 */
export function getVerificationToolNames(registry: LanguagePackRegistry): Set<string> {
  const tools = new Set<string>();
  for (const pack of registry.getAllPacks()) {
    for (const vc of pack.verificationCommands) {
      tools.add(vc.tool.toLowerCase());
    }
  }
  return tools;
}
