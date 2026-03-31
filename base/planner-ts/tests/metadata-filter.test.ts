import { describe, it, expect } from "vitest";
import {
  buildMetadataFilter,
  buildCombinedFilter,
  extractTagMetadata,
} from "../src/retrieval/metadata-filter.js";

describe("buildMetadataFilter", () => {
  it("returns empty string for empty params", () => {
    expect(buildMetadataFilter({})).toBe("");
  });

  it("builds single language filter", () => {
    const expr = buildMetadataFilter({ language: "Python" });
    expect(expr).toBe('language == "python"');
  });

  it("builds single artifact_kind filter", () => {
    const expr = buildMetadataFilter({ artifact_kind: "code" });
    expect(expr).toBe('artifact_kind == "code"');
  });

  it("builds tags-based corpus_class filter", () => {
    const expr = buildMetadataFilter({ corpus_class: "coder_enriched" });
    expect(expr).toBe('tags like "%corpus_class:coder_enriched%"');
  });

  it("builds tags-based constraint_kind filter", () => {
    const expr = buildMetadataFilter({ constraint_kind: "hard" });
    expect(expr).toBe('tags like "%ck:hard%"');
  });

  it("builds scope_tags filters (AND)", () => {
    const expr = buildMetadataFilter({ scope_tags: ["error-catalog", "linter-rules"] });
    expect(expr).toBe('tags like "%scope:error-catalog%" and tags like "%scope:linter-rules%"');
  });

  it("combines multiple filters with AND", () => {
    const expr = buildMetadataFilter({
      language: "rust",
      artifact_kind: "docs",
      constraint_kind: "guiding",
    });
    expect(expr).toContain('language == "rust"');
    expect(expr).toContain('artifact_kind == "docs"');
    expect(expr).toContain('tags like "%ck:guiding%"');
    expect(expr.split(" and ")).toHaveLength(3);
  });

  it("truncates long values", () => {
    const longLang = "a".repeat(100);
    const expr = buildMetadataFilter({ language: longLang });
    expect(expr).toContain(`language == "${"a".repeat(32)}"`);
  });

  it("caps scope_tags at 10", () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const expr = buildMetadataFilter({ scope_tags: tags });
    const matches = expr.match(/scope:/g) ?? [];
    expect(matches.length).toBe(10);
  });

  it("escapes double quotes in values", () => {
    const expr = buildMetadataFilter({ domain: 'test"domain' });
    expect(expr).toBe('domain == "test\\"domain"');
  });
});

describe("buildCombinedFilter", () => {
  it("returns empty when both parts are empty", () => {
    const expr = buildCombinedFilter(undefined, {});
    expect(expr).toBe("");
  });

  it("returns metadata filter alone when no scope", () => {
    const expr = buildCombinedFilter(undefined, { language: "go" });
    expect(expr).toBe('language == "go"');
  });
});

describe("extractTagMetadata", () => {
  it("extracts all prefixed tags", () => {
    const result = extractTagMetadata(
      "corpus_class:coder_enriched,ck:hard,scope:error-catalog,scope:linter-rules,content_profile:reference,other-tag",
    );
    expect(result.corpus_class).toBe("coder_enriched");
    expect(result.constraint_kind).toBe("hard");
    expect(result.scope_tags).toEqual(["error-catalog", "linter-rules"]);
    expect(result.content_profile).toBe("reference");
  });

  it("returns empty defaults for empty string", () => {
    const result = extractTagMetadata("");
    expect(result.corpus_class).toBe("");
    expect(result.constraint_kind).toBe("");
    expect(result.scope_tags).toEqual([]);
    expect(result.content_profile).toBe("");
  });

  it("handles tags with spaces", () => {
    const result = extractTagMetadata(" ck:advisory , scope:build-tooling ");
    expect(result.constraint_kind).toBe("advisory");
    expect(result.scope_tags).toEqual(["build-tooling"]);
  });
});
