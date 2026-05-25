import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  createRouteToolCallSideEffects,
  type RouteToolCallSideEffects,
  type RouteToolCallSideEffectsInput,
  type RouteToolCallSideEffectsSession,
} from "./route-tool-call-side-effects.js";
import {
  createStreamAbortRuntime,
  type StreamAbortRuntime,
} from "./stream-abort-runtime.js";
import {
  captureStreamRequestForensics,
  type StreamRequestForensicsMessage,
} from "./stream-request-forensics.js";
import type { StreamRouteEvent, StreamRouteScope } from "./stream-route-scope.js";
import type { ClaudeStreamRouteGatesResult } from "./claude-stream-route-gates.js";

type ClaudeStreamRouteStarted = Extract<ClaudeStreamRouteGatesResult, { ok: true }>;

export interface ClaudeStreamRouteRuntimeInput<TSession extends RouteToolCallSideEffectsSession, TForensics> {
  started: ClaudeStreamRouteStarted;
  requestIds: {
    traceRequestId: string;
    responseRequestId: string;
  };
  resolvedModelId: string;
  messages: StreamRequestForensicsMessage[];
  tools: unknown[];
  toolChoice: unknown;
  providerOptions: unknown;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  captureRequestForensics(
    sessionKey: string,
    requestId: string,
    path: string,
    providerModel: string,
    stream: boolean,
    messages: StreamRequestForensicsMessage[],
    tools: unknown[] | undefined,
    toolChoice: unknown,
    providerOptions: unknown,
    phasePolicy?: RequestForensicsRecord["phasePolicy"],
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
  ): TForensics;
  sideEffects: Omit<
    RouteToolCallSideEffectsInput<TSession>,
    "sessionKey" | "userId" | "orgId" | "requestId" | "upperHarnessComponent"
  >;
  abort: {
    longWaitEventMs: number;
    hardTimeoutMs: number;
  };
}

export interface ClaudeStreamRouteRuntimeResult<TForensics> {
  streamSpan: ClaudeStreamRouteStarted["span"];
  startedAtMs: number;
  streamScope: StreamRouteScope;
  responseScope: StreamRouteScope;
  recordStreamEvent(event: StreamRouteEvent): void;
  admissionRelease(): void;
  streamForensics: TForensics;
  streamToolSideEffects: RouteToolCallSideEffects;
  streamAbortRuntime: StreamAbortRuntime;
}

export function createClaudeStreamRouteRuntime<TSession extends RouteToolCallSideEffectsSession, TForensics>(
  input: ClaudeStreamRouteRuntimeInput<TSession, TForensics>,
): ClaudeStreamRouteRuntimeResult<TForensics> {
  const streamScope = input.started.scope;
  const recordStreamEvent = input.started.recordEvent;
  const streamForensics = captureStreamRequestForensics({
    scope: streamScope,
    path: "/v1/messages (stream)",
    resolvedModelId: input.resolvedModelId,
    messages: input.messages,
    tools: input.tools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
    phasePolicy: input.phasePolicy,
    capabilityMatrix: input.capabilityMatrix,
    capture: input.captureRequestForensics,
  });
  const streamToolSideEffects = createRouteToolCallSideEffects({
    ...input.sideEffects,
    sessionKey: streamScope.sessionKey,
    userId: streamScope.userId,
    orgId: streamScope.orgId,
    requestId: input.requestIds.traceRequestId,
    upperHarnessComponent: "upper-harness:claude-stream",
  });
  const streamAbortRuntime = createStreamAbortRuntime({
    protocolLabel: "Claude",
    model: input.resolvedModelId,
    startedAtMs: input.started.startedAtMs,
    longWaitEventMs: input.abort.longWaitEventMs,
    hardTimeoutMs: input.abort.hardTimeoutMs,
    recordSessionEvent: recordStreamEvent,
  });

  return {
    streamSpan: input.started.span,
    startedAtMs: input.started.startedAtMs,
    streamScope,
    responseScope: {
      ...streamScope,
      requestId: input.requestIds.responseRequestId,
    },
    recordStreamEvent,
    admissionRelease: () => input.started.admission.release!(),
    streamForensics,
    streamToolSideEffects,
    streamAbortRuntime,
  };
}
