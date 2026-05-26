import type { generateText as generateTextFn } from "ai";

import type { AppConfig } from "../config.js";
import type { SawtoothContextManager } from "../context/sawtooth-manager.js";
import type { EffortTier, PhaseModelOrchestrator } from "../orchestration/phase-model-orchestrator.js";
import {
  fetchPublicOfferingsForYarn,
  fetchTierRegistrySnapshot,
  mergeYarnPublicOfferingsIntoTiers,
  resolveOfferingTierId,
  type PromptSnapshot,
  type RoleAssignmentConfig,
} from "../providers/admin-tier-registry.js";
import type { SynesisProviderRegistry } from "../providers/synesis-provider.js";

export interface TierRegistryRefresherOptions {
  config: AppConfig;
  generateText: typeof generateTextFn;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  phaseOrchestrator: PhaseModelOrchestrator;
  promptSnapshot: {
    set(snapshot: PromptSnapshot): void;
  };
  roleAssignmentRegistry: Map<string, RoleAssignmentConfig>;
  sawtooth: SawtoothContextManager;
  tierRegistry: SynesisProviderRegistry;
}

export function createTierRegistryRefresher(options: TierRegistryRefresherOptions): () => Promise<void> {
  const {
    config,
    generateText,
    logger,
    phaseOrchestrator,
    promptSnapshot,
    roleAssignmentRegistry,
    sawtooth,
    tierRegistry,
  } = options;

  return async () => {
    try {
      const snapshot = await fetchTierRegistrySnapshot(config);
      const publicOfferings = await fetchPublicOfferingsForYarn(config);
      const mergedTiers = mergeYarnPublicOfferingsIntoTiers(snapshot.tiers, publicOfferings);
      tierRegistry.updateTiers(mergedTiers);
      const offeringOrchestratorEntries: Array<{ clientId: string; tier: EffortTier }> = [];
      for (const o of publicOfferings) {
        const tier = resolveOfferingTierId(o);
        if (tier === "synesis-pulse" || tier === "synesis-core" || tier === "synesis-horizon") {
          offeringOrchestratorEntries.push({ clientId: o.client_model_id.trim().toLowerCase(), tier });
        }
      }
      phaseOrchestrator.setPublicOfferingTiers(offeringOrchestratorEntries);
      roleAssignmentRegistry.clear();
      for (const role of snapshot.roleAssignments) {
        roleAssignmentRegistry.set(role.role, role);
      }
      if (snapshot.promptSnapshot) {
        promptSnapshot.set(snapshot.promptSnapshot);
      }
      if (snapshot.tiers.length > 0) {
        logger.info({ tiers: snapshot.tiers.map((t) => t.id), auxiliaryRoles: snapshot.roleAssignments.length }, "tier_registry_refreshed");
        for (const t of snapshot.tiers) {
          if (!t.apiKey?.trim()) {
            logger.warn(
              { tier: t.id, baseUrl: t.baseUrl, backendModel: t.backendModel },
              "tier_missing_api_key_env — set the key in provider-api-keys secret (same namespace as yarn) or SYNESIS_YARN_OPENAI_COMPAT_API_KEY",
            );
          }
        }
      } else {
        logger.warn(
          {},
          "tier_registry_empty — no assigned coder-pulse / coder-core / coder-horizon / coder-compaction roles in admin, or role fetch returned none",
        );
      }
      const compactionTier = tierRegistry.getTierConfig("synesis-compaction");
      if (compactionTier) {
        sawtooth.setCompactFn(async (system: string, userPrompt: string) => {
          const { model } = tierRegistry.resolve("synesis-compaction", config.SYNESIS_YARN_DEFAULT_TIER);
          const result = await generateText({
            model: model as never,
            system,
            messages: [{ role: "user" as const, content: userPrompt }],
            maxOutputTokens: 2048,
          });
          return result.text;
        });
      } else {
        sawtooth.setCompactFn(null);
      }
    } catch (error) {
      logger.warn({ error }, "tier_registry_refresh_failed");
    }
  };
}
