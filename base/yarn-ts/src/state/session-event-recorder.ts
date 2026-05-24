import type { SessionEventInsert } from "./usage-writer.js";

export interface SessionEventRecorderWriter {
  enqueueSessionEvent(event: SessionEventInsert): void;
}

export interface SessionEventRecorderLogger {
  warn(obj: Record<string, unknown>, message: string): void;
}

export type SessionEventRecorder = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId?: string,
  meta?: Record<string, unknown>,
) => void;

export interface CreateSessionEventRecorderInput {
  writer: SessionEventRecorderWriter;
  logger: SessionEventRecorderLogger;
}

export function createSessionEventRecorder(input: CreateSessionEventRecorderInput): SessionEventRecorder {
  const { writer, logger } = input;
  return (sessionKey, userId, orgId, eventKind, component, detail, requestId, meta) => {
    logger.warn(
      {
        sessionKey,
        requestId,
        component,
        eventKind,
        detail: detail.slice(0, 200),
      },
      `session_event: ${eventKind}`,
    );
    writer.enqueueSessionEvent({
      sessionKey,
      requestId,
      userId,
      orgId,
      eventKind,
      component,
      detail,
      metadataJson: meta,
    });
  };
}
