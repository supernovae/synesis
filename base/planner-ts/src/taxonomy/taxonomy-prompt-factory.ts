/**
 * Taxonomy-driven contextual injection.
 *
 * Maps scoring engine output (active_domain_refs, intent_class) to taxonomy
 * node metadata from taxonomy_prompt_config.yaml.  No LLM — deterministic
 * lookup with optional embedding-based semantic cross-check.
 *
 * YAML fields are normalized through a known taxonomy contract before they
 * become planner metadata or model-facing prompt fragments.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxonomyNode {
  path: string;
  complexity: number;
  persona: string;
  worker_explain_tone?: string;
  depth_instructions?: string;
  discovery_prompt?: string;
  required_elements?: string[];
  output_style?: string;
  output_style_guidance?: string;
  epistemic_guidance?: string;
  regulated_domain?: boolean;
  writer_regulated_block?: string;
  critic_regulated_block?: string;
  critic_assistant_systems_block?: string;
  query_expansion_hints?: string[];
  preferred_web_scopes?: string[];
  router_summarizer_tone?: string;
  output_controls?: Record<string, boolean>;
  planner_decomposition_rules?: string;
  [key: string]: unknown;
}

export interface TaxonomyMetadata extends Record<string, unknown> {
  taxonomy_key: string;
  path: string;
  complexity_score: number;
  persona_instructions: string;
  required_bullets: number;
  required_elements: string[];
  depth_instructions: string;
  worker_explain_tone: string;
  discovery_prompt: string;
  query_expansion_hints: string[];
  preferred_web_scopes: string[];
  output_style: string;
  output_style_guidance: string;
  regulated_domain: boolean;
  output_controls?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// YAML loading with TTL cache
// ---------------------------------------------------------------------------

let _cached: Record<string, TaxonomyNode> | null = null;
let _cacheTs = 0;
const DEFAULT_TTL_S = 300;
const TEXT_LIMIT = 2000;
const SHORT_TEXT_LIMIT = 256;
const LIST_ITEM_LIMIT = 160;
const OUTPUT_CONTROL_KEYS = ["precise", "show_assumptions", "clarify_first"] as const;

function resolveTaxonomyPath(): string | null {
  const envPath = process.env.SYNESIS_TAXONOMY_PROMPT_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;
  const candidates = [
    resolve(process.cwd(), "base/planner-ts/config/taxonomy_prompt_config.yaml"),
    resolve(process.cwd(), "taxonomy_prompt_config.yaml"),
    resolve(process.cwd(), "config/taxonomy_prompt_config.yaml"),
    resolve(__dirname, "../../taxonomy_prompt_config.yaml"),
    resolve(__dirname, "../../../taxonomy_prompt_config.yaml"),
    resolve(__dirname, "../../../config/taxonomy_prompt_config.yaml"),
    resolve(__dirname, "../../../../base/planner-ts/config/taxonomy_prompt_config.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadTaxonomyConfig(): Record<string, TaxonomyNode> {
  const ttl = Number(process.env.SYNESIS_TAXONOMY_CACHE_TTL ?? DEFAULT_TTL_S);
  const now = Date.now() / 1000;
  if (_cached && (now - _cacheTs) < ttl) return _cached;

  const path = resolveTaxonomyPath();
  if (!path) {
    _cached = {};
    _cacheTs = now;
    return _cached;
  }

  try {
    const raw = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const nodes: Record<string, TaxonomyNode> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val && typeof val === "object" && !Array.isArray(val) && "path" in (val as Record<string, unknown>)) {
        nodes[key] = val as TaxonomyNode;
      }
    }
    _cached = nodes;
    _cacheTs = now;
    return nodes;
  } catch {
    if (_cached) return _cached;
    _cached = {};
    _cacheTs = now;
    return _cached;
  }
}

/** Reset for testing. */
export function resetTaxonomyCache(): void {
  _cached = null;
  _cacheTs = 0;
}

// ---------------------------------------------------------------------------
// Core resolution: resolveTaxonomyMetadata
// ---------------------------------------------------------------------------

interface ResolutionOpts {
  activeDomainRefs: string[];
  taskSize: string;
  intentClass: string;
  complexityScore?: number;
  domainRefCounts?: Record<string, number>;
  queryText?: string;
}

/**
 * Select keyword-based taxonomy key from active domain refs + ref counts.
 * Returns the key and the candidate scores for tracing.
 */
function selectKeywordKey(
  activeDomainRefs: string[],
  taxonomies: Record<string, TaxonomyNode>,
  domainRefCounts: Record<string, number>,
): { key: string; candidates: Record<string, number> } {
  const candidates: Record<string, number> = {};
  for (const ref of activeDomainRefs) {
    const r = ref.trim().toLowerCase();
    if (taxonomies[r]) {
      candidates[r] = domainRefCounts[r] ?? 1;
    }
  }

  if (Object.keys(candidates).length > 0) {
    const keys = Object.keys(candidates);
    const key = keys.reduce((best, k) => {
      if (candidates[k] > candidates[best]) return k;
      if (candidates[k] === candidates[best] && keys.indexOf(k) < keys.indexOf(best)) return k;
      return best;
    }, keys[0]);
    return { key, candidates };
  }
  return { key: "generic", candidates };
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? " " : char;
  }
  return out;
}

function safeTaxonomyText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return replaceControlCharsWithSpace(String(value))
    .replace(/[<"`=]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function safeTaxonomyList(value: unknown, maxItems: number, itemLimit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = safeTaxonomyText(item, itemLimit);
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeOutputControls(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key of OUTPUT_CONTROL_KEYS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildMetadataFromKey(
  key: string,
  taxonomies: Record<string, TaxonomyNode>,
  opts: ResolutionOpts,
): TaxonomyMetadata {
  const nodeCfg = taxonomies[key] ?? taxonomies.generic ?? {};

  const path = safeTaxonomyText(nodeCfg.path, SHORT_TEXT_LIMIT) || "General";
  const rawComplexity = Number(nodeCfg.complexity ?? 0.5);
  const complexityBase = Number.isFinite(rawComplexity)
    ? Math.max(0, Math.min(1, rawComplexity))
    : 0.5;
  const persona = safeTaxonomyText(nodeCfg.persona, TEXT_LIMIT) || "Helpful Assistant";
  const depthInstructions = safeTaxonomyText(nodeCfg.depth_instructions, TEXT_LIMIT);
  const requiredElements = Array.isArray(nodeCfg.required_elements)
    ? safeTaxonomyList(nodeCfg.required_elements, 12, LIST_ITEM_LIMIT)
    : ["Direct Answer"];
  let requiredBullets = requiredElements.length;

  const inputComplexity = opts.complexityScore ?? 0;
  const difficulty = inputComplexity > 0 ? Math.min(1.0, inputComplexity / 30.0) : complexityBase;
  const blendedComplexity = 0.4 * complexityBase + 0.6 * difficulty;

  if (difficulty < 0.15) {
    requiredBullets = Math.min(requiredBullets, 2);
  }

  let personaInstructions = persona;
  if (blendedComplexity > 0.55 && depthInstructions) {
    personaInstructions = `${persona}. ${depthInstructions}`;
  }

  return {
    path,
    complexity_score: blendedComplexity,
    persona_instructions: personaInstructions,
    required_bullets: requiredBullets,
    required_elements: requiredElements,
    depth_instructions: depthInstructions,
    worker_explain_tone: safeTaxonomyText(nodeCfg.worker_explain_tone, TEXT_LIMIT),
    discovery_prompt: safeTaxonomyText(nodeCfg.discovery_prompt, TEXT_LIMIT),
    taxonomy_key: key,
    query_expansion_hints: safeTaxonomyList(nodeCfg.query_expansion_hints, 6, LIST_ITEM_LIMIT),
    preferred_web_scopes: safeTaxonomyList(nodeCfg.preferred_web_scopes, 3, LIST_ITEM_LIMIT),
    output_style: safeTaxonomyText(nodeCfg.output_style, SHORT_TEXT_LIMIT),
    output_style_guidance: safeTaxonomyText(nodeCfg.output_style_guidance, TEXT_LIMIT),
    epistemic_guidance: safeTaxonomyText(nodeCfg.epistemic_guidance, TEXT_LIMIT),
    regulated_domain: Boolean(nodeCfg.regulated_domain),
    writer_regulated_block: safeTaxonomyText(nodeCfg.writer_regulated_block, TEXT_LIMIT),
    critic_regulated_block: safeTaxonomyText(nodeCfg.critic_regulated_block, TEXT_LIMIT),
    critic_assistant_systems_block: safeTaxonomyText(nodeCfg.critic_assistant_systems_block, TEXT_LIMIT),
    router_summarizer_tone: safeTaxonomyText(nodeCfg.router_summarizer_tone, SHORT_TEXT_LIMIT),
    output_controls: normalizeOutputControls(nodeCfg.output_controls),
    planner_decomposition_rules: safeTaxonomyText(nodeCfg.planner_decomposition_rules, TEXT_LIMIT),
  };
}

/** Synchronous taxonomy resolution (no embedding cross-check). */
export function resolveTaxonomyMetadata(opts: ResolutionOpts): TaxonomyMetadata {
  const taxonomies = loadTaxonomyConfig();
  const { key } = selectKeywordKey(opts.activeDomainRefs, taxonomies, opts.domainRefCounts ?? {});
  return buildMetadataFromKey(key, taxonomies, opts);
}

/**
 * Async taxonomy resolution with optional embedding-based semantic cross-check.
 * Only calls the embedder when SYNESIS_EMBEDDER_URL is configured and
 * keyword_key !== "generic". On failure, falls back to keyword key.
 */
export async function resolveTaxonomyMetadataAsync(opts: ResolutionOpts): Promise<TaxonomyMetadata> {
  const taxonomies = loadTaxonomyConfig();
  const { key: keywordKey, candidates } = selectKeywordKey(
    opts.activeDomainRefs,
    taxonomies,
    opts.domainRefCounts ?? {},
  );

  let finalKey = keywordKey;
  let semanticValidation: Record<string, unknown> | undefined;

  if (opts.queryText && keywordKey !== "generic") {
    try {
      const { validateTaxonomy } = await import("./semantic-taxonomy.js");
      const validation = await validateTaxonomy({
        query: opts.queryText,
        keywordKey,
        taxonomies: taxonomies as Record<string, Record<string, unknown>>,
      });
      if (validation.overridden) {
        finalKey = validation.recommendedKey;
      }
      semanticValidation = {
        overridden: validation.overridden,
        ambiguous: validation.ambiguous,
        keyword_key: validation.keywordKey,
        keyword_score: validation.keywordScore,
        semantic_top: validation.semanticTop,
      };
    } catch {
      // Embedder unavailable — keep keyword key
    }
  }

  const result = buildMetadataFromKey(finalKey, taxonomies, opts);

  if (semanticValidation) {
    (result as Record<string, unknown>).taxonomy_semantic = semanticValidation;
  }
  if (Object.keys(candidates).length > 1) {
    (result as Record<string, unknown>).taxonomy_candidates = candidates;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function isLargeModel(): boolean {
  return (process.env.SYNESIS_MODEL_CAPABILITY_TIER ?? "small") === "large";
}

export function getPlannerSystemPromptAppend(metadata: TaxonomyMetadata | Record<string, unknown>): string {
  if (!metadata) return "";
  const complexity = Number(metadata.complexity_score ?? 0.5);
  const requiredElements = (metadata.required_elements ?? []) as string[];
  const depthInstructions = String(metadata.depth_instructions ?? "").trim();

  const parts: string[] = [];
  if (requiredElements.length > 0) {
    parts.push(`Your plan MUST include these sections/steps: ${requiredElements.join("; ")}.`);
  }
  if (complexity > 0.7 && depthInstructions) {
    parts.push(depthInstructions);
  }
  const eg = String(metadata.epistemic_guidance ?? "").trim();
  if (complexity > 0.5 && eg) {
    parts.push(`Epistemic discipline for this domain: ${eg}`);
  }
  return parts.length > 0 ? "\n\n" + parts.join(" ") : "";
}

export function getOutputStyleGuidance(metadata: Record<string, unknown>): string {
  if (!metadata || isLargeModel()) return "";
  return String(metadata.output_style_guidance ?? "").trim();
}

export function getEpistemicGuidanceBlock(metadata: Record<string, unknown>): string {
  if (!metadata || isLargeModel()) return "";
  return String(metadata.epistemic_guidance ?? "").trim();
}

export function getWriterRegulatedBlock(metadata: Record<string, unknown>): string {
  if (!metadata) return "";
  return String(metadata.writer_regulated_block ?? "").trim();
}

export function getCriticRegulatedBlock(metadata: Record<string, unknown>): string {
  if (!metadata) return "";
  return String(metadata.critic_regulated_block ?? "").trim();
}

export function getCriticAssistantSystemsBlock(metadata: Record<string, unknown>): string {
  if (!metadata) return "";
  return String(metadata.critic_assistant_systems_block ?? "").trim();
}

export function getQueryExpansionHints(metadata: Record<string, unknown>): string[] {
  if (!metadata) return [];
  return (Array.isArray(metadata.query_expansion_hints) ? metadata.query_expansion_hints : [])
    .map(String)
    .slice(0, 6);
}

export function getPreferredWebScopes(metadata: Record<string, unknown>): string[] {
  if (!metadata) return [];
  return (Array.isArray(metadata.preferred_web_scopes) ? metadata.preferred_web_scopes : [])
    .map(String)
    .slice(0, 3);
}

export function getRouterSummarizerTone(metadata: Record<string, unknown>): string {
  if (!metadata) return "";
  return String(metadata.router_summarizer_tone ?? "").trim();
}

export function getWorkerExplainTone(metadata: Record<string, unknown>): string {
  if (!metadata || isLargeModel()) return "";
  return String(metadata.worker_explain_tone ?? "").trim();
}

export function getDiscoveryPrompt(metadata: Record<string, unknown>): string {
  if (!metadata || isLargeModel()) return "";
  return String(metadata.discovery_prompt ?? "").trim();
}

export function getExecutorDepthBlock(metadata: Record<string, unknown>): string {
  if (!metadata || isLargeModel()) return "";
  const depth = String(metadata.depth_instructions ?? "").trim();
  return depth ? `\n\nTaxonomy depth: ${depth}` : "";
}
