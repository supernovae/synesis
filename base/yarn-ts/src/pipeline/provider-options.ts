import { jsonSchema, Output as aiOutput } from "ai";

import type { PhaseAwareToolChoice } from "../governance/phase-execution-policy.js";
import type { AiSdkJsonResponseFormat } from "../openai-compat.js";

export function suppressThinkingWhenRequiredToolChoice(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  toolChoice: PhaseAwareToolChoice | undefined,
): { providerOptions: Record<string, Record<string, unknown>> | undefined; suppressed: boolean } {
  if (toolChoice !== "required") {
    return { providerOptions, suppressed: false };
  }
  const openaiOptions = (providerOptions?.openai ?? {}) as Record<string, unknown>;
  const hasThinkingEnabled =
    Object.prototype.hasOwnProperty.call(openaiOptions, "thinking")
    || (Object.prototype.hasOwnProperty.call(openaiOptions, "enable_thinking")
      && openaiOptions.enable_thinking !== false);
  if (!hasThinkingEnabled) {
    return { providerOptions, suppressed: false };
  }
  const nextOpenaiOptions: Record<string, unknown> = {
    ...openaiOptions,
    enable_thinking: false,
  };
  delete nextOpenaiOptions.thinking;
  return {
    providerOptions: {
      ...(providerOptions ?? {}),
      openai: nextOpenaiOptions,
    },
    suppressed: true,
  };
}

export function buildOpenAiJsonOutput(format: AiSdkJsonResponseFormat | undefined) {
  if (!format) return undefined;
  if ("schema" in format) {
    return aiOutput.object({
      schema: jsonSchema(format.schema),
      ...(format.name ? { name: format.name } : {}),
      ...(format.description ? { description: format.description } : {}),
    });
  }
  return aiOutput.json();
}

export function applyOpenAiJsonSchemaStrictness(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  format: AiSdkJsonResponseFormat | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!format || !("strict" in format) || format.strict === undefined) return providerOptions;
  return {
    ...(providerOptions ?? {}),
    openai: {
      ...((providerOptions?.openai ?? {}) as Record<string, unknown>),
      strictJsonSchema: format.strict,
    },
  };
}

export function openAiMetadataProviderOptions(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata)
    .filter(([key]) => key.length <= 64)
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)] as const)
    .filter(([, value]) => typeof value === "string" && value.length <= 512);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
