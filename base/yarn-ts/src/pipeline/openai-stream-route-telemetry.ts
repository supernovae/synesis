import {
  createOpenAIStreamTelemetryInputBuilder,
  type OpenAIStreamTelemetryBuilderInput,
  type OpenAIStreamTelemetryInputBuilder,
} from "../streaming/openai-stream-telemetry.js";
import type { OpenAIStreamComponents } from "../streaming/openai-stream-components.js";
import {
  createStreamTelemetryRouteBase,
  type StreamTelemetryRouteBaseInput,
} from "../streaming/stream-telemetry-route-base.js";

export interface OpenAIStreamRouteTelemetryInput
  extends Omit<
    OpenAIStreamTelemetryBuilderInput,
    | keyof ReturnType<typeof createStreamTelemetryRouteBase>
    | "cacheStrategy"
    | "prefixFingerprint"
    | "getToolNames"
  > {
  routeBase: Omit<StreamTelemetryRouteBaseInput, "cacheStrategy" | "prefixFingerprint">;
  components: Pick<OpenAIStreamComponents, "cacheStrategy" | "prefixFingerprint" | "streamState">;
}

export function createOpenAIStreamRouteTelemetryInputBuilder(
  input: OpenAIStreamRouteTelemetryInput,
): OpenAIStreamTelemetryInputBuilder {
  return createOpenAIStreamTelemetryInputBuilder({
    ...createStreamTelemetryRouteBase({
      ...input.routeBase,
      cacheStrategy: input.components.cacheStrategy !== "none" ? input.components.cacheStrategy : undefined,
      prefixFingerprint: input.components.prefixFingerprint,
    }),
    optimizationLedger: input.optimizationLedger,
    getToolNames: () => input.components.streamState.toolNames(),
    finalizeRequestForensics: input.finalizeRequestForensics,
    recordSessionEvent: input.recordSessionEvent,
    persistDecisionTelemetry: input.persistDecisionTelemetry,
    logOptimizationLedger: input.logOptimizationLedger,
  });
}
