import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  RequestDiagnosticRegistry,
  type RequestDiagnostic,
} from "../src/telemetry/request-diagnostics.js";

function makeConfig(ringMax = 2) {
  return loadConfig({
    SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: "false",
    SYNESIS_YARN_DIAGNOSTIC_RING_MAX: String(ringMax),
  } as never);
}

function diagnostic(requestId: string, timestamp: number): RequestDiagnostic {
  return {
    timestamp,
    requestId,
    sessionKey: "session_1",
    path: "/v1/chat/completions",
    systemMessageCount: 1,
    userMessageCount: 1,
    toolMessageCount: 0,
    totalInputChars: 10,
    toolDefinitionCount: 1,
    artifactToolInjected: false,
    knowledgeToolInjected: false,
    reducedToolResults: 0,
    finishReason: "stop",
    tokensIn: 10,
    tokensOut: 5,
    policyDecision: "",
    latencyMs: 10,
  };
}

describe("RequestDiagnosticRegistry", () => {
  it("keeps a bounded in-memory ring for recent diagnostics", async () => {
    const registry = new RequestDiagnosticRegistry(makeConfig(2));
    registry.push(diagnostic("req_1", 1));
    registry.push(diagnostic("req_2", 2));
    registry.push(diagnostic("req_3", 3));

    expect(registry.getRingStats()).toEqual({ max: 2, current: 2 });
    await expect(registry.listRecent()).resolves.toMatchObject({
      source: "memory",
      diagnostics: [
        expect.objectContaining({ requestId: "req_2" }),
        expect.objectContaining({ requestId: "req_3" }),
      ],
    });
    await registry.close();
  });

  it("finds diagnostics by request id from memory", async () => {
    const registry = new RequestDiagnosticRegistry(makeConfig(3));
    registry.push(diagnostic("req_1", 1));

    await expect(registry.getByRequestId("req_1")).resolves.toMatchObject({ requestId: "req_1" });
    await expect(registry.getByRequestId("missing")).resolves.toBeNull();
    await registry.close();
  });
});
