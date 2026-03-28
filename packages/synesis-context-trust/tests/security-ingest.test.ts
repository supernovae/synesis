import { describe, it, expect } from "vitest";
import { scanResultToPayload, policyRejectToPayload } from "../src/security-ingest.js";
import type { ScanResult } from "../src/scanner.js";

describe("scanResultToPayload", () => {
  it("maps a scan result to ingest payload", () => {
    const result: ScanResult = {
      detected: true,
      patterns_found: ["ignore previous instructions"],
      source: "user_message",
      excerpt: "please ignore previous instructions...",
      tier: "core",
      confidence: 0.65,
      event_type: "system_override_attempt",
    };
    const payload = scanResultToPayload(result, {
      service: "yarn",
      requestId: "req-123",
      sessionId: "sess-456",
      userId: "user-1",
      orgId: "org-1",
      actionTaken: "log",
    });
    expect(payload.event_type).toBe("system_override_attempt");
    expect(payload.service).toBe("yarn");
    expect(payload.severity).toBe("medium");
    expect(payload.confidence_band).toBe("medium");
    expect(payload.scanner_name).toBe("synesis_guardrails_ts");
    expect(payload.patterns_found).toEqual(["ignore previous instructions"]);
  });

  it("assigns high severity for high-confidence jailbreak", () => {
    const result: ScanResult = {
      detected: true,
      patterns_found: ["DAN mode enabled", "pretend you are", "ignore all"],
      source: "user_message",
      excerpt: "...",
      tier: "core",
      confidence: 0.85,
      event_type: "jailbreak_roleplay",
    };
    const payload = scanResultToPayload(result, {
      service: "planner",
      requestId: "req-789",
      actionTaken: "block",
    });
    expect(payload.severity).toBe("high");
    expect(payload.confidence_band).toBe("high");
    expect(payload.action_taken).toBe("block");
  });
});

describe("policyRejectToPayload", () => {
  it("creates a policy reject event", () => {
    const payload = policyRejectToPayload("Too many consecutive tool calls", {
      service: "yarn",
      requestId: "req-999",
      sessionId: "sess-111",
      userId: "user-2",
      orgId: "org-2",
    });
    expect(payload.event_type).toBe("yarn_policy_reject");
    expect(payload.severity).toBe("medium");
    expect(payload.action_taken).toBe("block");
    expect(payload.scanner_name).toBe("deterministic_policy_engine");
  });
});
