import { describe, it, expect } from "vitest";
import {
  TrustPacketV1,
  serializeStableJson,
  parseTrustPacket,
  makeTrustedControl,
  makeUntrusted,
  makeSemiTrusted,
} from "../src/trust-packet.js";

describe("TrustPacketV1", () => {
  it("validates a well-formed packet", () => {
    const packet = makeUntrusted("hello world", "user_message");
    const result = TrustPacketV1.safeParse(packet);
    expect(result.success).toBe(true);
  });

  it("rejects invalid trust_level", () => {
    const result = TrustPacketV1.safeParse({
      schema_version: 1,
      trust_level: "invalid",
      source_type: "user_message",
      instruction_execution_allowed: false,
      content_purpose: "data",
      content: "test",
    });
    expect(result.success).toBe(false);
  });

  it("round-trips through serialize/parse", () => {
    const packet = makeUntrusted("test content", "tool_result", {
      sourceId: "sess-123",
      contentPurpose: "data",
      sanitization: ["truncated"],
      imperativeLikelihood: 0.3,
    });
    const json = serializeStableJson(packet);
    const parsed = parseTrustPacket(json);
    expect(parsed.trust_level).toBe("untrusted");
    expect(parsed.source_type).toBe("tool_result");
    expect(parsed.content).toBe("test content");
    expect(parsed.sanitization_applied).toEqual(["truncated"]);
    expect(parsed.imperative_likelihood).toBe(0.3);
  });

  it("produces deterministic key order", () => {
    const a = serializeStableJson(makeUntrusted("x", "user_message"));
    const b = serializeStableJson(makeUntrusted("x", "user_message"));
    expect(a).toBe(b);
    const keys = Object.keys(JSON.parse(a));
    expect(keys[0]).toBe("schema_version");
    expect(keys[1]).toBe("trust_level");
  });

  it("builds trusted control packets correctly", () => {
    const packet = makeTrustedControl("System prompt text");
    expect(packet.trust_level).toBe("trusted");
    expect(packet.instruction_execution_allowed).toBe(true);
    expect(packet.content_purpose).toBe("instruction");
  });

  it("builds semi-trusted packets correctly", () => {
    const packet = makeSemiTrusted("Summary of prior turns", "session_continuity");
    expect(packet.trust_level).toBe("semi_trusted");
    expect(packet.instruction_execution_allowed).toBe(false);
    expect(packet.content_purpose).toBe("summary");
  });
});
