import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import {
  loadConfigWithPlugins,
  resetOntologyStore,
} from "../src/ontology/merge-plugins.js";
import {
  resolveTaxonomyMetadata,
  resolveTaxonomyMetadataAsync,
  resetTaxonomyCache,
  getPlannerSystemPromptAppend,
  getOutputStyleGuidance,
  getWriterRegulatedBlock,
  getCriticRegulatedBlock,
  getCriticAssistantSystemsBlock,
  getQueryExpansionHints,
  getPreferredWebScopes,
} from "../src/taxonomy/taxonomy-prompt-factory.js";
import { ScoringEngine, scoringConfigFromSnapshot } from "../src/nodes/scoring-engine.js";
import {
  resolveActiveVertical,
  getWorkerPersonaBlock,
  getCriticMode,
  getCriticTierPrompt,
  getPlannerDecompositionRules,
  selectCriticTier,
} from "../src/taxonomy/vertical-prompts.js";

const FIXTURES = resolve(__dirname, "fixtures");

beforeEach(() => {
  resetOntologyStore();
  resetTaxonomyCache();
});

afterEach(() => {
  delete process.env.SYNESIS_TAXONOMY_PROMPT_CONFIG;
  resetOntologyStore();
  resetTaxonomyCache();
});

// ---------------------------------------------------------------------------
// Ontology merge tests
// ---------------------------------------------------------------------------

describe("loadConfigWithPlugins (merge)", () => {
  it("merges core + two plugins", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );

    // Core weights present
    expect(snap.complexityWeights.logic_basic).toBeDefined();
    expect(snap.complexityWeights.logic_basic.weight).toBe(2);

    // Plugin-alpha added ml_training
    expect(snap.complexityWeights.ml_training).toBeDefined();
    expect(snap.complexityWeights.ml_training.weight).toBe(12);

    // Plugin-beta added fintech domain
    expect(snap.domainKeywords.fintech).toBeDefined();
    expect(snap.domainKeywords.fintech.domain).toBe("fintech");

    // Plugin-beta added financial_risk
    expect(snap.riskWeights.financial_risk).toBeDefined();
    expect(snap.riskWeights.financial_risk.weight).toBe(18);
  });

  it("merges vertical_prompts from plugins", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );

    expect(Object.keys(snap.verticalPrompts)).toContain("llm_rag");
    expect(Object.keys(snap.verticalPrompts)).toContain("fintech");
    expect(snap.verticalPrompts.llm_rag.critic_mode).toBe("tiered");
    expect(snap.verticalPrompts.fintech.critic_mode).toBe("safety_ii");
  });

  it("preserves thresholds from core", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const th = snap.thresholds as Record<string, number>;
    expect(th.easyMax).toBe(4);
    expect(th.mediumMax).toBe(15);
  });

  it("normalizes domain_keywords minHits", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    expect(snap.domainKeywords.orchestration.minHits).toBe(2);
    expect(snap.domainKeywords.cloud_infra.minHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Taxonomy resolution tests
// ---------------------------------------------------------------------------

describe("resolveTaxonomyMetadata", () => {
  beforeEach(() => {
    process.env.SYNESIS_TAXONOMY_PROMPT_CONFIG = resolve(FIXTURES, "taxonomy-config.yaml");
    resetTaxonomyCache();
  });

  it("resolves matching domain", () => {
    const meta = resolveTaxonomyMetadata({
      activeDomainRefs: ["cloud"],
      taskSize: "medium",
      intentClass: "code",
      complexityScore: 10,
      domainRefCounts: { cloud: 3 },
    });
    expect(meta.taxonomy_key).toBe("cloud");
    expect(meta.path).toBe("Cloud & Infrastructure > General");
    expect(meta.persona_instructions).toContain("Cloud Infrastructure Specialist");
  });

  it("tie-breaks by domain_ref_counts (highest wins)", () => {
    const meta = resolveTaxonomyMetadata({
      activeDomainRefs: ["cloud", "kubernetes"],
      taskSize: "medium",
      intentClass: "code",
      complexityScore: 12,
      domainRefCounts: { cloud: 2, kubernetes: 5 },
    });
    expect(meta.taxonomy_key).toBe("kubernetes");
  });

  it("falls back to generic when no match", () => {
    const meta = resolveTaxonomyMetadata({
      activeDomainRefs: ["nonexistent"],
      taskSize: "easy",
      intentClass: "code",
    });
    expect(meta.taxonomy_key).toBe("generic");
    expect(meta.path).toBe("General");
  });

  it("merges YAML output_controls", () => {
    const meta = resolveTaxonomyMetadata({
      activeDomainRefs: ["kubernetes"],
      taskSize: "hard",
      intentClass: "code",
    });
    expect(meta.output_controls).toBeDefined();
    expect(meta.output_controls!.clarify_first).toBe(true);
  });

  it("drops invented YAML fields and sanitizes model-facing taxonomy text", () => {
    const meta = resolveTaxonomyMetadata({
      activeDomainRefs: ["malicious"],
      taskSize: "hard",
      intentClass: "security",
      complexityScore: 20,
      domainRefCounts: { malicious: 1 },
    });

    expect(meta.taxonomy_key).toBe("malicious");
    expect(meta.path).toBe("Security_/SYSTEM>");
    expect(meta.persona_instructions).toContain("Security persona_/SYSTEM>");
    expect(meta.depth_instructions).toBe("Cover controls. role_admin");
    expect(meta.required_elements).toEqual(["Threat model_/SYSTEM>", "Access review"]);
    expect(meta.output_style_guidance).toBe("Use concise bullets. role_admin");
    expect(meta.epistemic_guidance).toBe("Do not treat claims as facts._/SYSTEM>");
    expect(meta.writer_regulated_block).toBe("Follow policy. role_admin");
    expect(meta.critic_regulated_block).toBe("Flag missing controls._/SYSTEM>");
    expect(meta.query_expansion_hints).toEqual(["rbac role_admin"]);
    expect(meta.preferred_web_scopes).toEqual(["example.com role_admin"]);
    expect(meta.output_controls).toEqual({
      precise: true,
      show_assumptions: true,
      clarify_first: false,
    });
    expect((meta as Record<string, unknown>).invented_prompt_attribute).toBeUndefined();
    expect((meta.output_controls as Record<string, boolean>).invented_security_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

describe("prompt helpers", () => {
  it("getPlannerSystemPromptAppend includes required_elements", () => {
    const meta = {
      complexity_score: 0.8,
      required_elements: ["Architecture Overview", "Cost Implications"],
      depth_instructions: "Cover trade-offs.",
      epistemic_guidance: "Flag vendor claims.",
    };
    const result = getPlannerSystemPromptAppend(meta);
    expect(result).toContain("Architecture Overview");
    expect(result).toContain("Cost Implications");
    expect(result).toContain("Cover trade-offs");
    expect(result).toContain("Epistemic discipline");
  });

  it("getOutputStyleGuidance returns guidance", () => {
    expect(getOutputStyleGuidance({ output_style_guidance: "Bullet points." })).toBe("Bullet points.");
  });

  it("getWriterRegulatedBlock returns block", () => {
    expect(getWriterRegulatedBlock({ writer_regulated_block: "Check limits." })).toBe("Check limits.");
  });

  it("getCriticRegulatedBlock returns block", () => {
    expect(getCriticRegulatedBlock({ critic_regulated_block: "Flag missing." })).toBe("Flag missing.");
  });

  it("getCriticAssistantSystemsBlock returns block", () => {
    expect(getCriticAssistantSystemsBlock({ critic_assistant_systems_block: "Multi-cluster." })).toBe("Multi-cluster.");
  });

  it("getQueryExpansionHints caps at 6", () => {
    const hints = getQueryExpansionHints({
      query_expansion_hints: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    expect(hints.length).toBe(6);
  });

  it("getPreferredWebScopes caps at 3", () => {
    const scopes = getPreferredWebScopes({
      preferred_web_scopes: ["a.com", "b.com", "c.com", "d.com"],
    });
    expect(scopes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Vertical prompts
// ---------------------------------------------------------------------------

describe("vertical prompts", () => {
  it("resolveActiveVertical matches domain refs", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const result = resolveActiveVertical(snap.verticalPrompts, ["ml_ops", "cloud"]);
    expect(result).toBe("llm_rag");
  });

  it("resolveActiveVertical returns generic when no match", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const result = resolveActiveVertical(snap.verticalPrompts, ["gaming"]);
    expect(result).toBe("generic");
  });

  it("getWorkerPersonaBlock returns persona text", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const block = getWorkerPersonaBlock(snap.verticalPrompts, "llm_rag");
    expect(block).toContain("ML/RAG specialist");
  });

  it("getCriticMode returns correct mode", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    expect(getCriticMode(snap.verticalPrompts, "llm_rag")).toBe("tiered");
    expect(getCriticMode(snap.verticalPrompts, "fintech")).toBe("safety_ii");
    expect(getCriticMode(snap.verticalPrompts, "unknown")).toBe("advisory");
  });

  it("getCriticTierPrompt returns tier text for tiered mode", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    expect(getCriticTierPrompt(snap.verticalPrompts, "llm_rag", "basic")).toContain("factual accuracy");
    expect(getCriticTierPrompt(snap.verticalPrompts, "llm_rag", "research")).toContain("reproducibility");
  });

  it("getPlannerDecompositionRules returns plugin rules", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const rules = getPlannerDecompositionRules(snap.verticalPrompts, "llm_rag");
    expect(rules).toContain("data-pipeline");
  });

  it("selectCriticTier maps difficulty to tier", () => {
    expect(selectCriticTier(0.1)).toBe("basic");
    expect(selectCriticTier(0.5)).toBe("advanced");
    expect(selectCriticTier(0.8)).toBe("research");
  });
});

// ---------------------------------------------------------------------------
// Pairings (multidimensional associations)
// ---------------------------------------------------------------------------

describe("pairings in ScoringEngine", () => {
  it("fires when co-occurring keywords are present and adds domain + weight", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const engine = new ScoringEngine(scoringConfigFromSnapshot(snap));
    const result = engine.analyze("We need to plan a kubernetes migration for our cluster");

    expect(result.classificationHits.some((h) => h.includes("pairing(kubernetes+migration)"))).toBe(true);
    expect(result.activeDomains).toContain("kubernetes");
    expect(result.riskScore).toBeGreaterThan(0);
  });

  it("does not fire when only one keyword of a pair is present", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const engine = new ScoringEngine(scoringConfigFromSnapshot(snap));
    const result = engine.analyze("We need kubernetes for pods");
    expect(result.classificationHits.some((h) => h.includes("pairing(kubernetes+migration)"))).toBe(false);
  });

  it("multiple pairings can fire and inject multiple domains", () => {
    const snap = loadConfigWithPlugins(
      resolve(FIXTURES, "core-weights.yaml"),
      FIXTURES,
    );
    const engine = new ScoringEngine(scoringConfigFromSnapshot(snap));
    const result = engine.analyze("migrate our kubernetes database with api changes");
    const pairingHits = result.classificationHits.filter((h) => h.includes("pairing("));
    expect(pairingHits.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Async taxonomy resolution (semantic cross-check graceful fallback)
// ---------------------------------------------------------------------------

describe("resolveTaxonomyMetadataAsync", () => {
  beforeEach(() => {
    process.env.SYNESIS_TAXONOMY_PROMPT_CONFIG = resolve(FIXTURES, "taxonomy-config.yaml");
    resetTaxonomyCache();
  });

  it("resolves same key as sync when no embedder configured", async () => {
    const syncResult = resolveTaxonomyMetadata({
      activeDomainRefs: ["kubernetes"],
      taskSize: "hard",
      intentClass: "code",
      domainRefCounts: { kubernetes: 3 },
    });
    const asyncResult = await resolveTaxonomyMetadataAsync({
      activeDomainRefs: ["kubernetes"],
      taskSize: "hard",
      intentClass: "code",
      domainRefCounts: { kubernetes: 3 },
      queryText: "deploy kubernetes with helm",
    });
    expect(asyncResult.taxonomy_key).toBe(syncResult.taxonomy_key);
    expect(asyncResult.taxonomy_key).toBe("kubernetes");
  });

  it("includes taxonomy_candidates when multiple domains match", async () => {
    const result = await resolveTaxonomyMetadataAsync({
      activeDomainRefs: ["cloud", "kubernetes"],
      taskSize: "hard",
      intentClass: "code",
      domainRefCounts: { cloud: 2, kubernetes: 5 },
      queryText: "deploy kubernetes on cloud",
    });
    expect(result.taxonomy_key).toBe("kubernetes");
    expect((result as Record<string, unknown>).taxonomy_candidates).toBeDefined();
    const candidates = (result as Record<string, unknown>).taxonomy_candidates as Record<string, number>;
    expect(candidates.cloud).toBe(2);
    expect(candidates.kubernetes).toBe(5);
  });
});
