import {
  createOpenAIStreamFinalizerInput,
  type OpenAIStreamFinalizerBuilderInput,
  type OpenAIStreamFinalizerFactoryInput,
} from "../streaming/openai-stream-finalizer.js";
import type { OpenAIStreamComponents } from "../streaming/openai-stream-components.js";
import type { StreamRouteEvent, StreamRouteScope } from "../streaming/stream-route-scope.js";

export interface OpenAIStreamRouteFinalizerInput<TChecklist, TVerification, TPlanGraph>
  extends Omit<
    OpenAIStreamFinalizerBuilderInput<TChecklist, TVerification, TPlanGraph>,
    | "writer"
    | "requestId"
    | "sessionKey"
    | "userId"
    | "orgId"
    | "writeFinalText"
    | "stopHeartbeat"
    | "onTaskLedgerOutputScrubbed"
  > {
  scope: StreamRouteScope;
  components: Pick<OpenAIStreamComponents, "writer" | "scrubAndFlushText">;
  stopHeartbeat(): void;
  recordSessionEvent(event: StreamRouteEvent): void;
}

export function createOpenAIStreamRouteFinalizerInput<TChecklist, TVerification, TPlanGraph>(
  input: OpenAIStreamRouteFinalizerInput<TChecklist, TVerification, TPlanGraph>,
): OpenAIStreamFinalizerFactoryInput {
  return createOpenAIStreamFinalizerInput({
    ...input,
    writer: input.components.writer,
    requestId: input.scope.requestId,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    orgId: input.scope.orgId,
    writeFinalText: input.components.scrubAndFlushText,
    stopHeartbeat: input.stopHeartbeat,
    onTaskLedgerOutputScrubbed: () => {
      input.recordSessionEvent({
        eventKind: "task_ledger_output_scrubbed",
        component: "task-ledger",
        detail: "Removed internal task-ledger governance from streamed OpenAI history",
      });
    },
    onModelOutputGuardrail: (event) => {
      input.recordSessionEvent(event);
    },
  });
}
