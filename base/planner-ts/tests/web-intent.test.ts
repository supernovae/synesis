import { describe, expect, it } from "vitest";
import { analyzeLiveWebIntent } from "../src/nodes/web-intent.js";

describe("analyzeLiveWebIntent", () => {
  it("detects explicit web-search phrasing", () => {
    expect(
      analyzeLiveWebIntent(
        "Can you tell me the difference between minimax 2.5 and minimax 2.7 - please search the web if you need newer information.",
      ).needsLiveWeb,
    ).toBe(true);
  });

  it("detects newer-information / freshness cues", () => {
    expect(analyzeLiveWebIntent("Compare Foo 1.0 vs 2.0 using newer information.").needsLiveWeb).toBe(
      true,
    );
    expect(analyzeLiveWebIntent("What is the latest stable Kubernetes release?").needsLiveWeb).toBe(true);
  });

  it("detects weather + US zip", () => {
    expect(analyzeLiveWebIntent("weather today 78729").needsLiveWeb).toBe(true);
  });

  it("detects current news / headlines phrasing", () => {
    expect(analyzeLiveWebIntent("What is in the news today?").needsLiveWeb).toBe(true);
    expect(analyzeLiveWebIntent("Give me today's headlines").needsLiveWeb).toBe(true);
    expect(analyzeLiveWebIntent("News headlines for this week").needsLiveWeb).toBe(true);
  });

  it("returns false for generic trivia", () => {
    expect(analyzeLiveWebIntent("What is 2+2?").needsLiveWeb).toBe(false);
    expect(analyzeLiveWebIntent("hi").needsLiveWeb).toBe(false);
  });
});
