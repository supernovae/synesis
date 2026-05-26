import { normalizeToolDescriptions } from "../compat/tool-description-normalizer.js";
import {
  chatCompletionToResponseObject,
  OpenAIResponsesRequestSchema,
  responseObjectToSseEvents,
  responsesRequestToChatCompletion,
} from "../responses-compat.js";
import type { PlatformRouteDependencies } from "./platform-route-support.js";

export function registerResponsesRoutes(deps: PlatformRouteDependencies): void {
  const {
    app,
    resolveRequestId,
    formatValidationError,
    selectedOpenAiCompatHeaders,
    safeWrite,
    safeEnd,
  } = deps;

  app.post("/v1/responses", async (req, reply) => {
    const responseReqId = resolveRequestId(req.headers as Record<string, unknown>);
    const normalizedIngress = normalizeToolDescriptions(req.body, "responses", "/v1/responses");
    for (const truncation of normalizedIngress.truncations) {
      app.log.warn({ reqId: responseReqId, ...truncation }, "tool_description_truncated");
    }
    const parsed = OpenAIResponsesRequestSchema.safeParse(normalizedIngress.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { type: "invalid_request_error", message: formatValidationError(parsed.error) },
      });
    }
    const responseRequest = parsed.data;
    const chatRequest = responsesRequestToChatCompletion(responseRequest);
    const injected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: selectedOpenAiCompatHeaders(req.headers as Record<string, unknown>),
      payload: JSON.stringify({ ...chatRequest, stream: false }),
    });

    let chatPayload: Record<string, unknown>;
    try {
      chatPayload = JSON.parse(injected.body) as Record<string, unknown>;
    } catch {
      chatPayload = {
        error: {
          type: "api_error",
          message: injected.body || "Unable to parse upstream chat completion response.",
        },
      };
    }
    if (injected.statusCode >= 400) {
      return reply.code(injected.statusCode).send(chatPayload);
    }

    const response = chatCompletionToResponseObject(chatPayload, responseRequest);
    if (!responseRequest.stream) {
      return reply.send(response);
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    for (const evt of responseObjectToSseEvents(response)) {
      if (!safeWrite(reply.raw, `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)) break;
    }
    safeWrite(reply.raw, "data: [DONE]\n\n");
    safeEnd(reply.raw);
    return reply;
  });
}
