import { describe, expect, it } from "vitest";
import { selectConversationContext } from "../src/context/context-selector.js";

describe("context selector", () => {
  it("keeps the latest user turn last and trims older non-referential history", () => {
    const result = selectConversationContext(
      [
        { role: "system", content: "policy" },
        { role: "user", content: "why do some people think llms are conscious" },
        { role: "assistant", content: "A long answer about consciousness theories." },
        { role: "user", content: "what is tokenization" },
        { role: "assistant", content: "Tokenization splits text into model units." },
        { role: "user", content: "is it a misnomer that MCPs are more safe than CLIs" },
      ],
      { enabled: true, recentTurns: 1 },
    );

    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages.at(-1)?.content).toContain("MCPs");
    expect(result.messages.map((message) => message.content)).not.toContain("why do some people think llms are conscious");
    expect(result.metadata.droppedHistoryMessages).toBeGreaterThan(0);
  });

  it("retains more context for referential follow-ups", () => {
    const result = selectConversationContext(
      [
        { role: "user", content: "why do some people think llms are conscious" },
        { role: "assistant", content: "They point to language, self-report, and behavior." },
        { role: "user", content: "what is tokenization" },
        { role: "assistant", content: "Tokenization splits text into model units." },
        { role: "user", content: "why do they say that?" },
      ],
      { enabled: true, recentTurns: 1 },
    );

    expect(result.metadata.mode).toBe("referential_followup");
    expect(result.messages.map((message) => message.content)).toContain("why do some people think llms are conscious");
    expect(result.messages.at(-1)?.content).toBe("why do they say that?");
  });

  it("does not treat every short standalone question as referential", () => {
    const result = selectConversationContext(
      [
        { role: "user", content: "why do some people think llms are conscious" },
        { role: "assistant", content: "They point to language, self-report, and behavior." },
        { role: "user", content: "what is tokenization" },
      ],
      { enabled: true, recentTurns: 1 },
    );

    expect(result.metadata.mode).not.toBe("referential_followup");
  });


  it("can be disabled without changing the input", () => {
    const input = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ];
    const result = selectConversationContext(input, { enabled: false, recentTurns: 1 });
    expect(result.messages).toBe(input);
    expect(result.metadata.enabled).toBe(false);
  });
});
