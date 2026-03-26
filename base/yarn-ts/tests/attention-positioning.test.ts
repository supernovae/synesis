import { describe, expect, it } from "vitest";
import { AttentionPositioningService } from "../src/context/attention-positioning.js";

describe("AttentionPositioningService", () => {
  function svc() {
    return new AttentionPositioningService();
  }

  it("passes through messages unchanged when no system blocks", () => {
    const s = svc();
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
    const result = s.position(msgs);
    expect(result.messages).toEqual(msgs);
    expect(result.beginBlockCount).toBe(0);
    expect(result.endBlockCount).toBe(0);
  });

  it("places architectural state at the beginning", () => {
    const s = svc();
    const msgs = [
      { role: "user", content: "hello" },
      { role: "system", content: "<ARCHITECTURAL_STATE>context</ARCHITECTURAL_STATE>" },
      { role: "assistant", content: "hi" }
    ];
    const result = s.position(msgs);
    expect((result.messages[0].content as string)).toContain("<ARCHITECTURAL_STATE>");
    expect(result.beginBlockCount).toBe(1);
  });

  it("places working frame at the beginning", () => {
    const s = svc();
    const msgs = [
      { role: "user", content: "hello" },
      { role: "system", content: "<WORKING_FRAME>goal=fix bug</WORKING_FRAME>" },
      { role: "assistant", content: "hi" }
    ];
    const result = s.position(msgs);
    expect((result.messages[0].content as string)).toContain("<WORKING_FRAME>");
    expect(result.beginBlockCount).toBe(1);
  });

  it("places client adapter at the beginning and manifest in the middle", () => {
    const s = svc();
    const msgs = [
      { role: "system", content: "<CLIENT_ADAPTER>cursor</CLIENT_ADAPTER>" },
      { role: "system", content: "<PROJECT_MANIFEST>languages=typescript</PROJECT_MANIFEST>" },
      { role: "user", content: "hello" }
    ];
    const result = s.position(msgs);
    expect((result.messages[0].content as string)).toContain("<CLIENT_ADAPTER>");
    expect(result.beginBlockCount).toBe(2);
  });

  it("preserves conversation order in the middle", () => {
    const s = svc();
    const msgs = [
      { role: "system", content: "<WORKING_FRAME>frame</WORKING_FRAME>" },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "system", content: "<ARCHITECTURAL_STATE>state</ARCHITECTURAL_STATE>" }
    ];
    const result = s.position(msgs);
    const nonSystem = result.messages.filter((m) => m.role !== "system");
    expect(nonSystem.map((m) => m.content)).toEqual(["msg1", "msg2", "msg3"]);
  });

  it("handles full enrichment scenario", () => {
    const s = svc();
    const msgs = [
      { role: "system", content: "Base instructions (stable prefix)" },
      { role: "system", content: "<CLIENT_ADAPTER>mode=ide</CLIENT_ADAPTER>" },
      { role: "system", content: "<PROJECT_MANIFEST>languages=ts</PROJECT_MANIFEST>" },
      { role: "system", content: "<WORKING_FRAME>goal=fix the test</WORKING_FRAME>" },
      { role: "system", content: "<ARCHITECTURAL_STATE>previous context</ARCHITECTURAL_STATE>" },
      { role: "user", content: "please fix the test" },
      { role: "assistant", content: "I'll look at it" }
    ];
    const result = s.position(msgs);

    const beginSystemBlocks = result.messages.filter(
      (m) => m.role === "system" && result.messages.indexOf(m) < result.messages.findIndex((x) => x.role === "user")
    );
    expect(beginSystemBlocks.some((m) => (m.content as string).includes("<ARCHITECTURAL_STATE>"))).toBe(true);
    expect(beginSystemBlocks.some((m) => (m.content as string).includes("<CLIENT_ADAPTER>"))).toBe(true);

    expect(beginSystemBlocks.some((m) => (m.content as string).includes("<WORKING_FRAME>"))).toBe(true);
  });

  it("tracks stats across calls", () => {
    const s = svc();
    s.position([
      { role: "system", content: "<WORKING_FRAME>f</WORKING_FRAME>" },
      { role: "user", content: "x" }
    ]);
    s.position([
      { role: "system", content: "<ARCHITECTURAL_STATE>s</ARCHITECTURAL_STATE>" },
      { role: "user", content: "y" }
    ]);
    const stats = s.getStats();
    expect(stats.positionedCount).toBe(2);
    expect(stats.endBlocksPlaced).toBe(0);
    expect(stats.beginBlocksPlaced).toBe(2);
  });
});
