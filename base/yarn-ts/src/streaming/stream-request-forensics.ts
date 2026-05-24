import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { StreamRouteScope } from "./stream-route-scope.js";

export interface StreamRequestForensicsMessage {
  role: string;
  content: unknown;
}

export interface StreamRequestForensicsInput<TForensics> {
  scope: StreamRouteScope;
  path: string;
  resolvedModelId: string;
  messages: StreamRequestForensicsMessage[];
  tools?: unknown[];
  toolChoice: unknown;
  providerOptions: unknown;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  capture(
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
}

export function captureStreamRequestForensics<TForensics>(
  input: StreamRequestForensicsInput<TForensics>,
): TForensics {
  return input.capture(
    input.scope.sessionKey,
    input.scope.requestId,
    input.path,
    input.resolvedModelId,
    true,
    input.messages,
    input.tools,
    input.toolChoice,
    input.providerOptions,
    input.phasePolicy,
    input.capabilityMatrix,
  );
}
