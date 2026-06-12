/**
 * Semantic taxonomy validator — embedding-based cross-check for keyword classification.
 *
 * Uses cosine similarity between the query and pre-computed taxonomy node
 * embeddings to validate or override the keyword-based taxonomy key.
 *
 * Only active when SYNESIS_EMBEDDER_URL is configured. On any failure, returns
 * the keyword key unchanged (graceful degradation).
 */

import { embed, dotProduct, l2Normalize, type EmbedderConfig } from "../retrieval/embedder.js";
import { loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxonomyValidation {
  recommendedKey: string;
  keywordKey: string;
  semanticTop: Array<{ key: string; score: number }>;
  keywordScore: number;
  overridden: boolean;
  ambiguous: boolean;
}

// ---------------------------------------------------------------------------
// Lazy-loaded state: taxonomy keys + embedding matrix
// ---------------------------------------------------------------------------

let _taxonomyKeys: string[] = [];
let _taxonomyEmbeddings: number[][] = [];
let _loaded = false;

function composeDescription(key: string, node: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = String(node.path ?? "").trim();
  if (path) parts.push(path.replace(/ > /g, ": "));
  const persona = String(node.persona ?? "").trim();
  if (persona) parts.push(persona);
  const tone = String(node.worker_explain_tone ?? "").trim();
  if (tone) parts.push(tone);
  const hints = (Array.isArray(node.query_expansion_hints) ? node.query_expansion_hints : [])
    .map(String).slice(0, 10);
  if (hints.length > 0) parts.push(`Topics: ${hints.join(", ")}`);
  const elements = (Array.isArray(node.required_elements) ? node.required_elements : [])
    .map(String).slice(0, 8);
  if (elements.length > 0) parts.push(`Sections: ${elements.join(", ")}`);
  return parts.length > 0 ? parts.join(". ") : key;
}

function getEmbedderConfig(): EmbedderConfig | null {
  const cfg = loadConfig();
  if (!cfg.SYNESIS_EMBEDDER_URL) return null;
  return {
    url: cfg.SYNESIS_EMBEDDER_URL,
    model: cfg.SYNESIS_EMBEDDER_MODEL,
    timeoutMs: 10000,
  };
}

async function ensureLoaded(
  taxonomies: Record<string, Record<string, unknown>>,
): Promise<boolean> {
  if (_loaded) return _taxonomyEmbeddings.length > 0;
  _loaded = true;

  const embedCfg = getEmbedderConfig();
  if (!embedCfg) return false;

  const keys: string[] = [];
  const descriptions: string[] = [];
  for (const [key, node] of Object.entries(taxonomies)) {
    if (!node || typeof node !== "object" || !node.path) continue;
    keys.push(key);
    descriptions.push(composeDescription(key, node));
  }
  if (keys.length === 0) return false;

  try {
    const embeddings = await embed(descriptions, embedCfg);
    _taxonomyKeys = keys;
    _taxonomyEmbeddings = embeddings.map(l2Normalize);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function validateTaxonomy(opts: {
  query: string;
  keywordKey: string;
  taxonomies: Record<string, Record<string, unknown>>;
  topK?: number;
  overrideThreshold?: number;
}): Promise<TaxonomyValidation> {
  const { query, keywordKey, taxonomies, topK = 3, overrideThreshold = 0.15 } = opts;

  const result: TaxonomyValidation = {
    recommendedKey: keywordKey,
    keywordKey,
    semanticTop: [],
    keywordScore: 0,
    overridden: false,
    ambiguous: false,
  };

  if (!query || !query.trim()) return result;

  try {
    const loaded = await ensureLoaded(taxonomies);
    if (!loaded) return result;

    const embedCfg = getEmbedderConfig();
    if (!embedCfg) return result;

    const [queryEmb] = await embed([query.slice(0, 1000)], embedCfg);
    const normQuery = l2Normalize(queryEmb);

    const similarities = _taxonomyEmbeddings.map((emb) => dotProduct(emb, normQuery));

    const indexed = similarities.map((score, i) => ({ key: _taxonomyKeys[i], score, i }));
    indexed.sort((a, b) => b.score - a.score);
    const top = indexed.slice(0, topK);
    result.semanticTop = top.map((t) => ({ key: t.key, score: Math.round(t.score * 10000) / 10000 }));

    const kwIdx = _taxonomyKeys.indexOf(keywordKey);
    const kwScore = kwIdx >= 0 ? similarities[kwIdx] : 0;
    result.keywordScore = Math.round(kwScore * 10000) / 10000;

    if (top.length === 0) return result;

    const semTopKey = top[0].key;
    const semTopScore = top[0].score;

    if (semTopKey === keywordKey) {
      result.recommendedKey = keywordKey;
      return result;
    }

    const margin = semTopScore - kwScore;
    const topKeys = top.map((t) => t.key);

    if (!topKeys.includes(keywordKey) || margin > overrideThreshold) {
      result.recommendedKey = semTopKey;
      result.overridden = true;
    } else {
      result.recommendedKey = keywordKey;
      result.ambiguous = true;
    }

    return result;
  } catch {
    return result;
  }
}

export function invalidateSemanticCache(): void {
  _taxonomyKeys = [];
  _taxonomyEmbeddings = [];
  _loaded = false;
}
