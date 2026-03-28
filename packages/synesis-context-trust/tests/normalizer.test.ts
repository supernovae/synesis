import { describe, it, expect } from "vitest";
import {
  normalizeConfusables,
  stripZeroWidth,
  normalizeForScan,
} from "../src/normalizer.js";

describe("normalizeConfusables", () => {
  it("maps Cyrillic lookalikes to ASCII", () => {
    // \u0430 = Cyrillic 'а' → 'a', \u0435 = 'е' → 'e'
    expect(normalizeConfusables("\u0430\u0435")).toBe("ae");
  });

  it("maps fullwidth lookalikes to ASCII", () => {
    // \uff49 = fullwidth 'ｉ' → 'i'
    expect(normalizeConfusables("\uff49gnore")).toBe("ignore");
  });

  it("preserves normal ASCII", () => {
    expect(normalizeConfusables("hello world")).toBe("hello world");
  });
});

describe("stripZeroWidth", () => {
  it("removes zero-width characters", () => {
    expect(stripZeroWidth("hel\u200blo")).toBe("hello");
    expect(stripZeroWidth("wo\u200c\u200drld")).toBe("world");
  });
});

describe("normalizeForScan", () => {
  it("combines confusable + zero-width normalization", () => {
    const text = "\u0430\u200b\u0435";
    expect(normalizeForScan(text)).toBe("ae");
  });
});
