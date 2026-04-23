/**
 * Proportionality Critic — Proportionality Governance Layer 3
 *
 * Optional fast-model critic gate that evaluates whether the agent's
 * accumulated changes are proportional to the user's stated intent.
 *
 * Triggered only when the deterministic thresholds (Layer 1+2) detect
 * a breach AND the sensemaking governor hasn't already hard-paused.
 *
 * Uses the existing SYNESIS_YARN_CRITIC_URL/MODEL infrastructure.
 */

import type { ScopeEnvelope } from "./intent-scope-classifier.js";
import type { DiffStats, ProportionalityLevel } from "./diff-accumulator.js";

export type CriticVerdict = "proportional" | "disproportionate" | "dangerous";

export interface ProportionalityCriticResult {
  verdict: CriticVerdict;
  reason: string;
  source: "critic_llm" | "critic_timeout" | "critic_error" | "critic_disabled";
}

export interface ProportionalityCriticInput {
  scopeEnvelope: ScopeEnvelope;
  userDirective: string;
  diffStats: DiffStats;
  determinedLevel: ProportionalityLevel;
  recentToolNames: string[];
  breaches: string[];
}

function parseJsonIfPossible(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Call the fast-model critic to evaluate proportionality.
 */
export async function runProportionalityCritic(
  input: ProportionalityCriticInput,
  criticUrl: string,
  criticModel: string,
  serviceToken?: string,
): Promise<ProportionalityCriticResult> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);

    const statsText = [
      `Files modified: ${input.diffStats.filesModified}`,
      `Files deleted: ${input.diffStats.filesDeleted}`,
      `Lines added: ${input.diffStats.linesAdded}`,
      `Lines removed: ${input.diffStats.linesRemoved}`,
      `Net lines removed: ${input.diffStats.netLinesRemoved}`,
      input.diffStats.largestSingleDeletion
        ? `Largest deletion: ${input.diffStats.largestSingleDeletion.path} (${input.diffStats.largestSingleDeletion.linesRemoved} lines)`
        : null,
    ].filter(Boolean).join("\n");

    const prompt = [
      "You are a proportionality critic for coding agent governance.",
      "Evaluate whether the agent's cumulative changes are proportional to the user's request.",
      "",
      `User's request: "${input.userDirective.slice(0, 600)}"`,
      `Classified scope: ${input.scopeEnvelope}`,
      "",
      "Cumulative change stats:",
      statsText,
      "",
      `Threshold breaches: ${input.breaches.join(", ")}`,
      `Recent tools used: ${input.recentToolNames.slice(-10).join(", ")}`,
      "",
      "Rules:",
      "- If the user asked to FIX security issues, the agent should patch them, NOT delete entire features/modules.",
      "- If the user asked to refactor, large changes may be proportional.",
      "- Deleting files when asked to fix bugs is almost always disproportionate.",
      "- Removing functionality (e.g., entire REPL, entire API endpoints) instead of securing it is disproportionate.",
      "",
      "Return JSON only: {\"verdict\":\"proportional|disproportionate|dangerous\",\"reason\":\"one sentence\"}",
    ].join("\n");

    const resp = await fetch(`${criticUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: JSON.stringify({
        model: criticModel,
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      return {
        verdict: input.determinedLevel === "dangerous" ? "dangerous" : "disproportionate",
        reason: `Critic HTTP ${resp.status}; falling back to deterministic: ${input.determinedLevel}`,
        source: "critic_error",
      };
    }

    const body = await resp.json() as Record<string, unknown>;
    const text = String(
      (((body.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}).message as Record<string, unknown> | undefined)?.content ?? "",
    );
    const parsed = parseJsonIfPossible(text) as { verdict?: string; reason?: string } | null;

    if (parsed?.verdict) {
      const v = parsed.verdict.toLowerCase();
      if (v === "proportional" || v === "disproportionate" || v === "dangerous") {
        return { verdict: v, reason: parsed.reason ?? "", source: "critic_llm" };
      }
    }

    return {
      verdict: input.determinedLevel === "dangerous" ? "dangerous" : "disproportionate",
      reason: `Unparseable critic response; falling back to deterministic`,
      source: "critic_error",
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      verdict: input.determinedLevel === "dangerous" ? "dangerous" : "disproportionate",
      reason: isAbort ? "Critic timeout; falling back to deterministic" : `Critic error: ${String(err).slice(0, 100)}`,
      source: isAbort ? "critic_timeout" : "critic_error",
    };
  }
}
