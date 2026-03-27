import crypto from "node:crypto";

export interface PrefixPartition {
  stablePrefix: string;
  volatileSuffix: string;
  prefixHash: string;
}

export interface StablePrefixStats {
  partitionsBuilt: number;
  prefixCacheHits: number;
  uniquePrefixHashes: number;
}

const BASE_INSTRUCTIONS =
  "You are an AI coding assistant provided by Synesis.";

export class StablePrefixService {
  private stats: StablePrefixStats = {
    partitionsBuilt: 0,
    prefixCacheHits: 0,
    uniquePrefixHashes: 0
  };
  private knownHashes = new Set<string>();
  private sessionPrefixCache = new Map<string, string>();

  partition(sessionKey: string, adapterBlock: string | undefined): PrefixPartition {
    const stableParts = [BASE_INSTRUCTIONS];
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

    return { stablePrefix, volatileSuffix: "", prefixHash };
  }

  evictSession(sessionKey: string): void {
    this.sessionPrefixCache.delete(sessionKey);
  }

  getStats(): StablePrefixStats {
    return { ...this.stats };
  }
}
