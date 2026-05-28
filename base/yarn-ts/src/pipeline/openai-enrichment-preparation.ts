import type { SessionIdentity } from "../session/session-key.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import { buildDurableWorkPacketDecision } from "../memory/durable-work-packet.js";
import {
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
} from "../providers/model-architecture-profile.js";
import { filterContextBlocksForMediation } from "../memory/context-mediation.js";
import type { UserRuntimePreferences } from "../runtime/user-preferences.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "app"
  | "applyWorkspaceMetadataPrebackfill"
  | "buildRouteGovernanceBlocks"
  | "config"
  | "enrichWithFrameAndManifest"
  | "extractMetadataFromMessages"
  | "finalizePostEnrichmentMessages"
  | "getCachedTopLevelDirs"
  | "getMemoryGovernor"
  | "getSessionMemoryCount"
  | "getStructuralIndex"
  | "inferModelFamily"
  | "recordSessionEvent"
  | "roleAssignmentRegistry"
  | "securityIngestConfig"
  | "setSessionWorkspaceContext"
  | "TIER_TO_ROLE"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type RouteMessage = { role: string; content: unknown; [key: string]: unknown };

interface PrepareOpenAIEnrichmentInput {
  deps: Deps;
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  buildAdapterBlock: (pathContext: SessionPathHints) => string | undefined;
  scopedMessages: unknown[];
  normalizedMessages: unknown[];
  orchestration: ReturnType<OpenAIChatCompletionsRouteDependencies["phaseOrchestrator"]["decide"]>;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  taskIntake: ReturnType<OpenAIChatCompletionsRouteDependencies["refreshTaskIntake"]>;
  planGraph: ReturnType<OpenAIChatCompletionsRouteDependencies["updatePlanGraph"]>;
  objectiveScope: {
    relevantEvidenceBlock?: string | null;
    artifactBridgeBlock?: string | null;
  };
  stateConfidenceBlock: string | null;
  freshImplicitSessionNotice: string | null;
  governorPauseResumeBlock: string | null;
  plannerTodoPacketBlock: string | null;
  chatStateBlock: string | null;
  fileStateBlock: string | null;
  requirementChecklist: ReturnType<OpenAIChatCompletionsRouteDependencies["refreshRequirementChecklist"]>;
  bodyMetadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
  runtimePreferences?: UserRuntimePreferences | null;
}

export async function prepareOpenAIEnrichment(input: PrepareOpenAIEnrichmentInput) {
  const {
    deps,
    session,
    sessionKey,
    identity,
    requestId,
    scopedMessages,
    normalizedMessages,
    orchestration,
    clientToolCapabilities,
    taskIntake,
    planGraph,
    objectiveScope,
    stateConfidenceBlock,
    freshImplicitSessionNotice,
    governorPauseResumeBlock,
    plannerTodoPacketBlock,
    chatStateBlock,
    fileStateBlock,
    requirementChecklist,
    bodyMetadata,
  extraBody,
  headers,
  runtimePreferences,
  } = input;
  const {
    app,
    applyWorkspaceMetadataPrebackfill,
    buildRouteGovernanceBlocks,
    config,
    enrichWithFrameAndManifest,
    extractMetadataFromMessages,
    finalizePostEnrichmentMessages,
    getCachedTopLevelDirs,
    getMemoryGovernor,
    getSessionMemoryCount,
    getStructuralIndex,
    inferModelFamily,
    recordSessionEvent,
    roleAssignmentRegistry,
    securityIngestConfig,
    setSessionWorkspaceContext,
    TIER_TO_ROLE,
  } = deps;

  const role = TIER_TO_ROLE[orchestration.tier];
  const backendModel = roleAssignmentRegistry.get(role)?.backendModel ?? "";
  const promptContext = {
    tier: orchestration.tier,
    role,
    modelFamily: inferModelFamily(backendModel),
  };
  const metadataPrebackfill = applyWorkspaceMetadataPrebackfill({
    pathContext: input.pathContext,
    adapterBlock: input.adapterBlock,
    messages: normalizedMessages,
    session,
    requestId,
    extractMetadataFromMessages: (messages: unknown[]) => extractMetadataFromMessages(messages as never),
    buildAdapterBlock: input.buildAdapterBlock,
    setWorkspaceContext: setSessionWorkspaceContext,
    logInfo: (record: Record<string, unknown>, message?: string) => app.log.info(record, message),
    logSessionKey: sessionKey,
  });
  const pathContext = metadataPrebackfill.pathContext;
  const adapterBlock = metadataPrebackfill.adapterBlock;
  const seedDirs = await getCachedTopLevelDirs(pathContext.projectRoot ?? pathContext.shellCwd);
  const architectureMediationMode = resolveArchitectureMediationMode({
    headers: headers ?? null,
    metadata: bodyMetadata ?? null,
    extraBody: extraBody ?? null,
    configMode: runtimePreferences?.synesisMemoryMode ?? null,
  });
  const workPacketPolicy = applyArchitectureMediationMode(
    deriveModelExecutionPolicy(
      resolveModelArchitectureProfile({
        modelId: backendModel || orchestration.selectedModel,
        family: promptContext.modelFamily,
      }),
    ),
    architectureMediationMode,
  );
  const workPacket = buildDurableWorkPacketDecision({
    sessionKey,
    requestCount: session.record.requestCount,
    messages: scopedMessages,
    taskLedger: session.taskLedger,
    projectRoot: pathContext.projectRoot,
    shellCwd: pathContext.shellCwd,
    modelPolicy: workPacketPolicy,
    headers: headers ?? null,
    metadata: bodyMetadata ?? null,
    extraBody: extraBody ?? null,
    configMode: runtimePreferences?.synesisMemoryMode ?? null,
  });
  const governanceBlocks = buildRouteGovernanceBlocks({
    memoryTracker: getMemoryGovernor(sessionKey),
    structuralIndex: getStructuralIndex(sessionKey),
    sessionMemoryCount: getSessionMemoryCount(sessionKey),
    clientToolCapabilities,
    taskIntake,
    planGraph,
    relevantEvidenceBlock: objectiveScope.relevantEvidenceBlock,
    artifactBridgeBlock: objectiveScope.artifactBridgeBlock,
    stateConfidenceBlock,
    freshImplicitSessionNotice,
    governorPauseResumeBlock,
    plannerTodoPacketBlock,
    taskLedger: session.taskLedger,
    taskCapabilities: session.taskCapabilities,
  });
  if (workPacket.packet) {
    session.record.metadata.current_work_packet = {
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
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "current_work_packet_v1",
      "durable-work-packet",
      `${workPacket.inject ? "injected" : "observed"} hash=${workPacket.packet.hash} mode=${workPacket.mode}`,
      requestId,
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
  const enriched = await enrichWithFrameAndManifest(
    scopedMessages as never,
    sessionKey,
    adapterBlock,
    promptContext,
    { projectRoot: pathContext.projectRoot, shellCwd: pathContext.shellCwd },
    frameGovernanceBlocks,
    seedDirs,
    session,
    { chatStateBlock, fileStateBlock },
  );
  const finalizedEnrichment = finalizePostEnrichmentMessages({
    messages: enriched.messages as RouteMessage[],
    config,
    requirementChecklist,
    trustContext: {
      requestId,
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
    },
    securityIngestConfig,
    logger: app.log as never,
  });
  if (!finalizedEnrichment.ok) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "trust_block",
      "transcript-trust",
      finalizedEnrichment.blockDetail,
      requestId,
    );
    return {
      ok: false as const,
      pathContext,
      adapterBlock,
      enriched,
      result: {
        kind: "error" as const,
        statusCode: 400,
        body: {
          error: {
            type: "invalid_request_error",
            message: `Request blocked by content safety policy (${finalizedEnrichment.trustCategory}). Rephrase and retry.`,
          },
        },
      },
    };
  }

  return {
    ok: true as const,
    pathContext,
    adapterBlock,
    enriched,
    enrichedMessages: finalizedEnrichment.messages,
    promptContext,
    governanceBlocks,
    workPacket,
    seedDirs,
  };
}
