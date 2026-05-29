import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import { detectCacheStrategy } from "../context/provider-cache-hints.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import { scrubTaskLedgerOutput } from "../task-ledger/index.js";
import { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import { OpenAIStreamState } from "./openai-stream-state.js";
import {
  createOpenAIStreamToolCallAccumulator,
  type OpenAIStreamToolCallAccumulator,
} from "./openai-stream-tool-call-handler.js";

export interface OpenAIStreamComponentsInput {
  raw: NodeJS.WritableStream & { destroyed?: boolean };
  requestId: string;
  resolvedModelId: string;
  messages: Array<{ role: string; content: unknown }>;
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
    modelCapabilityPreset?: string | null;
  };
  write(raw: NodeJS.WritableStream & { destroyed?: boolean }, data: string): boolean;
  computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
}

export interface OpenAIStreamComponents {
  streamState: OpenAIStreamState;
  guardrailAccepted: GuardrailToolCall[];
  blockedDetails: BlockedDiscoveryDetail[];
  accumulator: OpenAIStreamToolCallAccumulator;
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
    modelCapabilityPreset?: string | null;
  };
  localLikeBaseUrl: boolean;
  cacheStrategy: string;
  prefixFingerprint: string | undefined;
  writer: OpenAIStreamResponseWriter;
  scrubAndFlushText(text: string): void;
}

export function createOpenAIStreamComponents(
  input: OpenAIStreamComponentsInput,
): OpenAIStreamComponents {
  const streamState = new OpenAIStreamState();
  const writer = new OpenAIStreamResponseWriter({
    raw: input.raw,
    requestId: input.requestId,
    model: input.resolvedModelId,
    write: input.write,
  });
  return {
    streamState,
    guardrailAccepted: [],
    blockedDetails: [],
    accumulator: createOpenAIStreamToolCallAccumulator(),
    tierConfig: input.tierConfig,
    localLikeBaseUrl: isLocalLikeBaseUrl(input.tierConfig?.baseUrl),
    cacheStrategy: detectCacheStrategy(
      input.tierConfig?.baseUrl ?? "",
      input.tierConfig?.backendModel ?? input.resolvedModelId,
      input.tierConfig?.modelCapabilityPreset,
    ),
    prefixFingerprint: input.computePrefixFingerprint(input.messages),
    writer,
    scrubAndFlushText: (text) => {
      const scrubbed = scrubTaskLedgerOutput(text);
      if (scrubbed.scrubbed) {
        input.recordSessionEvent({
          eventKind: "task_ledger_output_scrubbed",
          component: "task-ledger",
          detail: "Removed internal task-ledger governance from streamed OpenAI output",
        });
      }
      writer.writeTextDelta(scrubbed.text);
    },
  };
}

function isLocalLikeBaseUrl(baseUrl: string | undefined): boolean {
  return !!baseUrl
    && (
      baseUrl.includes(".svc.cluster.local")
      || baseUrl.includes("localhost")
      || baseUrl.includes("127.0.0.1")
    );
}
