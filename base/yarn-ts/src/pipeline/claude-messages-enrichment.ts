import type { AppConfig } from "../config.js";
import type { ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";
import type { ClientMetadata } from "../providers/prefix-optimizer/index.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { RequirementChecklist } from "../validation/requirement-coverage.js";
import type { SecurityIngestConfig } from "@synesis/context-trust";
import { applyWorkspaceMetadataPrebackfill } from "./workspace-metadata-prebackfill.js";
import { buildRouteGovernanceBlocks } from "./route-governance-blocks.js";
import { finalizePostEnrichmentMessages, type EnrichedMessage } from "./post-enrichment-finalization.js";
import { buildDurableWorkPacketDecision } from "../memory/durable-work-packet.js";
import {
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
} from "../providers/model-architecture-profile.js";
import { filterContextBlocksForMediation } from "../memory/context-mediation.js";
import type { UserRuntimePreferences } from "../runtime/user-preferences.js";

type Logger = {
  info(record: Record<string, unknown>, message?: string): void;
  warn(message: string, ...args: unknown[]): void;
};

type SessionLike = {
  record: { metadata: Record<string, unknown> };
  taskLedger?: unknown;
  taskCapabilities?: unknown;
};

type PromptContext = {
  tier: string;
  role: string;
  modelFamily: string;
};

export interface ClaudeMessagesEnrichmentResult {
  messages: EnrichedMessage[];
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
}

export type ClaudeMessagesEnrichmentPhaseResult =
  | {
      ok: false;
      statusCode: number;
      body: Record<string, unknown>;
    }
  | {
      ok: true;
      pathContext: SessionPathHints;
      adapterBlock: string | undefined;
      enriched: ClaudeMessagesEnrichmentResult;
      messages: EnrichedMessage[];
    };

export interface ClaudeMessagesEnrichmentInput<TSession extends SessionLike> {
  config: AppConfig;
  logger: Logger;
  securityIngestConfig: SecurityIngestConfig;
  session: TSession;
  sessionKey: string;
  requestId: string;
  identity: { userId: string; orgId: string };
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  normalizedMessages: unknown[];
  scopedMessages: unknown[];
  promptContext: PromptContext;
  backendModel?: string;
  bodyMetadata?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
  runtimePreferences?: UserRuntimePreferences | null;
  clientToolCapabilities: ClientToolCapabilities;
  taskIntake?: unknown;
  planGraph?: unknown;
  relevantEvidenceBlock?: string | null;
  artifactBridgeBlock?: string | null;
  stateConfidenceBlock?: string | null;
  governorPauseResumeBlock?: string | null;
  plannerTodoPacketBlock?: string | null;
  chatStateBlock?: string | null;
  fileStateBlock?: string | null;
  requirementChecklist: RequirementChecklist | null;
  extractMetadataFromMessages(messages: unknown[]): ClientMetadata;
  buildAdapterBlock(pathContext: SessionPathHints): string | undefined;
  setWorkspaceContext(
    session: TSession,
    status: "ready",
    requestId: string,
    details: { reason: string; projectRoot?: string; cwd?: string; shell?: string; os?: string; arch?: string },
  ): void;
  getCachedTopLevelDirs(root?: string | null): Promise<string[]>;
  getMemoryGovernor(sessionKey: string): Parameters<typeof buildRouteGovernanceBlocks>[0]["memoryTracker"];
  getStructuralIndex(sessionKey: string): Parameters<typeof buildRouteGovernanceBlocks>[0]["structuralIndex"];
  getSessionMemoryCount(sessionKey: string): number;
  enrichWithFrameAndManifest(
    messages: unknown[],
    sessionKey: string,
    adapterBlock: string | undefined,
    promptContext: PromptContext,
    pathContext: { projectRoot: string | null; shellCwd: string | null },
    governanceBlocks: string[],
    seedDirs: string[],
    session: TSession,
    stateBlocks: { chatStateBlock?: string | null; fileStateBlock?: string | null },
  ): Promise<ClaudeMessagesEnrichmentResult>;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export async function runClaudeMessagesEnrichment<TSession extends SessionLike>(
  input: ClaudeMessagesEnrichmentInput<TSession>,
): Promise<ClaudeMessagesEnrichmentPhaseResult> {
  const metadataPrebackfill = applyWorkspaceMetadataPrebackfill({
    pathContext: input.pathContext,
    adapterBlock: input.adapterBlock,
    messages: input.normalizedMessages,
    session: input.session,
    requestId: input.requestId,
    extractMetadataFromMessages: input.extractMetadataFromMessages,
    buildAdapterBlock: input.buildAdapterBlock,
    setWorkspaceContext: input.setWorkspaceContext,
    logInfo: (record, message) => input.logger.info(record, message),
    logSessionKey: input.sessionKey,
  });
  const pathContext = metadataPrebackfill.pathContext;
  const adapterBlock = metadataPrebackfill.adapterBlock;
  const seedDirs = await input.getCachedTopLevelDirs(pathContext.projectRoot ?? pathContext.shellCwd);
  const architectureMediationMode = resolveArchitectureMediationMode({
    headers: input.headers ?? null,
    metadata: input.bodyMetadata ?? null,
    configMode: input.runtimePreferences?.synesisMemoryMode ?? null,
  });
  const workPacketPolicy = applyArchitectureMediationMode(
    deriveModelExecutionPolicy(
      resolveModelArchitectureProfile({
        modelId: input.backendModel || input.promptContext.role,
        family: input.promptContext.modelFamily,
      }),
    ),
    architectureMediationMode,
  );
  const workPacket = buildDurableWorkPacketDecision({
    sessionKey: input.sessionKey,
    requestCount: Number(input.session.record.metadata.request_count ?? 0),
    messages: input.scopedMessages,
    taskLedger: input.session.taskLedger as never,
    projectRoot: pathContext.projectRoot,
    shellCwd: pathContext.shellCwd,
    modelPolicy: workPacketPolicy,
    metadata: input.bodyMetadata ?? null,
    configMode: input.runtimePreferences?.synesisMemoryMode ?? null,
  });
  const governanceBlocks = buildRouteGovernanceBlocks({
    memoryTracker: input.getMemoryGovernor(input.sessionKey),
    structuralIndex: input.getStructuralIndex(input.sessionKey),
    sessionMemoryCount: input.getSessionMemoryCount(input.sessionKey),
    clientToolCapabilities: input.clientToolCapabilities,
    taskIntake: input.taskIntake as never,
    planGraph: input.planGraph as never,
    relevantEvidenceBlock: input.relevantEvidenceBlock,
    artifactBridgeBlock: input.artifactBridgeBlock,
    stateConfidenceBlock: input.stateConfidenceBlock,
    governorPauseResumeBlock: input.governorPauseResumeBlock,
    plannerTodoPacketBlock: input.plannerTodoPacketBlock,
    taskLedger: input.session.taskLedger as never,
    taskCapabilities: input.session.taskCapabilities as never,
  });
  if (workPacket.packet) {
    input.session.record.metadata.current_work_packet = {
      hash: workPacket.packet.hash,
      mode: workPacket.mode,
      injected: workPacket.inject,
      estimated_tokens: workPacket.packet.estimatedTokens,
      source_sections: workPacket.packet.sourceSections,
      reasons: workPacket.reasons,
      active_state_header_hash: workPacket.packet.activeStateHeaderHash,
      critical_fact_pin_count: workPacket.packet.criticalFactPinCount,
      evidence_manifest_count: workPacket.packet.evidenceManifestCount,
      hygiene_score: workPacket.packet.hygieneScore,
      verification_warnings: workPacket.packet.verificationWarnings,
      summary: workPacket.packet.summary,
      updated_at: Date.now(),
    };
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "current_work_packet_v1",
      "durable-work-packet",
      `${workPacket.inject ? "injected" : "observed"} hash=${workPacket.packet.hash} mode=${workPacket.mode}`,
      input.requestId,
      {
        hash: workPacket.packet.hash,
        mode: workPacket.mode,
        injected: workPacket.inject,
        estimated_tokens: workPacket.packet.estimatedTokens,
        source_sections: workPacket.packet.sourceSections,
        reasons: workPacket.reasons,
        active_state_header_hash: workPacket.packet.activeStateHeaderHash,
        critical_fact_pin_count: workPacket.packet.criticalFactPinCount,
        evidence_manifest_count: workPacket.packet.evidenceManifestCount,
        hygiene_score: workPacket.packet.hygieneScore,
        verification_warnings: workPacket.packet.verificationWarnings,
        summary: workPacket.packet.summary,
        block: workPacket.packet.block,
      },
    );
  }
  const hygieneFilteredGovernance = filterContextBlocksForMediation(governanceBlocks.blocks, workPacketPolicy);
  const frameGovernanceBlocks = [
    ...hygieneFilteredGovernance.blocks,
    ...(workPacket.inject && workPacket.packet ? [workPacket.packet.block] : []),
  ];
  const enriched = await input.enrichWithFrameAndManifest(
    input.scopedMessages,
    input.sessionKey,
    adapterBlock,
    input.promptContext,
    { projectRoot: pathContext.projectRoot, shellCwd: pathContext.shellCwd },
    frameGovernanceBlocks,
    seedDirs,
    input.session,
    { chatStateBlock: input.chatStateBlock, fileStateBlock: input.fileStateBlock },
  );
  const finalized = finalizePostEnrichmentMessages({
    messages: enriched.messages,
    config: input.config,
    requirementChecklist: input.requirementChecklist,
    trustContext: {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      userId: input.identity.userId,
      orgId: input.identity.orgId,
    },
    securityIngestConfig: input.securityIngestConfig,
    logger: input.logger,
  });
  if (!finalized.ok) {
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "trust_block",
      "transcript-trust",
      finalized.blockDetail,
      input.requestId,
    );
    return {
      ok: false,
      statusCode: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Request blocked by content safety policy (${finalized.trustCategory}). Rephrase and retry.`,
        },
      },
    };
  }

  return {
    ok: true,
    pathContext,
    adapterBlock,
    enriched,
    messages: finalized.messages,
  };
}
