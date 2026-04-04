import { describe, expect, it } from "vitest";
import { isMetadataTagsOnlyJson } from "../src/nodes/writer-metadata-guard.js";

describe("isMetadataTagsOnlyJson", () => {
  it("detects single tags array JSON", () => {
    expect(
      isMetadataTagsOnlyJson(
        '{"tags": ["Technology", "Artificial Intelligence", "Enterprise Software"]}',
      ),
    ).toBe(true);
  });

  it("rejects prose", () => {
    expect(isMetadataTagsOnlyJson("Here is the answer in plain text.")).toBe(false);
  });

  it("rejects JSON with extra keys", () => {
    expect(isMetadataTagsOnlyJson('{"tags": ["a"], "summary": "x"}')).toBe(false);
  });

  it("rejects empty tags", () => {
    expect(isMetadataTagsOnlyJson('{"tags": []}')).toBe(false);
  });
});
