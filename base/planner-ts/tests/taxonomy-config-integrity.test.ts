import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfigWithPlugins, resetOntologyStore } from "../src/ontology/merge-plugins.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLANNER_ROOT = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PLANNER_ROOT, "../..");
const TAXONOMY_PATH = resolve(PLANNER_ROOT, "config/taxonomy_prompt_config.yaml");
const BOOTSTRAP_TAXONOMY_PATH = resolve(REPO_ROOT, "bootstrap/taxonomy/taxonomy_prompt_config.yaml");
const HELM_TAXONOMY_PATH = resolve(REPO_ROOT, "charts/synesis/files/admin/taxonomy_prompt_config.yaml");
const CORE_WEIGHTS_PATH = resolve(PLANNER_ROOT, "config/intent_weights.yaml");
const PLUGIN_WEIGHTS_DIR = resolve(PLANNER_ROOT, "config/plugins/weights");

interface TaxonomyEntry {
  path?: unknown;
  complexity?: unknown;
  calibration_guidance?: unknown;
  regulated_domain?: unknown;
  writer_regulated_block?: unknown;
  critic_regulated_block?: unknown;
}

function readTaxonomy(path = TAXONOMY_PATH): Record<string, TaxonomyEntry> {
  const parsed = parseYaml(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid taxonomy YAML: ${path}`);
  }
  return parsed as Record<string, TaxonomyEntry>;
}

describe("taxonomy config integrity", () => {
  it("keeps planner, bootstrap, and Helm taxonomy seeds synchronized", () => {
    const canonical = readFileSync(TAXONOMY_PATH, "utf-8");

    expect(readFileSync(BOOTSTRAP_TAXONOMY_PATH, "utf-8")).toBe(canonical);
    expect(readFileSync(HELM_TAXONOMY_PATH, "utf-8")).toBe(canonical);
  });

  it("routes only to taxonomy keys that exist", () => {
    resetOntologyStore();
    const taxonomyKeys = new Set(Object.keys(readTaxonomy()));
    const snapshot = loadConfigWithPlugins(CORE_WEIGHTS_PATH, PLUGIN_WEIGHTS_DIR);
    const missingTargets = new Set<string>();

    for (const entry of Object.values(snapshot.domainKeywords)) {
      if (!taxonomyKeys.has(entry.domain)) {
        missingTargets.add(entry.domain);
      }
    }
    for (const pairing of snapshot.pairings) {
      if (pairing.domain && !taxonomyKeys.has(pairing.domain)) {
        missingTargets.add(pairing.domain);
      }
    }
    expect([...missingTargets].sort()).toEqual([]);
  });

  it("keeps high-complexity entries calibrated", () => {
    const taxonomy = readTaxonomy();
    const missingCalibration = Object.entries(taxonomy)
      .filter(([, entry]) => Number(entry.complexity ?? 0) >= 0.8)
      .filter(([, entry]) => typeof entry.calibration_guidance !== "string" || !entry.calibration_guidance.trim())
      .map(([key]) => key)
      .sort();

    expect(missingCalibration).toEqual([]);
  });

  it("keeps regulated entries explicit for writer and critic behavior", () => {
    const taxonomy = readTaxonomy();
    const missingBlocks = Object.entries(taxonomy)
      .filter(([, entry]) => entry.regulated_domain === true)
      .filter(([, entry]) => {
        return (
          typeof entry.writer_regulated_block !== "string" ||
          !entry.writer_regulated_block.trim() ||
          typeof entry.critic_regulated_block !== "string" ||
          !entry.critic_regulated_block.trim()
        );
      })
      .map(([key]) => key)
      .sort();

    expect(missingBlocks).toEqual([]);
  });
});
