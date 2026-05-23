import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { GovernorService } from "../governance/governor-service.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { CanonicalChatRequest, PipelineContext, PipelineResult } from "./types.js";
import { resolvePipelineMode, shouldRunGovernorForMode } from "./modes.js";

export interface OpenAIChatPipelineDeps {
  governorService?: Pick<GovernorService, "beforeProviderCall">;
}

export class OpenAIChatPipeline {
  constructor(private readonly deps: OpenAIChatPipelineDeps = {}) {}

  canonicalize(request: OpenAIChatCompletionRequest): CanonicalChatRequest {
    return {
      protocol: "openai",
      model: request.model,
      messages: request.messages as unknown[],
      stream: request.stream ?? false,
      tools: request.tools as unknown[] | undefined,
      metadata: request.metadata ?? null,
      raw: request,
    };
  }

  resolveMode(input: Parameters<typeof resolvePipelineMode>[0]) {
    return resolvePipelineMode(input);
  }

  async beforeProviderCall(
    ctx: PipelineContext,
    request: { messages: GovernorInputMessage[]; governorOptions?: Parameters<GovernorService["beforeProviderCall"]>[1]["options"] },
  ): Promise<PipelineResult["governor"]> {
    if (!shouldRunGovernorForMode(ctx.mode) || !this.deps.governorService) {
      return null;
    }
    return this.deps.governorService.beforeProviderCall(ctx, {
      messages: request.messages,
      options: request.governorOptions,
    });
  }
}
