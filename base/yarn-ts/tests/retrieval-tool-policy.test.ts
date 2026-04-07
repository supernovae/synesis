import { describe, expect, it } from "vitest";
import {
  buildRetrievalPolicyToolPromptFragment,
  mergeToolSystemPrompts,
} from "../src/retrieval-tool-policy.js";

describe("retrieval-tool-policy", () => {
  it("returns no fragment when Synesis retrieval tools are absent", () => {
    expect(buildRetrievalPolicyToolPromptFragment([])).toBeUndefined();
    expect(
      buildRetrievalPolicyToolPromptFragment([
        { type: "function", function: { name: "Read", description: "x" } },
      ]),
    ).toBeUndefined();
  });

  it("returns policy when knowledge search tool is present", () => {
    const fragment = buildRetrievalPolicyToolPromptFragment([
      { type: "function", function: { name: "synesis_knowledge_search", description: "x" } },
    ]);
    expect(fragment).toContain("synesis_knowledge_search");
    expect(fragment).toContain("fetch_pages");
  });

  it("mergeToolSystemPrompts combines adapter and retrieval fragments", () => {
    const merged = mergeToolSystemPrompts("Adapter line.", "Retrieval line.");
    expect(merged).toBe("Adapter line.\n\nRetrieval line.");
  });

  it("mergeToolSystemPrompts returns undefined when both empty", () => {
    expect(mergeToolSystemPrompts(undefined, undefined)).toBeUndefined();
  });
});
