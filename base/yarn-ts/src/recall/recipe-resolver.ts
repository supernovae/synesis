/**
 * Recipe Resolver — matches enriched findings to language-pack fix recipes
 * and computes a confidence score representing how much of the problem set
 * can be deterministically addressed without LLM inference.
 */

import type { LanguagePackRegistry } from "../language-packs/registry.js";
import type { FixRecipe } from "../language-packs/types.js";
import type { EnrichedItem } from "../reduction/types.js";
import type { ValidationFamily } from "../validation/types.js";
import type { RecallResolution, ResolvedFinding } from "./types.js";

/**
 * Resolve a set of enriched findings against the language pack fix recipes.
 *
 * Confidence = (findings with recipe match) / totalFindings.
 * A resolution is deterministic when confidence === 1.0 (every finding has a recipe).
 */
export function resolveRecipes(
  items: EnrichedItem[],
  registry: LanguagePackRegistry,
  validationFamily?: string,
): RecallResolution {
  if (items.length === 0) {
    return { findings: [], confidence: 0, language: undefined, deterministicAnswer: false };
  }

  const pack = validationFamily
    ? registry.getByFamily(validationFamily as ValidationFamily)
    : undefined;

  const allPacks = registry.getAllPacks();

  const resolved: ResolvedFinding[] = items.map((item) => {
    const recipe = findRecipe(item.errorFamily, pack?.fixRecipes, allPacks);
    return {
      errorFamily: item.errorFamily ?? "unknown",
      recipe,
      rootCause: item.rootCause,
      action: item.action,
      file: item.file,
      message: item.message,
    };
  });

  const recipeMatches = resolved.filter((r) => r.recipe !== null).length;
  const classifiedCount = resolved.filter((r) => r.errorFamily !== "unknown").length;
  const classificationRatio = items.length > 0 ? classifiedCount / items.length : 0;
  const recipeRatio = items.length > 0 ? recipeMatches / items.length : 0;

  // Composite confidence: weighted blend of classification coverage and recipe coverage
  const confidence = classificationRatio * 0.4 + recipeRatio * 0.6;

  return {
    findings: resolved,
    confidence,
    language: pack?.language,
    deterministicAnswer: confidence >= 1.0,
  };
}

function findRecipe(
  errorFamily: string | undefined,
  packRecipes: FixRecipe[] | undefined,
  allPacks: { fixRecipes: FixRecipe[] }[],
): FixRecipe | null {
  if (!errorFamily || errorFamily === "unknown") return null;

  if (packRecipes) {
    const found = packRecipes.find((r) => r.errorFamily === errorFamily);
    if (found) return found;
  }

  for (const p of allPacks) {
    const found = p.fixRecipes.find((r) => r.errorFamily === errorFamily);
    if (found) return found;
  }

  return null;
}
