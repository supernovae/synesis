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

  it("builds pack filters (v16)", () => {
    const expr = buildMetadataFilter({ pack_ids: ["Go 1.26", "python-3.13"], package_name: "net/http" });
    expect(expr).toContain('pack_id in ["go-1-26", "python-3-13"]');
    expect(expr).toContain('package_name == "net/http"');
  });

  it("builds single artifact_kind filter", () => {
    const expr = buildMetadataFilter({ artifact_kind: "code" });
    expect(expr).toBe('artifact_kind == "code"');
  });

  it("builds equality corpus_class filter (v14)", () => {
    const expr = buildMetadataFilter({ corpus_class: "coder_enriched" });
    expect(expr).toBe('corpus_class == "coder_enriched"');
  });

  it("builds equality constraint_kind filter (v14)", () => {
    const expr = buildMetadataFilter({ constraint_kind: "hard" });
    expect(expr).toBe('constraint_kind == "hard"');
  });

  it("builds equality content_profile filter (v14)", () => {
    const expr = buildMetadataFilter({ content_profile: "reference" });
    expect(expr).toBe('content_profile == "reference"');
  });

  it("builds equality constraint_source filter (v14)", () => {
    const expr = buildMetadataFilter({ constraint_source: "typescript-spec" });
    expect(expr).toBe('constraint_source == "typescript-spec"');
  });

  it("builds equality golden_path_id filter (v14)", () => {
    const expr = buildMetadataFilter({ golden_path_id: "backstage/react-template" });
    expect(expr).toBe('golden_path_id == "backstage/react-template"');
  });

  it("builds scope_tags filters via like on scope_tags column (v14)", () => {
    const expr = buildMetadataFilter({ scope_tags: ["error-catalog", "linter-rules"] });
    expect(expr).toBe('scope_tags like "%error-catalog%" and scope_tags like "%linter-rules%"');
  });

  it("combines multiple filters with AND", () => {
    const expr = buildMetadataFilter({
      language: "rust",
      artifact_kind: "docs",
      constraint_kind: "guiding",
      content_profile: "reference",
    });
    expect(expr).toContain('language == "rust"');
    expect(expr).toContain('artifact_kind == "docs"');
    expect(expr).toContain('constraint_kind == "guiding"');
    expect(expr).toContain('content_profile == "reference"');
    expect(expr.split(" and ")).toHaveLength(4);
  });

  it("truncates long values", () => {
    const longLang = "a".repeat(100);
    const expr = buildMetadataFilter({ language: longLang });
    expect(expr).toContain(`language == "${"a".repeat(32)}"`);
  });

  it("caps scope_tags at 10", () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const expr = buildMetadataFilter({ scope_tags: tags });
    const matches = expr.match(/scope_tags like/g) ?? [];
    expect(matches.length).toBe(10);
  });

  it("escapes double quotes in values", () => {
    const expr = buildMetadataFilter({ domain: 'test"domain' });
    expect(expr).toBe('domain == "test\\"domain"');
  });

  it("preserves backward-compat raw tags filter", () => {
    const expr = buildMetadataFilter({ tags: "my-custom-tag" });
    expect(expr).toBe('tags like "%my-custom-tag%"');
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
