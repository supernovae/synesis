import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import { reconstructMissingToolCalls } from "../tool-mapping.js";
import { sortToolSchemas } from "../compat/sorted-tools.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "app"
  | "applyIngressCapToToolMessages"
  | "config"
  | "extractLatestUserPromptFromMessages"
  | "sessions"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;

interface PrepareOpenAIRouteRequestSetupInput {
  deps: Deps;
  request: {
    messages: unknown[];
    tools?: unknown[];
  };
  requestId: string;
  identity: Pick<SessionIdentity, "userId" | "orgId" | "conversationId" | "clientKind" | "displayName">;
  optimizationLedger: {
    recordOriginal(messages: Array<{ content?: unknown }>): void;
  };
}

export function prepareOpenAIRouteRequestSetup(
  input: PrepareOpenAIRouteRequestSetupInput,
): {
  taskCue: string;
  pruningWatermark?: number;
} {
  const { deps, request, requestId, identity, optimizationLedger } = input;
  const {
    app,
    applyIngressCapToToolMessages,
    config,
    extractLatestUserPromptFromMessages,
    sessions,
  } = deps;

  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    const rawMsgs = request.messages as Array<Record<string, unknown>>;
    const assistantSample = rawMsgs.filter((m) => m.role === "assistant").slice(0, 3).map((m) => ({
      keys: Object.keys(m),
      hasToolCalls: "tool_calls" in m,
      hasFunctionCall: "function_call" in m,
      hasToolCallsCamel: "toolCalls" in m,
      contentType: typeof m.content,
      contentIsArray: Array.isArray(m.content),
      contentSnippet: typeof m.content === "string" ? m.content.slice(0, 150) : Array.isArray(m.content) ? JSON.stringify(m.content).slice(0, 150) : String(m.content).slice(0, 80),
      toolCallsValue: m.tool_calls ? JSON.stringify(m.tool_calls).slice(0, 200) : undefined,
    }));
    const toolSample = rawMsgs.filter((m) => m.role === "tool").slice(0, 2).map((m) => ({
      keys: Object.keys(m),
      tool_call_id: m.tool_call_id,
      contentSnippet: typeof m.content === "string" ? m.content.slice(0, 100) : String(m.content).slice(0, 100),
    }));
    app.log.info({ reqId: requestId, assistantSample, toolSample }, "raw_message_shape_diagnostic");
  }

  const toolCallReconstruction = reconstructMissingToolCalls(
    request.messages as Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
  );
  if (toolCallReconstruction.reconstructedCount > 0) {
    request.messages = toolCallReconstruction.messages as never;
    app.log.info(
      { reqId: requestId, reconstructedAssistantMessages: toolCallReconstruction.reconstructedCount },
      "tool_calls_reconstructed",
    );
  }

  const taskCue = extractLatestUserPromptFromMessages(request.messages as Array<{ role: string; content: unknown }>);
  optimizationLedger.recordOriginal(request.messages as Array<{ content?: unknown }>);

  if (config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES > 0 && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const ingress = applyIngressCapToToolMessages(
      request.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
      config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
    );
    if (ingress.cappedToolResults > 0) {
      request.messages = ingress.messages as never;
      if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
        app.log.info(
          {
            reqId: requestId,
            capped_tool_results: ingress.cappedToolResults,
            bytes_reclaimed: ingress.bytesReclaimed,
            max_bytes: config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
          },
          "yarn_harness_ingress_cap",
        );
      }
    }
  }

  if (config.SYNESIS_YARN_SORTED_TOOLS_ENABLED && request.tools) {
    request.tools = sortToolSchemas(request.tools) as never;
  }

  const existingKey = `${identity.userId}:${identity.conversationId}:${identity.clientKind}`;
  let pruningWatermark: number | undefined;
  for (const [key, state] of sessions as Map<string, SessionState>) {
    if (key.includes(existingKey) || key.includes(identity.conversationId)) {
      pruningWatermark = state.pruningWatermark;
      break;
    }
  }

  return {
    taskCue,
    pruningWatermark,
  };
}
