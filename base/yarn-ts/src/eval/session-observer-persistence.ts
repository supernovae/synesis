import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { EvalChatMessage } from "./types.js";
import {
  buildLiveEvalEvent,
  buildObservedTurn,
  buildTranscriptEvent,
  isObserverEnabled,
  shouldObserveSession,
} from "./session-observer.js";

export interface ObserverHistoryMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface EvalObserverSessionEventRecord {
  sessionKey: string;
  userId: string;
  orgId: string;
  eventKind: string;
  component: string;
  detail: string;
  requestId: string;
  metadataJson: Record<string, unknown>;
}

export interface RunEvalObserverPersistenceInput {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  history: ObserverHistoryMessage[];
  snapshot: DecisionSnapshot;
  recordSessionEvent: (event: EvalObserverSessionEventRecord) => void;
  isEnabled?: () => boolean;
  shouldObserve?: (sessionKey: string) => boolean;
  warn?: (err: unknown) => void;
}

function toEvalMessage(message: ObserverHistoryMessage): EvalChatMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

export function runEvalObserverPersistence(input: RunEvalObserverPersistenceInput): void {
  const enabled = input.isEnabled ?? isObserverEnabled;
  const shouldObserve = input.shouldObserve ?? shouldObserveSession;
  if (!enabled() || !shouldObserve(input.sessionKey)) return;

  try {
    const lastAssistant = input.history.filter((message) => message.role === "assistant").at(-1);
    const observedTurn = buildObservedTurn({
      sessionKey: input.sessionKey,
      requestId: input.requestId,
      inputMessages: input.history
        .filter((message) => message.role !== "assistant")
        .slice(-20)
        .map(toEvalMessage),
      response: lastAssistant ? toEvalMessage(lastAssistant) : null,
      governorDecision: input.snapshot.governor ? {
        pause: input.snapshot.governor.pause,
        reason: input.snapshot.governor.reason ?? "",
        matchedRules: input.snapshot.governor.matchedRules,
        telemetry: input.snapshot.governor.telemetry as Record<string, unknown>,
      } : undefined,
    });
    const transcriptEvent = buildTranscriptEvent(observedTurn);
    input.recordSessionEvent({
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      eventKind: transcriptEvent.eventKind,
      component: transcriptEvent.component,
      detail: transcriptEvent.detail,
      requestId: input.requestId,
      metadataJson: transcriptEvent.metadataJson,
    });

    const liveEvent = buildLiveEvalEvent(observedTurn);
    if (liveEvent) {
      input.recordSessionEvent({
        sessionKey: input.sessionKey,
        userId: input.userId,
        orgId: input.orgId,
        eventKind: liveEvent.eventKind,
        component: liveEvent.component,
        detail: liveEvent.detail,
        requestId: input.requestId,
        metadataJson: liveEvent.metadataJson,
      });
    }
  } catch (err) {
    input.warn?.(err);
  }
}
