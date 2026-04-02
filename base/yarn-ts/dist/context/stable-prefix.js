import crypto from "node:crypto";
const BASE_INSTRUCTIONS = "You are an AI coding assistant provided by Synesis.";
export class StablePrefixService {
    stats = {
        partitionsBuilt: 0,
        prefixCacheHits: 0,
        uniquePrefixHashes: 0
    };
    knownHashes = new Set();
    sessionPrefixCache = new Map();
    resolvePromptBlocks(snapshot, ctx) {
        if (!snapshot || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.assignments)) {
            return { blocks: [], profileIds: [], profileHashes: [] };
        }
        const profileById = new Map();
        for (const p of snapshot.profiles)
            profileById.set(p.id, p);
        const orderedTargets = [
            ["default", "*"],
            ["tier", ctx?.tier],
            ["model_family", ctx?.modelFamily],
            ["role", ctx?.role],
            ["node", ctx?.node],
        ];
        const outBlocks = [];
        const outIds = [];
        const outHashes = [];
        const seenProfileIds = new Set();
        for (const [targetType, targetValue] of orderedTargets) {
            if (!targetValue)
                continue;
            const match = snapshot.assignments.find((a) => a.target_type === targetType && a.target_value === targetValue);
            if (!match || seenProfileIds.has(match.profile_id))
                continue;
            const profile = profileById.get(match.profile_id);
            if (!profile || !profile.content.trim())
                continue;
            seenProfileIds.add(profile.id);
            outIds.push(profile.id);
            outHashes.push(profile.content_hash);
            outBlocks.push(profile.content);
        }
        return { blocks: outBlocks, profileIds: outIds, profileHashes: outHashes };
    }
    partition(sessionKey, adapterBlock, promptSnapshot, promptContext) {
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
        }
        else {
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
    evictSession(sessionKey) {
        this.sessionPrefixCache.delete(sessionKey);
    }
    getStats() {
        return { ...this.stats };
    }
}
