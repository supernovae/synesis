import type { AppConfig } from "../config.js";
import { DiagnosticStore } from "../state/diagnostic-store.js";

export interface RequestDiagnostic {
  timestamp: number;
  sessionKey: string;
  path: string;
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
  toolDefinitionCount: number;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  reducedToolResults: number;
  finishReason: string;
  tokensIn: number;
  tokensOut: number;
  policyDecision: string;
  latencyMs: number;
  recallRouting?: string;
  recallConfidence?: number;
  verificationRound?: number;
  verificationFindings?: number;
  verificationStalled?: boolean;
  decisionPath?: string;
  decisionEscalated?: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  evidencePrefetchHit?: boolean;
  evidencePrefetchConfidence?: number;
  evidencePrefetchMs?: number;
  evidenceQuality?: Record<string, unknown>;
  requestId?: string;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  completionGateApplied?: boolean;
  missingMustRequirements?: number;
  missingShouldRequirements?: number;
  requirementChecklistMust?: number;
  requirementChecklistShould?: number;
  contextAdmissionDecision?: "allow" | "warn" | "reject";
  contextAdmissionReason?: string;
  contextAdmissionEstimatedTokens?: number;
  contextAdmissionEstimatedChars?: number;
  requestForensicsSummary?: string;
  requestForensicsLcpRatio?: number;
  requestForensicsFirstChangedSection?: string;
  requestForensicsTokenEstimate?: number;
  cacheStrategy?: string;
  prefixFingerprint?: string;
  stageTimingsMs?: Record<string, number>;
  cacheShapeMessageCount?: number;
  cacheShapeStablePrefixHash?: string;
  cacheShapeStablePrefixBytes?: number;
  cacheShapeToolCount?: number;
  cacheShapeToolSchemaHash?: string;
  cacheShapeToolSchemaBytes?: number;
  cacheShapeProviderOptionsHash?: string;
  cacheShapeProviderOptionsBytes?: number;
  cacheShapeNormalizedTranscriptPrefixHash?: string;
  cacheShapeNormalizedTranscriptPrefixBytes?: number;
  cacheShapeCachePolicyHash?: string;
  cacheShapeCachePolicyBytes?: number;
  cacheShapeModelProviderResolutionHash?: string;
  cacheShapeModelProviderResolutionBytes?: number;
  cacheShapePromptTokens?: number;
  cacheShapeCachedTokens?: number;
  cacheShapeCacheCreationTokens?: number;
  cacheShapeHitPct?: number;
  cacheShapeOutcome?: "hit" | "write" | "miss" | "unknown";
}

export interface RecentRequestDiagnostics {
  diagnostics: RequestDiagnostic[];
  source: "memory" | "redis_empty" | "redis";
}

export interface RequestDiagnosticRingStats {
  max: number;
  current: number;
}

export class RequestDiagnosticRegistry {
  private readonly store: DiagnosticStore;
  private readonly ring: RequestDiagnostic[] = [];
  private readonly ringMax: number;

  constructor(config: AppConfig) {
    this.store = new DiagnosticStore(config);
    this.ringMax = config.SYNESIS_YARN_DIAGNOSTIC_RING_MAX;
  }

  push(diagnostic: RequestDiagnostic): void {
    this.ring.push(diagnostic);
    if (this.ring.length > this.ringMax) this.ring.shift();
    if (diagnostic.requestId) {
      this.store.persistDiagnostic(diagnostic.requestId, diagnostic as unknown as Record<string, unknown>);
    }
  }

  async listRecent(limit = this.ringMax): Promise<RecentRequestDiagnostics> {
    if (this.ring.length > 0) {
      return { diagnostics: [...this.ring].slice(-limit), source: "memory" };
    }
    const recentIds = await this.store.listRecentDiagnostics(limit);
    if (recentIds.length === 0) {
      return { diagnostics: [], source: "redis_empty" };
    }
    const redisDiags: RequestDiagnostic[] = [];
    for (const id of recentIds) {
      const diagnostic = await this.store.getDiagnostic(id);
      if (diagnostic) redisDiags.push(diagnostic as unknown as RequestDiagnostic);
    }
    return { diagnostics: redisDiags, source: "redis" };
  }

  async getByRequestId(requestId: string): Promise<RequestDiagnostic | null> {
    const inMemory = this.ring.find((diagnostic) => diagnostic.requestId === requestId);
    if (inMemory) return inMemory;
    const persisted = await this.store.getDiagnostic(requestId);
    return persisted ? persisted as unknown as RequestDiagnostic : null;
  }

  getRingStats(): RequestDiagnosticRingStats {
    return { max: this.ringMax, current: this.ring.length };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
