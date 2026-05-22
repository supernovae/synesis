import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runEvidencePrefetch,
  computeEvidenceConfidence,
  formatEvidenceBlock,
  detectPattern,
  getEvidencePrefetchStats,
  resetEvidencePrefetchStats,
  type FastPathResult,
} from "../src/evidence/fast-path.js";
import type { KnowledgeSearchResult } from "../src/state/knowledge-search.js";
import { loadAllPacks, resetLanguagePackRegistry, resetLoader } from "../src/language-packs/index.js";

function makeMockKnowledgeService(
  resolveImpl: (args: Record<string, unknown>) => Promise<KnowledgeSearchResult>,
) {
  return { resolve: vi.fn(resolveImpl) } as unknown as import("../src/state/knowledge-search.js").KnowledgeSearchService;
}

function makeResult(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    results: [
      {
        text: "TS2345 explanation",
        source_url: "https://ts.dev",
        document_name: "TS Error Catalog",
        authority: "official",
        score: 0.9,
        constraint_kind: "hard",
        corpus_class: "coder_enriched",
        scope_tags: ["error-catalog"],
        language: "typescript",
        context_prefix: "TypeScript errors",
        chunk_summary: "Argument type mismatch",
      },
    ],
    query: "TypeScript error TS2345",
    total: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetEvidencePrefetchStats();
  resetLanguagePackRegistry();
  resetLoader();
  loadAllPacks();
});

describe("runEvidencePrefetch", () => {
  it("returns matched=false for unrecognized text", async () => {
    const svc = makeMockKnowledgeService(async () => makeResult());
    const result = await runEvidencePrefetch("hello world", svc);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(svc.resolve).not.toHaveBeenCalled();
  });

  it("returns evidence for TypeScript error patterns", async () => {
    const svc = makeMockKnowledgeService(async () => makeResult());
    const result = await runEvidencePrefetch("error TS2345: Argument of type", svc, 2000);
    expect(result.matched).toBe(true);
    expect(result.evidence).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("returns timedOut=true when search exceeds timeout", async () => {
    const svc = makeMockKnowledgeService(
      () => new Promise((resolve) => setTimeout(() => resolve(makeResult()), 5000)),
    );
    const result = await runEvidencePrefetch("error TS2345: test", svc, 30);
    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.latencyMs).toBeLessThan(200);
  });

  it("handles network errors gracefully", async () => {
    const svc = makeMockKnowledgeService(async () => {
      throw new Error("Network error");
    });
    const result = await runEvidencePrefetch("error TS2345: test", svc, 2000);
    expect(result.matched).toBe(true);
  });

  it("returns empty evidence for zero results", async () => {
    const svc = makeMockKnowledgeService(async () => makeResult({ results: [], total: 0 }));
    const result = await runEvidencePrefetch("error TS2345: test", svc, 2000);
    expect(result.matched).toBe(true);
    expect(result.evidence).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it("drops low-confidence results below confidenceMin", async () => {
    const svc = makeMockKnowledgeService(async () =>
      makeResult({
        results: [{ ...makeResult().results[0], score: 0.1 }],
        total: 1,
      }),
    );
    const result = await runEvidencePrefetch("error TS2345: test", svc, 2000, 0.9);
    expect(result.matched).toBe(true);
    expect(result.evidence).toBeUndefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("retries on timeout when retryEnabled", async () => {
    let callCount = 0;
    const svc = makeMockKnowledgeService(async () => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => setTimeout(() => resolve(makeResult()), 5000));
      }
      return makeResult();
    });

    const result = await runEvidencePrefetch("error TS2345: test", svc, 30, 0.3, {
      retryEnabled: true,
      retryTimeoutMs: 2000,
    });
    expect(callCount).toBe(2);
    expect(result.matched).toBe(true);
    expect(result.evidence).toBeDefined();
  });

  it("tracks stats across calls", async () => {
    const svc = makeMockKnowledgeService(async () => makeResult());
    await runEvidencePrefetch("error TS2345: test", svc, 2000);
    await runEvidencePrefetch("hello world", svc, 2000);

    const stats = getEvidencePrefetchStats();
    expect(stats.attempts).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.totalConfidence).toBeGreaterThan(0);
  });
});

describe("computeEvidenceConfidence", () => {
  it("returns 0 for empty results", () => {
    expect(computeEvidenceConfidence({ results: [], query: "", total: 0 }, "hard")).toBe(0);
  });

  it("returns higher confidence for more results with high scores", () => {
    const single = computeEvidenceConfidence(makeResult(), "hard");
    const triple = computeEvidenceConfidence(
      {
        ...makeResult(),
        results: [makeResult().results[0], makeResult().results[0], makeResult().results[0]],
        total: 3,
      },
      "hard",
    );
    expect(triple).toBeGreaterThan(single);
  });

  it("hard constraints get a confidence boost", () => {
    const hard = computeEvidenceConfidence(makeResult(), "hard");
    const guiding = computeEvidenceConfidence(makeResult(), "guiding");
    expect(hard).toBeGreaterThan(guiding);
  });

  it("low-score results produce low confidence", () => {
    const result = makeResult({
      results: [{ ...makeResult().results[0], score: 0.1 }],
    });
    const confidence = computeEvidenceConfidence(result, "guiding");
    expect(confidence).toBeLessThan(0.5);
  });

  it("caps at 1.0", () => {
    const result = makeResult({
      results: [
        { ...makeResult().results[0], score: 1.0 },
        { ...makeResult().results[0], score: 1.0 },
        { ...makeResult().results[0], score: 1.0 },
      ],
      total: 3,
    });
    const confidence = computeEvidenceConfidence(result, "hard");
    expect(confidence).toBeLessThanOrEqual(1.0);
  });
});

describe("formatEvidenceBlock", () => {
  it("returns null for no evidence", () => {
    const result: FastPathResult = {
      matched: true,
      latencyMs: 10,
      timedOut: false,
      confidence: 0,
      authoritative: false,
    };
    expect(formatEvidenceBlock(result)).toBeNull();
  });

  it("returns null for zero-total evidence", () => {
    const result: FastPathResult = {
      matched: true,
      evidence: { results: [], query: "", total: 0 },
      latencyMs: 10,
      timedOut: false,
      confidence: 0.5,
      authoritative: false,
    };
    expect(formatEvidenceBlock(result)).toBeNull();
  });

  it("produces valid XML-ish structure", () => {
    const result: FastPathResult = {
      matched: true,
      pattern: "typescript_error",
      evidence: makeResult(),
      latencyMs: 50,
      timedOut: false,
      confidence: 0.85,
      constraintKind: "hard",
      authoritative: true,
    };
    const block = formatEvidenceBlock(result);
    expect(block).toContain("<synesis_evidence");
    expect(block).toContain("</synesis_evidence>");
    expect(block).toContain('pattern="typescript_error"');
    expect(block).toContain('confidence="0.85"');
    expect(block).toContain('authoritative="true"');
    expect(block).toContain('constraint_kind="hard"');
    expect(block).toContain("TS Error Catalog");
  });

  it("truncates long text to 500 chars when no chunk_summary", () => {
    const longText = "x".repeat(1000);
    const result: FastPathResult = {
      matched: true,
      pattern: "test",
      evidence: {
        results: [
          {
            text: longText,
            source_url: "http://test",
            document_name: "Test",
            authority: "official",
            score: 0.9,
            constraint_kind: "hard",
            corpus_class: "coder",
            scope_tags: [],
            language: "typescript",
            context_prefix: "",
            chunk_summary: "",
          },
        ],
        query: "test",
        total: 1,
      },
      latencyMs: 10,
      timedOut: false,
      confidence: 0.8,
      authoritative: false,
    };
    const block = formatEvidenceBlock(result)!;
    expect(block.length).toBeLessThan(longText.length);
  });
});

describe("detectPattern", () => {
  it("detects TypeScript errors", () => {
    const match = detectPattern("error TS2345: Argument of type 'string'");
    expect(match).not.toBeNull();
    expect(match!.language).toBe("typescript");
    expect(match!.constraint_kind).toBe("hard");
  });

  it("detects Rust errors", () => {
    const match = detectPattern("error[E0308]: mismatched types in rustc");
    expect(match).not.toBeNull();
    expect(match!.language).toBe("rust");
  });

  it("detects Python tracebacks", () => {
    const match = detectPattern("Traceback (most recent call last):");
    expect(match).not.toBeNull();
    expect(match!.language).toBe("python");
  });

  it("detects ESLint rules", () => {
    const match = detectPattern("@typescript-eslint/no-unused-vars");
    expect(match).not.toBeNull();
    expect(match!.constraint_kind).toBe("guiding");
  });

  it("returns null for non-matching text", () => {
    expect(detectPattern("just a normal sentence")).toBeNull();
  });

  it("detects Cobra / spf13 reference intent", () => {
    const match = detectPattern('Use import "github.com/spf13/cobra" for the CLI');
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("go_cobra_reference");
    expect(match!.language).toBe("go");
    expect(match!.scope_tags).toContain("package-tooling");
    expect(match!.constraint_kind).toBe("guiding");
  });

  it("detects kubectl reference intent without language filter", () => {
    const match = detectPattern("How do I set kubectl command line flags for plugins?");
    expect(match).not.toBeNull();
    expect(match!.pattern).toBe("kubectl_reference");
    expect(match!.language).toBe("");
  });
});
