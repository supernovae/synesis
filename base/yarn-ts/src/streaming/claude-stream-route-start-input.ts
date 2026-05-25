import type { ModelAdapter } from "../providers/model-adapter.js";
import type { StreamRouteEventSink } from "./stream-route-scope.js";
import type {
  ClaudeStreamProviderMessage,
} from "./claude-stream-provider-request.js";
import type {
  ClaudeStreamRouteStartedStream,
  ClaudeStreamRouteStartInput,
} from "./claude-stream-route-start.js";
import type { OpenAIStreamHeartbeat, OpenAIStreamSseRaw } from "./openai-stream-runtime.js";

export type ClaudeStreamRouteStartSection<TMessage extends ClaudeStreamProviderMessage> =
  Omit<ClaudeStreamRouteStartInput<TMessage>, "scope" | "request"> & {
    request: Omit<ClaudeStreamRouteStartInput<TMessage>["request"], "abortSignal">;
  };

export interface ClaudeStreamRouteStartBuilderInput<TMessage extends ClaudeStreamProviderMessage> {
  transport: {
    raw: OpenAIStreamSseRaw;
    headers: Record<string, string>;
    heartbeatIntervalMs: number;
    longWaitEventMs: number;
    startHeartbeat(input: {
      raw: OpenAIStreamSseRaw;
      intervalMs: number;
      longWaitEventMs: number;
      onLongWait?: (elapsedMs: number) => void;
    }): OpenAIStreamHeartbeat;
    createMessageId(): string;
    sendSse(event: string, data: unknown): boolean;
    streamText(options: unknown): ClaudeStreamRouteStartedStream;
  };
  provider: {
    requestId: string;
    model: unknown;
    messages: TMessage[];
    adapter: Pick<ModelAdapter, "family" | "supportsThinking">;
    orchestrationMaxOutputTokens: number;
    requestMaxTokens?: number | null;
    samplingOptions?: Record<string, unknown>;
    stopSequences?: unknown;
    tools?: unknown;
    toolChoice?: unknown;
    providerOptions?: unknown;
    clampMaxOutputTokens(tokens: number): number;
    logger: {
      warn(obj: Record<string, unknown>, msg?: string): void;
    };
  };
  components: {
    tierConfig?: {
      baseUrl?: string;
      backendModel?: string;
    };
    resolvedModelId: string;
    tools: unknown[];
    computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  };
  recordSessionEvent: StreamRouteEventSink;
}

export function buildClaudeStreamRouteStartInput<TMessage extends ClaudeStreamProviderMessage>(
  input: ClaudeStreamRouteStartBuilderInput<TMessage>,
): ClaudeStreamRouteStartSection<TMessage> {
  return {
    recordSessionEvent: input.recordSessionEvent,
    raw: input.transport.raw,
    headers: input.transport.headers,
    heartbeatIntervalMs: input.transport.heartbeatIntervalMs,
    longWaitEventMs: input.transport.longWaitEventMs,
    startHeartbeat: input.transport.startHeartbeat,
    createMessageId: input.transport.createMessageId,
    sendSse: input.transport.sendSse,
    streamText: input.transport.streamText,
    request: {
      requestId: input.provider.requestId,
      model: input.provider.model,
      messages: input.provider.messages,
      adapter: input.provider.adapter,
      orchestrationMaxOutputTokens: input.provider.orchestrationMaxOutputTokens,
      requestMaxTokens: input.provider.requestMaxTokens,
      samplingOptions: input.provider.samplingOptions,
      stopSequences: input.provider.stopSequences,
      tools: input.provider.tools,
      toolChoice: input.provider.toolChoice,
      providerOptions: input.provider.providerOptions,
      clampMaxOutputTokens: input.provider.clampMaxOutputTokens,
      logger: input.provider.logger,
    },
    components: input.components,
  };
}
