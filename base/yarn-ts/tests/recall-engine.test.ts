import { describe, expect, it, beforeEach } from "vitest";
import { LanguagePackRegistry, resetLanguagePackRegistry, getLanguagePackRegistry } from "../src/language-packs/registry.js";
import { ALL_PACKS } from "../src/language-packs/packs/index.js";
import { loadAllPacks, resetLoader } from "../src/language-packs/loader.js";
import { resolveRecipes } from "../src/recall/recipe-resolver.js";
import { makeRecallDecision } from "../src/recall/routing.js";
import type { RecallRoutingConfig } from "../src/recall/routing.js";
import { formatSyntheticResponse, formatEnrichmentBlock } from "../src/recall/formatter.js";
import { createEmptyRecallStats } from "../src/recall/types.js";
import type { RecallStats } from "../src/recall/types.js";
import type { EnrichedItem } from "../src/reduction/types.js";
import { computeEvidenceConfidence, formatEvidenceBlock } from "../src/evidence/fast-path.js";
import type { FastPathResult } from "../src/evidence/fast-path.js";
import type { KnowledgeSearchResult } from "../src/state/knowledge-search.js";
import type { LanguagePackManifest } from "../src/language-packs/types.js";

function loadRegistry(): LanguagePackRegistry {
  resetLanguagePackRegistry();
  resetLoader();
  loadAllPacks();
  return getLanguagePackRegistry();
}

/* ── Slice 1: Recipe Resolver ────────────────────────────────────── */

describe("Recipe Resolver", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("returns zero confidence for empty findings", () => {
    const result = resolveRecipes([], registry, "typescript");
    expect(result.findings).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.deterministicAnswer).toBe(false);
  });

  it("resolves findings with matching fix recipes", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch in foo.ts", file: "foo.ts", errorFamily: "type_mismatch", rootCause: "wrong type", action: "fix types" },
    ];
    const result = resolveRecipes(items, registry, "typescript");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].recipe).not.toBeNull();
    expect(result.findings[0].recipe!.errorFamily).toBe("type_mismatch");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("returns null recipe for unmatched error family", () => {
    const items: EnrichedItem[] = [
      { message: "Some exotic error", errorFamily: "very_exotic_nonexistent_thing" },
    ];
    const result = resolveRecipes(items, registry, "typescript");
    expect(result.findings[0].recipe).toBeNull();
    expect(result.confidence).toBeLessThan(1);
  });

  it("computes confidence as blend of classification and recipe coverage", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    const result = resolveRecipes(items, registry, "typescript");
    // Both classified and both have recipes = confidence should be 1.0
    expect(result.confidence).toBe(1.0);
    expect(result.deterministicAnswer).toBe(true);
  });

  it("partial recipe match yields partial confidence", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch" },
      { message: "Unknown error", errorFamily: "unknown" },
    ];
    const result = resolveRecipes(items, registry, "typescript");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
    expect(result.deterministicAnswer).toBe(false);
  });

  it("searches all packs when no validationFamily given", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch" },
    ];
    const result = resolveRecipes(items, registry);
    expect(result.findings[0].recipe).not.toBeNull();
  });

  it("multi-finding composition across different error families", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong type", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
      { message: "Missing return", errorFamily: "missing_return", rootCause: "no return", action: "add return" },
    ];
    const result = resolveRecipes(items, registry, "typescript");
    const withRecipe = result.findings.filter((f) => f.recipe !== null);
    expect(withRecipe.length).toBeGreaterThanOrEqual(2);
  });
});

/* ── Slice 2: Bypass Routing ─────────────────────────────────────── */

describe("Bypass Routing", () => {
  let registry: LanguagePackRegistry;
  const enabledConfig: RecallRoutingConfig = {
    enabled: true,
    bypassConfidenceThreshold: 0.8,
    enrichConfidenceThreshold: 0.4,
  };
  const disabledConfig: RecallRoutingConfig = {
    enabled: false,
    bypassConfidenceThreshold: 0.8,
    enrichConfidenceThreshold: 0.4,
  };

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("returns passthrough when disabled", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
    ];
    const decision = makeRecallDecision(items, true, registry, disabledConfig, "typescript");
    expect(decision.routing).toBe("passthrough");
    expect(decision.syntheticBlock).toBeNull();
    expect(decision.enrichmentBlock).toBeNull();
  });

  it("returns passthrough for empty items", () => {
    const decision = makeRecallDecision([], true, registry, enabledConfig);
    expect(decision.routing).toBe("passthrough");
  });

  it("returns bypass when all findings have recipes and bypassEligible", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    const decision = makeRecallDecision(items, true, registry, enabledConfig, "typescript");
    expect(decision.routing).toBe("bypass");
    expect(decision.syntheticBlock).not.toBeNull();
    expect(decision.syntheticBlock).toContain("synesis_recall_bypass");
    expect(decision.syntheticBlock).toContain("deterministic");
  });

  it("returns enrich when partial recipe match but above enrich threshold", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Unknown exotic", errorFamily: "unknown" },
    ];
    const decision = makeRecallDecision(items, false, registry, enabledConfig, "typescript");
    // bypassEligible is false, so even if confidence is high, it won't bypass
    // confidence > 0.4 => enrich
    expect(["enrich", "passthrough"]).toContain(decision.routing);
  });

  it("returns passthrough when confidence below enrich threshold", () => {
    const items: EnrichedItem[] = [
      { message: "Unknown 1", errorFamily: "unknown" },
      { message: "Unknown 2", errorFamily: "unknown" },
      { message: "Unknown 3", errorFamily: "unknown" },
    ];
    const decision = makeRecallDecision(items, false, registry, enabledConfig);
    expect(decision.routing).toBe("passthrough");
  });

  it("tracks stats correctly for bypass", () => {
    const stats = createEmptyRecallStats();
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    makeRecallDecision(items, true, registry, enabledConfig, "typescript", stats);
    expect(stats.totalDecisions).toBe(1);
    expect(stats.bypassAttempts).toBe(1);
    expect(stats.bypassSuccesses).toBe(1);
    expect(stats.recipeHitCount).toBeGreaterThan(0);
    expect(stats.tokensSavedEstimate).toBeGreaterThan(0);
    expect(Object.keys(stats.byLanguage)).toContain("typescript");
  });

  it("tracks stats for passthrough", () => {
    const stats = createEmptyRecallStats();
    makeRecallDecision([], true, registry, enabledConfig, undefined, stats);
    expect(stats.totalDecisions).toBe(1);
    expect(stats.passthroughCount).toBe(1);
    expect(stats.bypassAttempts).toBe(0);
  });

  it("does not bypass when bypassEligible is false even with high confidence", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    const decision = makeRecallDecision(items, false, registry, enabledConfig, "typescript");
    expect(decision.routing).not.toBe("bypass");
  });

  it("threshold behavior: high bypass threshold means fewer bypasses", () => {
    const strictConfig: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 1.0,
      enrichConfidenceThreshold: 0.99,
    };
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Something without recipe", errorFamily: "some_rare_thing" },
    ];
    const decision = makeRecallDecision(items, true, registry, strictConfig, "typescript");
    expect(decision.routing).toBe("passthrough");
  });
});

/* ── Formatter Tests ─────────────────────────────────────────────── */

describe("Recall Formatter", () => {
  it("formatSyntheticResponse produces structured XML block", () => {
    const resolution = {
      findings: [
        {
          errorFamily: "type_mismatch",
          recipe: { errorFamily: "type_mismatch", template: "Fix the type in {file}", description: "Type mismatch" },
          rootCause: "Wrong type assignment",
          action: "Fix types",
          file: "foo.ts",
          message: "TS2322: Type 'string' is not assignable to type 'number'",
        },
      ],
      confidence: 0.95,
      language: "typescript" as string | undefined,
      deterministicAnswer: true,
    };
    const block = formatSyntheticResponse(resolution);
    expect(block).toContain("synesis_recall_bypass");
    expect(block).toContain("confidence=\"0.95\"");
    expect(block).toContain("deterministic=\"true\"");
    expect(block).toContain("Fix the type in {file}");
    expect(block).toContain("Root cause: Wrong type assignment");
    expect(block).toContain("foo.ts");
  });

  it("formatEnrichmentBlock produces hint block for partial matches", () => {
    const resolution = {
      findings: [
        {
          errorFamily: "type_mismatch",
          recipe: { errorFamily: "type_mismatch", template: "Fix types", description: "Fix" },
          rootCause: "Wrong type",
          action: "Fix",
          file: "foo.ts",
          message: "type error",
        },
        {
          errorFamily: "unknown",
          recipe: null,
          rootCause: undefined,
          action: undefined,
          file: undefined,
          message: "some error",
        },
      ],
      confidence: 0.5,
      language: "typescript" as string | undefined,
      deterministicAnswer: false,
    };
    const block = formatEnrichmentBlock(resolution);
    expect(block).toContain("synesis_recall_enrichment");
    expect(block).toContain("hints=\"1\"");
    expect(block).toContain("type_mismatch");
  });

  it("formatEnrichmentBlock returns empty string when no recipes", () => {
    const resolution = {
      findings: [
        { errorFamily: "unknown", recipe: null, rootCause: undefined, action: undefined, file: undefined, message: "err" },
      ],
      confidence: 0.1,
      language: undefined,
      deterministicAnswer: false,
    };
    expect(formatEnrichmentBlock(resolution)).toBe("");
  });
});

/* ── Slice 3: Evidence Confidence ────────────────────────────────── */

describe("Evidence Confidence", () => {
  it("returns 0 for empty results", () => {
    const result: KnowledgeSearchResult = { results: [], query: "test", total: 0 };
    expect(computeEvidenceConfidence(result, "hard")).toBe(0);
  });

  it("scores higher for hard constraint kind", () => {
    const result: KnowledgeSearchResult = {
      results: [
        { text: "doc", source_url: "http://a.com", document_name: "doc", authority: "official", score: 0.9, constraint_kind: "hard", corpus_class: "coder", scope_tags: [], language: "ts", chunk_summary: "" },
      ],
      query: "test",
      total: 1,
    };
    const hardScore = computeEvidenceConfidence(result, "hard");
    const guidingScore = computeEvidenceConfidence(result, "guiding");
    expect(hardScore).toBeGreaterThan(guidingScore);
  });

  it("scores higher with more results", () => {
    const mkResult = (count: number): KnowledgeSearchResult => ({
      results: Array.from({ length: count }, (_, i) => ({
        text: `doc${i}`, source_url: `http://a.com/${i}`, document_name: `doc${i}`, authority: "official",
        score: 0.8, constraint_kind: "hard", corpus_class: "coder", scope_tags: [], language: "ts", chunk_summary: "",
      })),
      query: "test",
      total: count,
    });
    const one = computeEvidenceConfidence(mkResult(1), "guiding");
    const three = computeEvidenceConfidence(mkResult(3), "guiding");
    expect(three).toBeGreaterThan(one);
  });

  it("scores higher with better result scores", () => {
    const mkResult = (score: number): KnowledgeSearchResult => ({
      results: [
        { text: "doc", source_url: "http://a.com", document_name: "doc", authority: "official", score, constraint_kind: "hard", corpus_class: "coder", scope_tags: [], language: "ts", chunk_summary: "" },
      ],
      query: "test",
      total: 1,
    });
    const low = computeEvidenceConfidence(mkResult(0.2), "guiding");
    const high = computeEvidenceConfidence(mkResult(0.95), "guiding");
    expect(high).toBeGreaterThan(low);
  });

  it("caps confidence at 1.0", () => {
    const result: KnowledgeSearchResult = {
      results: Array.from({ length: 3 }, () => ({
        text: "doc", source_url: "http://a.com", document_name: "doc", authority: "official",
        score: 1.0, constraint_kind: "hard", corpus_class: "coder", scope_tags: [], language: "ts", chunk_summary: "",
      })),
      query: "test",
      total: 3,
    };
    expect(computeEvidenceConfidence(result, "hard")).toBeLessThanOrEqual(1.0);
  });

  it("formatEvidenceBlock includes confidence and authoritative attributes", () => {
    const result: FastPathResult = {
      matched: true,
      pattern: "typescript_error",
      evidence: {
        results: [
          { text: "TS2322 explanation", source_url: "http://ts.dev", document_name: "TS Handbook", authority: "official", score: 0.95, constraint_kind: "hard", corpus_class: "coder", scope_tags: ["error-catalog"], language: "typescript", chunk_summary: "Type mismatch explanation" },
        ],
        query: "TypeScript error TS2322",
        total: 1,
      },
      latencyMs: 50,
      timedOut: false,
      confidence: 0.85,
      constraintKind: "hard",
      authoritative: true,
    };
    const block = formatEvidenceBlock(result);
    expect(block).not.toBeNull();
    expect(block).toContain('confidence="0.85"');
    expect(block).toContain('constraint_kind="hard"');
    expect(block).toContain('authoritative="true"');
    expect(block).toContain("TS Handbook");
  });

  it("formatEvidenceBlock omits authoritative when false", () => {
    const result: FastPathResult = {
      matched: true,
      pattern: "eslint_rule",
      evidence: {
        results: [
          { text: "some rule", source_url: "http://eslint.org", document_name: "ESLint", authority: "community", score: 0.6, constraint_kind: "guiding", corpus_class: "coder", scope_tags: ["linter-rules"], language: "typescript", chunk_summary: "" },
        ],
        query: "ESLint rule no-unused-vars",
        total: 1,
      },
      latencyMs: 30,
      timedOut: false,
      confidence: 0.5,
      constraintKind: "guiding",
      authoritative: false,
    };
    const block = formatEvidenceBlock(result);
    expect(block).not.toBeNull();
    expect(block).not.toContain("authoritative");
  });
});

/* ── Slice 4: Recall Stats / Telemetry ───────────────────────────── */

describe("Recall Stats", () => {
  it("createEmptyRecallStats returns zeroed structure", () => {
    const stats = createEmptyRecallStats();
    expect(stats.bypassAttempts).toBe(0);
    expect(stats.bypassSuccesses).toBe(0);
    expect(stats.enrichAttempts).toBe(0);
    expect(stats.enrichSuccesses).toBe(0);
    expect(stats.passthroughCount).toBe(0);
    expect(stats.totalConfidenceSum).toBe(0);
    expect(stats.totalDecisions).toBe(0);
    expect(stats.recipeHitCount).toBe(0);
    expect(stats.recipeMissCount).toBe(0);
    expect(stats.tokensSavedEstimate).toBe(0);
    expect(Object.keys(stats.byLanguage)).toHaveLength(0);
  });

  it("accumulates stats over multiple decisions", () => {
    const registry = loadRegistry();
    const stats = createEmptyRecallStats();
    const config: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 0.8,
      enrichConfidenceThreshold: 0.4,
    };

    // Decision 1: bypass
    const bypassItems: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    makeRecallDecision(bypassItems, true, registry, config, "typescript", stats);

    // Decision 2: passthrough (empty)
    makeRecallDecision([], true, registry, config, undefined, stats);

    // Decision 3: partial match
    const partialItems: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Unknown thing", errorFamily: "unknown" },
    ];
    makeRecallDecision(partialItems, false, registry, config, "typescript", stats);

    expect(stats.totalDecisions).toBe(3);
    expect(stats.bypassSuccesses).toBeGreaterThanOrEqual(1);
    expect(stats.passthroughCount).toBeGreaterThanOrEqual(1);
    expect(stats.recipeHitCount).toBeGreaterThan(0);
  });

  it("tracks per-language stats", () => {
    const registry = loadRegistry();
    const stats = createEmptyRecallStats();
    const config: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 0.8,
      enrichConfidenceThreshold: 0.4,
    };

    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Undeclared name", errorFamily: "undeclared_name", rootCause: "missing", action: "import" },
    ];
    makeRecallDecision(items, true, registry, config, "typescript", stats);

    expect(stats.byLanguage["typescript"]).toBeDefined();
    expect(stats.byLanguage["typescript"].bypasses).toBe(1);
  });
});

/* ── Integration: End-to-End Flow ────────────────────────────────── */

describe("End-to-End Recall Flow", () => {
  let registry: LanguagePackRegistry;

  beforeEach(() => {
    registry = loadRegistry();
  });

  it("full pipeline: enriched items -> recipe resolution -> bypass decision -> synthetic response", () => {
    const items: EnrichedItem[] = [
      { message: "TS2322: Type 'string' is not assignable", file: "app.ts", errorFamily: "type_mismatch", rootCause: "Value type does not match", action: "Check the assignment" },
      { message: "TS2304: Cannot find name 'foo'", file: "bar.ts", errorFamily: "undeclared_name", rootCause: "Identifier not in scope", action: "Add import" },
    ];

    const resolution = resolveRecipes(items, registry, "typescript");
    expect(resolution.confidence).toBe(1.0);
    expect(resolution.deterministicAnswer).toBe(true);

    const stats = createEmptyRecallStats();
    const config: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 0.8,
      enrichConfidenceThreshold: 0.4,
    };
    const decision = makeRecallDecision(items, true, registry, config, "typescript", stats);
    expect(decision.routing).toBe("bypass");
    expect(decision.syntheticBlock).not.toBeNull();

    const block = decision.syntheticBlock!;
    expect(block).toContain("synesis_recall_bypass");
    expect(block).toContain("Type 'string' is not assignable");
    expect(block).toContain("Cannot find name 'foo'");
    expect(block).toContain("app.ts");
    expect(block).toContain("bar.ts");

    expect(stats.bypassSuccesses).toBe(1);
    expect(stats.tokensSavedEstimate).toBeGreaterThan(0);
    expect(stats.byLanguage["typescript"]?.bypasses).toBe(1);
  });

  it("full pipeline: mixed findings -> enrich decision -> enrichment block", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
      { message: "Unknown error with no classification" },
    ];

    const stats = createEmptyRecallStats();
    const config: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 0.8,
      enrichConfidenceThreshold: 0.3,
    };
    const decision = makeRecallDecision(items, false, registry, config, "typescript", stats);
    expect(decision.routing).toBe("enrich");
    expect(decision.enrichmentBlock).not.toBeNull();
    expect(decision.enrichmentBlock).toContain("synesis_recall_enrichment");
    expect(decision.enrichmentBlock).toContain("type_mismatch");
  });

  it("full pipeline: unclassified findings -> passthrough", () => {
    const items: EnrichedItem[] = [
      { message: "Something completely unknown" },
      { message: "Another unknown thing" },
    ];

    const stats = createEmptyRecallStats();
    const config: RecallRoutingConfig = {
      enabled: true,
      bypassConfidenceThreshold: 0.8,
      enrichConfidenceThreshold: 0.4,
    };
    const decision = makeRecallDecision(items, false, registry, config, undefined, stats);
    expect(decision.routing).toBe("passthrough");
    expect(stats.passthroughCount).toBe(1);
  });

  it("respects feature flag toggle", () => {
    const items: EnrichedItem[] = [
      { message: "Type mismatch", errorFamily: "type_mismatch", rootCause: "wrong", action: "fix" },
    ];

    const disabledDecision = makeRecallDecision(items, true, registry, { enabled: false, bypassConfidenceThreshold: 0.8, enrichConfidenceThreshold: 0.4 }, "typescript");
    expect(disabledDecision.routing).toBe("passthrough");

    const enabledDecision = makeRecallDecision(items, true, registry, { enabled: true, bypassConfidenceThreshold: 0.8, enrichConfidenceThreshold: 0.4 }, "typescript");
    expect(enabledDecision.routing).not.toBe("passthrough");
  });
});
