import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { writeStatusEvent } from "../src/streaming/sse.js";

describe("writeStatusEvent", () => {
  it("emits Open WebUI-compatible nested status payload", () => {
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as ServerResponse;

    writeStatusEvent(res, {
      description: "Gathering evidence…",
      done: false,
      detail: "Searching sources and ranking relevance",
    });

    const line = chunks.join("");
    expect(line).toContain("data: ");
    const json = line.replace(/^data: /, "").trim();
    const parsed = JSON.parse(json) as {
      event: { type: string; data: { description: string; done: boolean; hidden: boolean; detail?: string } };
    };
    expect(parsed.event.type).toBe("status");
    expect(parsed.event.data.description).toBe("Gathering evidence…");
    expect(parsed.event.data.done).toBe(false);
    expect(parsed.event.data.hidden).toBe(false);
    expect(parsed.event.data.detail).toBe("Searching sources and ranking relevance");
  });
});
