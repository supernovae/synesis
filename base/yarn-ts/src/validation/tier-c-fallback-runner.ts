import type { generateText as generateTextFn } from "ai";

import type { AppConfig } from "../config.js";
import type { RoleAssignmentConfig } from "../providers/admin-tier-registry.js";
import type { SynesisProviderRegistry } from "../providers/synesis-provider.js";
import type { TierCFallbackContext, TierCFallbackResult } from "./normalizer.js";

export interface ValidationTierCFallbackRunnerOptions {
  config: AppConfig;
  generateText: typeof generateTextFn;
  roleAssignmentRegistry: Map<string, RoleAssignmentConfig>;
  tierRegistry: SynesisProviderRegistry;
}

export function parseTierCFallbackJson(raw: string, maxFindings: number): TierCFallbackResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const findingsRaw = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(findingsRaw) || findingsRaw.length === 0) return null;
  const findings = findingsRaw
    .slice(0, maxFindings)
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const row = f as Record<string, unknown>;
      const message = String(row.message ?? "").trim();
      if (!message) return null;
      const severityRaw = String(row.severity ?? "error").toLowerCase();
      const severity: "error" | "warning" | "info" =
        severityRaw === "warning" || severityRaw === "info" ? severityRaw : "error";
      return {
        family: "generic" as const,
        severity,
        file: typeof row.file === "string" ? row.file : undefined,
        line: typeof row.line === "number" ? row.line : undefined,
        column: typeof row.column === "number" ? row.column : undefined,
        ruleId: typeof row.ruleId === "string" ? row.ruleId : undefined,
        excerpt: typeof row.excerpt === "string" ? row.excerpt : undefined,
        message,
      };
    })
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (findings.length === 0) return null;
  return { findings };
}

export function createValidationTierCFallbackRunner(
  options: ValidationTierCFallbackRunnerOptions,
): (ctx: TierCFallbackContext) => Promise<TierCFallbackResult | null> {
  const { config, generateText, roleAssignmentRegistry, tierRegistry } = options;

  return async (ctx) => {
    if (!config.SYNESIS_YARN_VALIDATION_TIER_C_ENABLED) return null;
    const role = config.SYNESIS_YARN_VALIDATION_TIER_C_ROLE;
    const assigned = roleAssignmentRegistry.get(role);
    if (!assigned?.assigned || !assigned.backendModel) return null;

    const rawOutput = ctx.rawOutput.slice(0, Math.max(1000, config.SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS));
    const findingsTarget = Math.max(1, Math.min(ctx.maxFindings, config.SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS));
    try {
      const { model } = tierRegistry.resolveAdHoc(
        `synesis-tierc-${role}`,
        assigned.backendModel,
        assigned.baseUrl,
        assigned.apiKey,
      );
      const result = await generateText({
        model: model as never,
        maxOutputTokens: 700,
        messages: [
          {
            role: "system",
            content: [
              "You extract validation findings from noisy tool output.",
              "Return strict JSON only with this shape:",
              '{"findings":[{"severity":"error|warning|info","file":"optional","line":0,"column":0,"ruleId":"optional","message":"required","excerpt":"optional"}]}',
              `Return at most ${findingsTarget} findings.`,
              "Do not include markdown, prose, or code fences.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `Tool: ${ctx.toolName ?? "unknown"}`,
              `Family hint: ${ctx.family}`,
              "Output:",
              rawOutput,
            ].join("\n\n"),
          },
        ] as never,
        abortSignal: AbortSignal.timeout(Math.max(300, config.SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS)),
      });
      return parseTierCFallbackJson(result.text, findingsTarget);
    } catch {
      return null;
    }
  };
}
