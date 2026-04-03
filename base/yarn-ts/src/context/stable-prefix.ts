import crypto from "node:crypto";

export interface PrefixPartition {
  stablePrefix: string;
  volatileSuffix: string;
  prefixHash: string;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
}

export interface StablePrefixStats {
  partitionsBuilt: number;
  prefixCacheHits: number;
  uniquePrefixHashes: number;
}

const BASE_INSTRUCTIONS =
  "You are an AI coding assistant provided by Synesis.";

interface PromptProfileLike {
  id: number;
  content: string;
  content_hash: string;
}

interface PromptAssignmentLike {
  target_type: string;
  target_value: string;
  profile_id: number;
}

interface PromptSnapshotLike {
  profiles: PromptProfileLike[];
  assignments: PromptAssignmentLike[];
}

export interface PromptCompositionContext {
  tier?: string;
  role?: string;
  modelFamily?: string;
  node?: string;
}

export class StablePrefixService {
  private stats: StablePrefixStats = {
    partitionsBuilt: 0,
    prefixCacheHits: 0,
    uniquePrefixHashes: 0
  };
  private knownHashes = new Set<string>();
  private sessionPrefixCache = new Map<string, string>();

  private resolvePromptBlocks(
    snapshot: PromptSnapshotLike | null | undefined,
    ctx: PromptCompositionContext | undefined,
  ): { blocks: string[]; profileIds: number[]; profileHashes: string[] } {
    if (!snapshot || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.assignments)) {
      return { blocks: [], profileIds: [], profileHashes: [] };
    }
    const profileById = new Map<number, PromptProfileLike>();
    for (const p of snapshot.profiles) profileById.set(p.id, p);

    const orderedTargets: Array<[string, string | undefined]> = [
      ["default", "*"],
      ["tier", ctx?.tier],
      ["model_family", ctx?.modelFamily],
      ["role", ctx?.role],
      ["node", ctx?.node],
    ];

    const outBlocks: string[] = [];
    const outIds: number[] = [];
    const outHashes: string[] = [];
    const seenProfileIds = new Set<number>();

    for (const [targetType, targetValue] of orderedTargets) {
      if (!targetValue) continue;
      const match = snapshot.assignments.find(
        (a) => a.target_type === targetType && a.target_value === targetValue,
      );
      if (!match || seenProfileIds.has(match.profile_id)) continue;
      const profile = profileById.get(match.profile_id);
      if (!profile || !profile.content.trim()) continue;
      seenProfileIds.add(profile.id);
      outIds.push(profile.id);
      outHashes.push(profile.content_hash);
      outBlocks.push(profile.content);
    }

    return { blocks: outBlocks, profileIds: outIds, profileHashes: outHashes };
  }

  partition(
    sessionKey: string,
    adapterBlock: string | undefined,
    promptSnapshot?: PromptSnapshotLike | null,
    promptContext?: PromptCompositionContext,
  ): PrefixPartition {
    const stableParts = [BASE_INSTRUCTIONS];
    const promptBlocks = this.resolvePromptBlocks(promptSnapshot, promptContext);
    if (promptBlocks.blocks.length > 0) {
      stableParts.push(...promptBlocks.blocks);
    }
    if (adapterBlock) {
      stableParts.push(adapterBlock);
    }
    const stablePrefix = stableParts.join("\n\n");

    const prefixHash = crypto
      .createHash("sha256")
      .update(stablePrefix)
      .digest("hex")
      .slice(0, 16);

    this.stats.partitionsBuilt++;

    const cachedHash = this.sessionPrefixCache.get(sessionKey);
    if (cachedHash === prefixHash) {
      this.stats.prefixCacheHits++;
    } else {
      this.sessionPrefixCache.set(sessionKey, prefixHash);
      if (!this.knownHashes.has(prefixHash)) {
        this.knownHashes.add(prefixHash);
        this.stats.uniquePrefixHashes++;
      }
    }

    return {
      stablePrefix,
      volatileSuffix: "",
      prefixHash,
      promptProfileIds: promptBlocks.profileIds,
      promptProfileHashes: promptBlocks.profileHashes,
    };
  }

  resolveBlocksForContext(
    promptSnapshot: PromptSnapshotLike | null | undefined,
    promptContext?: PromptCompositionContext,
  ): { blocks: string[]; profileIds: number[]; profileHashes: string[] } {
    return this.resolvePromptBlocks(promptSnapshot, promptContext);
  }

  resolveNodePromptBlock(
    promptSnapshot: PromptSnapshotLike | null | undefined,
    nodeName: string,
  ): { block: string | null; profileId?: number; profileHash?: string } {
    if (!promptSnapshot || !Array.isArray(promptSnapshot.profiles) || !Array.isArray(promptSnapshot.assignments)) {
      return { block: null };
    }
    const profileById = new Map<number, PromptProfileLike>();
    for (const p of promptSnapshot.profiles) profileById.set(p.id, p);
    const match = promptSnapshot.assignments.find(
      (a) => a.target_type === "node" && a.target_value === nodeName,
    );
    if (!match) return { block: null };
    const profile = profileById.get(match.profile_id);
    if (!profile || !profile.content.trim()) return { block: null };
    return { block: profile.content, profileId: profile.id, profileHash: profile.content_hash };
  }

  evictSession(sessionKey: string): void {
    this.sessionPrefixCache.delete(sessionKey);
  }

  getStats(): StablePrefixStats {
    return { ...this.stats };
  }
}
