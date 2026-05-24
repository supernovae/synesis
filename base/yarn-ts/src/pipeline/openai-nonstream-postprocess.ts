import { buildOpenAIChatCompletionResponse } from "./openai-chat-response.js";
import {
  applyOpenAINonStreamDiscoveryGuardrailPass,
  type OpenAINonStreamDiscoveryGuardrailPassInput,
  type OpenAINonStreamDiscoveryGuardrailResult,
} from "./openai-nonstream-discovery-guardrails.js";
import {
  finalizeOpenAINonStreamText,
  type OpenAINonStreamFinalizerInput,
  type OpenAINonStreamFinalizerSession,
} from "./openai-nonstream-finalizer.js";
import { buildOpenAINonStreamAssistantMessage } from "./openai-nonstream-response-message.js";
import {
  runOpenAINonStreamTelemetry,
  type OpenAINonStreamTelemetryInput,
} from "./openai-nonstream-telemetry.js";
import {
  maybeRewriteOpenAINonStreamCollapsedToolCalls,
  type OpenAINonStreamToolCollapseInput,
} from "./openai-nonstream-tool-collapse.js";
import {
  prepareOpenAINonStreamExternalToolCalls,
  type OpenAINonStreamToolCall,
  type OpenAINonStreamToolCallInput,
  type OpenAINonStreamToolCallSession,
} from "./openai-nonstream-tool-calls.js";
import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { OpenAINonStreamRouteScope } from "./openai-nonstream-route-scope.js";

export interface OpenAINonStreamProviderResultFields {
  text?: string;
  reasoning?: unknown;
  usage?: unknown;
  toolCalls?: OpenAINonStreamToolCall[];
}

export interface OpenAINonStreamPostProviderInput<
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  result: OpenAINonStreamProviderResultFields;
  responseId: string;
  responseModel: string;
  readUsage(usage: unknown): StreamTokenUsage;
  toolCallInput: Omit<OpenAINonStreamToolCallInput<TSession>, "toolCalls">;
  topLevelDirs: string[];
  applyDiscoveryGuardrail(
    calls: GuardrailToolCall[],
    topLevelDirs: string[],
  ): OpenAINonStreamDiscoveryGuardrailResult<GuardrailToolCall>;
  discoveryInput: Omit<
    OpenAINonStreamDiscoveryGuardrailPassInput<GuardrailToolCall>,
    "calls" | "finalText" | "guardrail" | "recordRecoveryEvent"
  >;
  collapseInput: Omit<OpenAINonStreamToolCollapseInput, "calls">;
  finalizerInput: Omit<
    OpenAINonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>,
    "finishReason" | "assistantText"
  >;
  telemetryInput: Omit<
    OpenAINonStreamTelemetryInput,
    "usage" | "finishReason" | "toolNames" | "gate"
  >;
  responseInput: {
    effectiveTools: unknown[];
    clientKind: string;
  };
}

export interface OpenAINonStreamPostProviderResult {
  body: ReturnType<typeof buildOpenAIChatCompletionResponse>;
  usage: StreamTokenUsage;
  finishReason: string;
  finalText: string;
  toolCalls: GuardrailToolCall[];
}

export interface OpenAINonStreamPostProviderRouteInput<
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  scope: OpenAINonStreamRouteScope;
  responseModel: string;
  readUsage(usage: unknown): StreamTokenUsage;
  toolCallInput: Omit<
    OpenAINonStreamToolCallInput<TSession>,
    "toolCalls" | "requestId" | "sessionKey" | "userId" | "orgId"
  >;
  applyDiscoveryGuardrail(
    calls: GuardrailToolCall[],
    topLevelDirs: string[],
  ): OpenAINonStreamDiscoveryGuardrailResult<GuardrailToolCall>;
  discoveryInput: Omit<
    OpenAINonStreamDiscoveryGuardrailPassInput<GuardrailToolCall>,
    "calls" | "finalText" | "guardrail" | "recordRecoveryEvent" | "sessionKey" | "userId" | "orgId" | "requestId" | "resolvedModelId" | "recordSessionEvent"
  >;
  finalizerInput: Omit<
    OpenAINonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>,
    "finishReason" | "assistantText" | "requestId" | "sessionKey" | "userId" | "orgId" | "recordSessionEvent"
  >;
  telemetryInput: Omit<
    OpenAINonStreamTelemetryInput,
    | "usage"
    | "finishReason"
    | "toolNames"
    | "gate"
    | "requestId"
    | "sessionKey"
    | "userId"
    | "orgId"
    | "resolvedModelId"
    | "clientRequestedModel"
    | "recordSessionEvent"
    | "persistDecisionTelemetry"
  > & {
    clientRequestedModel: string;
    escalated: boolean;
  };
  collapseInput: Omit<OpenAINonStreamToolCollapseInput, "calls">;
  responseInput: OpenAINonStreamPostProviderInput<TSession, TChecklist, TVerification, TPlanGraph>["responseInput"];
}

export function createOpenAINonStreamPostProviderInput<
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: OpenAINonStreamPostProviderRouteInput<TSession, TChecklist, TVerification, TPlanGraph>,
): Omit<OpenAINonStreamPostProviderInput<TSession, TChecklist, TVerification, TPlanGraph>, "result" | "topLevelDirs"> {
  const recordScopedEvent = (
    _sessionKey: string,
    _userId: string,
    _orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    _requestId: string,
    metadataJson?: Record<string, unknown>,
  ): void => {
    input.scope.recordEvent({ eventKind, component, detail, metadataJson });
  };

  return {
    responseId: input.scope.requestId,
    responseModel: input.responseModel,
    readUsage: input.readUsage,
    toolCallInput: {
      ...input.toolCallInput,
      requestId: input.scope.requestId,
      sessionKey: input.scope.sessionKey,
      userId: input.scope.userId,
      orgId: input.scope.orgId,
    },
    applyDiscoveryGuardrail: input.applyDiscoveryGuardrail,
    discoveryInput: {
      ...input.discoveryInput,
      sessionKey: input.scope.sessionKey,
      userId: input.scope.userId,
      orgId: input.scope.orgId,
      requestId: input.scope.requestId,
      resolvedModelId: input.responseModel,
      recordSessionEvent: recordScopedEvent,
    },
    collapseInput: input.collapseInput,
    finalizerInput: {
      ...input.finalizerInput,
      requestId: input.scope.requestId,
      sessionKey: input.scope.sessionKey,
      userId: input.scope.userId,
      orgId: input.scope.orgId,
      recordSessionEvent: recordScopedEvent,
    },
    telemetryInput: {
      ...input.telemetryInput,
      requestId: input.scope.requestId,
      sessionKey: input.scope.sessionKey,
      userId: input.scope.userId,
      orgId: input.scope.orgId,
      resolvedModelId: input.responseModel,
      clientRequestedModel: input.telemetryInput.clientRequestedModel,
      recordSessionEvent: input.scope.recordEvent,
      persistDecisionTelemetry: (telemetry) => input.scope.persistDecisionTelemetry({
        ...telemetry,
        escalated: input.telemetryInput.escalated,
      }),
    },
    responseInput: input.responseInput,
  };
}

export async function processOpenAINonStreamProviderResult<
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: OpenAINonStreamPostProviderInput<TSession, TChecklist, TVerification, TPlanGraph>,
): Promise<OpenAINonStreamPostProviderResult> {
  let finalText = input.result.text ?? "";
  let toolCalls = prepareOpenAINonStreamExternalToolCalls({
    ...input.toolCallInput,
    toolCalls: input.result.toolCalls ?? [],
  });

  const firstGuardrail = input.applyDiscoveryGuardrail(toolCalls, input.topLevelDirs);
  const firstGuarded = await applyOpenAINonStreamDiscoveryGuardrailPass({
    ...input.discoveryInput,
    calls: toolCalls,
    finalText,
    guardrail: firstGuardrail,
    recordRecoveryEvent: true,
  });
  toolCalls = firstGuarded.calls;
  finalText = firstGuarded.finalText;

  toolCalls = await maybeRewriteOpenAINonStreamCollapsedToolCalls({
    ...input.collapseInput,
    calls: toolCalls,
  });

  const legacyGuardrail = input.applyDiscoveryGuardrail(toolCalls, input.topLevelDirs);
  const legacyGuarded = await applyOpenAINonStreamDiscoveryGuardrailPass({
    ...input.discoveryInput,
    calls: toolCalls,
    finalText,
    guardrail: legacyGuardrail,
    recordRecoveryEvent: false,
  });
  toolCalls = legacyGuarded.calls;
  finalText = legacyGuarded.finalText;

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  const finalized = await finalizeOpenAINonStreamText({
    ...input.finalizerInput,
    finishReason,
    assistantText: finalText,
  });
  finalText = finalized.finalText;

  const usage = input.readUsage(input.result.usage);
  runOpenAINonStreamTelemetry({
    ...input.telemetryInput,
    usage,
    finishReason,
    toolNames: toolCalls.map((toolCall) => toolCall.toolName),
    gate: {
      gateApplied: finalized.gateApplied,
      missingMust: finalized.missingMust,
      missingShould: finalized.missingShould,
      gateBlockedVerification: finalized.gateBlockedVerification,
      criticBlocked: finalized.criticBlocked,
    },
  });

  const message = buildOpenAINonStreamAssistantMessage({
    finalText,
    reasoning: input.result.reasoning,
    toolCalls,
    effectiveTools: input.responseInput.effectiveTools,
    clientKind: input.responseInput.clientKind,
  });

  return {
    body: buildOpenAIChatCompletionResponse({
      id: input.responseId,
      model: input.responseModel,
      message,
      finishReason,
      usage,
    }),
    usage,
    finishReason,
    finalText,
    toolCalls,
  };
}
