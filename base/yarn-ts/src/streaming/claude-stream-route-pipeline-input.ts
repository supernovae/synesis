import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { ClaudeStreamRouteRunInputBuilderInput } from "./claude-stream-route-input.js";
import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";

type ClaudeStreamRoutePipelineSection = ClaudeStreamRouteRunInputBuilderInput<
  ClaudeStreamProviderMessage,
  ClaudeStreamRequestForensicsResult | null | undefined,
  unknown,
  unknown,
  unknown
>["pipeline"];

export interface ClaudeStreamRoutePipelineSupportBuilderInput {
  lifecycle: ClaudeStreamRoutePipelineSection["lifecycle"];
  afterEvents: ClaudeStreamRoutePipelineSection["afterEvents"];
}

export function buildClaudeStreamRoutePipelineSupportInput(
  input: ClaudeStreamRoutePipelineSupportBuilderInput,
): Pick<ClaudeStreamRoutePipelineSection, "lifecycle" | "afterEvents"> {
  return {
    lifecycle: input.lifecycle,
    afterEvents: input.afterEvents,
  };
}
