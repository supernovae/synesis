import { describe, expect, it } from "vitest";
import {
  buildRetrievalPolicyToolPromptFragment,
  buildStdoutEfficiencyToolPromptFragment,
  buildVerificationDisciplineToolPromptFragment,
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

  it("returns stdout efficiency policy when shell tool is present", () => {
    const fragment = buildStdoutEfficiencyToolPromptFragment([
      { type: "function", function: { name: "Bash", description: "x" } },
    ]);
    expect(fragment).toContain("Shell output efficiency");
    expect(fragment).toContain("/tmp/_synesis_cmd_out.txt");
    expect(fragment).toContain("Do NOT re-run the same command");
  });

  it("returns no stdout efficiency policy when shell tools are absent", () => {
    expect(buildStdoutEfficiencyToolPromptFragment([])).toBeUndefined();
    expect(
      buildStdoutEfficiencyToolPromptFragment([
        { type: "function", function: { name: "Read", description: "x" } },
      ]),
    ).toBeUndefined();
  });

  it("returns verification discipline policy when verification tool is present", () => {
    const fragment = buildVerificationDisciplineToolPromptFragment([
      { type: "function", function: { name: "run_test", description: "x" } },
    ]);
    expect(fragment).toContain("Verification discipline");
    expect(fragment).toContain("Do NOT re-run the same test/build/lint command");
    expect(fragment).toContain("one focused edit");
  });

  it("returns verification discipline policy when shell execution tool is present", () => {
    const fragment = buildVerificationDisciplineToolPromptFragment([
      { type: "function", function: { name: "bash", description: "x" } },
    ]);
    expect(fragment).toContain("Verification discipline");
  });

  it("returns no verification discipline policy when neither test nor shell tools are present", () => {
    expect(
      buildVerificationDisciplineToolPromptFragment([
        { type: "function", function: { name: "Read", description: "x" } },
      ]),
    ).toBeUndefined();
  });

  it("mergeToolSystemPrompts combines adapter and retrieval fragments", () => {
    const merged = mergeToolSystemPrompts("Adapter line.", "Retrieval line.", "Stdout line.", "Verification line.");
    expect(merged).toBe("Adapter line.\n\nRetrieval line.\n\nStdout line.\n\nVerification line.");
  });

  it("mergeToolSystemPrompts returns undefined when both empty", () => {
    expect(mergeToolSystemPrompts(undefined, undefined)).toBeUndefined();
  });
});
