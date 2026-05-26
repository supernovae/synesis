import type { SessionState } from "../state/session-state.js";
import type { UsageWriter } from "../state/usage-writer.js";
import {
  buildRequestForensics,
  withUsage as withForensicsUsage,
  type RequestForensicsBuildResult,
  type RequestForensicsRecord,
} from "./request-forensics.js";

export type RequestForensicsMode = "off" | "lightweight" | "full";

export interface RequestForensicsRecorderOptions {
  mode: RequestForensicsMode;
  maxPreviewChars: number;
  usageWriter: UsageWriter;
}

export interface RequestForensicsUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface RequestForensicsRecorder {
  captureRequestForensics(
    sessionKey: string,
    requestId: string,
    path: string,
    providerModel: string,
    stream: boolean,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[] | undefined,
    toolChoice: unknown,
    providerOptions: unknown,
    phasePolicy?: RequestForensicsRecord["phasePolicy"],
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
  ): RequestForensicsBuildResult | null;

  finalizeRequestForensics(
    session: SessionState,
    requestId: string,
    forensics: RequestForensicsBuildResult | null,
    usage?: RequestForensicsUsage,
  ): RequestForensicsRecord | undefined;
}

export function createRequestForensicsRecorder(
  options: RequestForensicsRecorderOptions,
): RequestForensicsRecorder {
  const lastBySession = new Map<string, { requestId: string; serialized: string }>();

  return {
    captureRequestForensics(
      sessionKey,
      requestId,
      path,
      providerModel,
      stream,
      messages,
      tools,
      toolChoice,
      providerOptions,
      phasePolicy,
      capabilityMatrix,
    ) {
      if (options.mode === "off") return null;
      const previous = lastBySession.get(sessionKey);
      return buildRequestForensics({
        providerModel,
        path,
        requestId,
        stream,
        messages,
        tools,
        toolChoice,
        providerOptions,
        phasePolicy,
        capabilityMatrix,
        previous,
        capturePayload: options.mode === "full",
        maxPreviewChars: options.maxPreviewChars,
      });
    },

    finalizeRequestForensics(session, requestId, forensics, usage) {
      if (!forensics) return undefined;
      const record = usage ? withForensicsUsage(forensics.record, usage) : forensics.record;
      lastBySession.set(session.record.sessionKey, {
        requestId,
        serialized: forensics.serialized,
      });
      options.usageWriter.enqueueSessionEvent({
        sessionKey: session.record.sessionKey,
        requestId,
        userId: session.record.userId,
        orgId: session.record.orgId,
        eventKind: "request_forensics_v1",
        component: "yarn",
        detail: record.summary.slice(0, 2048),
        metadataJson: {
          schema_version: "request_forensics_v1",
          ...record,
        },
      });
      return record;
    },
  };
}
