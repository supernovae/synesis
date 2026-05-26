import type { AppConfig } from "../config.js";
import type { ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";
import type { SessionState } from "../state/session-state.js";
import type { ChatState } from "./chat-state.js";
import type { FileState } from "./file-state.js";
import {
  buildGovernorPauseContextSnapshot,
  buildGovernorPauseResumeBlock,
  GOVERNOR_PAUSE_CONTEXT_METADATA_KEY,
  GOVERNOR_PAUSE_PENDING_METADATA_KEY,
  isGovernorPauseSummaryRequest,
  parseGovernorPauseContextSnapshot,
  type GovernorPauseSurface,
} from "./governor-pause-context.js";
import type { GovernorPauseEnvelope } from "./execution-governor.js";
import {
  applyObjectiveScope,
  resolveObjectiveEpoch,
} from "./objective-scope.js";
import type { StateConfidenceAssessment } from "./state-confidence.js";

type RecordSessionEventFn = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId?: string,
  metadataJson?: Record<string, unknown>,
) => void;

export interface RouteGovernanceStateHelpers {
  persistGovernorPauseContextMetadata(params: {
    session: SessionState;
    surface: GovernorPauseSurface;
    requestId: string;
    pauseEnvelope: GovernorPauseEnvelope;
    pauseContent: string;
    clientToolCapabilities: ClientToolCapabilities;
  }): void;
  clearGovernorPauseContextMetadata(session: SessionState): void;
  buildGovernorPauseResumeBlockForUser(session: SessionState, latestUserPrompt: string): string | null;
  applyObjectiveScopeAndPersist<TMessage extends {
    role: string;
    content: unknown;
    name?: string;
    tool_call_id?: string;
  }>(params: {
    state: SessionState;
    sessionKey: string;
    requestId: string;
    userId: string;
    orgId: string;
    messages: TMessage[];
    chatState: ChatState;
    fileState: FileState;
    latestUserPromptText: string | null;
  }): {
    scopedMessages: TMessage[];
    relevantEvidenceBlock: string | null;
    artifactBridgeBlock: string | null;
    boundaryIndex: number;
    retainedEvidenceCount: number;
    droppedPreBoundaryCount: number;
    objectiveChanged: boolean;
    epochId: number;
  };
  persistStateConfidence(metadata: Record<string, unknown>, assessment: StateConfidenceAssessment): void;
}

export function createRouteGovernanceStateHelpers(input: {
  config: AppConfig;
  recordSessionEvent: RecordSessionEventFn;
}): RouteGovernanceStateHelpers {
  function persistGovernorPauseContextMetadata(params: Parameters<RouteGovernanceStateHelpers["persistGovernorPauseContextMetadata"]>[0]): void {
    const snapshot = buildGovernorPauseContextSnapshot({
      surface: params.surface,
      requestId: params.requestId,
      envelope: params.pauseEnvelope,
      pauseMessage: params.pauseContent,
      questionToolName: params.clientToolCapabilities.hasQuestionTool
        ? params.clientToolCapabilities.questionToolName
        : null,
    });
    params.session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY] = snapshot as unknown as Record<string, unknown>;
    params.session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] = true;
  }

  function clearGovernorPauseContextMetadata(session: SessionState): void {
    delete session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY];
    delete session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY];
  }

  function buildGovernorPauseResumeBlockForUser(session: SessionState, latestUserPrompt: string): string | null {
    if (!isGovernorPauseSummaryRequest(latestUserPrompt)) return null;
    const rawSnapshot = session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY];
    const pending = session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] === true;
    const snapshot = parseGovernorPauseContextSnapshot(rawSnapshot);
    if (!pending || !snapshot) return null;
    session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] = false;
    return buildGovernorPauseResumeBlock(snapshot, latestUserPrompt);
  }

  function applyObjectiveScopeAndPersist<TMessage extends {
    role: string;
    content: unknown;
    name?: string;
    tool_call_id?: string;
  }>(
    params: Parameters<RouteGovernanceStateHelpers["applyObjectiveScopeAndPersist"]>[0] & { messages: TMessage[] },
  ): ReturnType<RouteGovernanceStateHelpers["applyObjectiveScopeAndPersist"]> & { scopedMessages: TMessage[] } {
    const requestOrdinal = params.state.record.requestCount + 1;
    const objectiveEpoch = resolveObjectiveEpoch({
      metadata: params.state.record.metadata,
      chatState: params.chatState,
      latestUserPromptText: params.latestUserPromptText,
      requestOrdinal,
    });
    const msgCount = params.messages.length;
    const scaledEvidence = msgCount > 200 ? 12 : msgCount > 100 ? 9 : 6;
    const epochInterval = Number(input.config.SYNESIS_YARN_SCOPE_EPOCH_INTERVAL ?? 10) || 10;
    const messageGrowthThreshold = Number(input.config.SYNESIS_YARN_SCOPE_MESSAGE_GROWTH_THRESHOLD ?? 80) || 80;
    const bucketSize = Number(input.config.SYNESIS_YARN_SCOPE_BUCKET_SIZE ?? 50) || 50;
    const scoped = applyObjectiveScope({
      messages: params.messages,
      chatState: params.chatState,
      fileState: params.fileState,
      epoch: objectiveEpoch,
      maxRelevantEvidence: scaledEvidence,
      preBoundaryWindow: 80,
      minimumScore: 3,
      requestOrdinal,
      epochInterval,
      messageGrowthThreshold,
      bucketSize,
    });

    params.state.record.metadata.objective_epoch_id = objectiveEpoch.epochId;
    params.state.record.metadata.objective_epoch_objective_hash = objectiveEpoch.objectiveHash;
    params.state.record.metadata.objective_epoch_objective_text = objectiveEpoch.objectiveText;
    params.state.record.metadata.objective_epoch_anchor_user_hash = objectiveEpoch.anchorUserHash;
    params.state.record.metadata.objective_epoch_set_request = objectiveEpoch.objectiveSetRequest;
    params.state.record.metadata.objective_scope_boundary_index = scoped.boundaryIndex;
    params.state.record.metadata.objective_scope_retained_evidence = scoped.retainedEvidenceCount;
    params.state.record.metadata.objective_scope_dropped_pre_boundary = scoped.droppedPreBoundaryCount;

    params.state.record.metadata.objective_epoch_pruning_frozen_boundary = scoped.updatedCheckpoint.frozenBoundaryIndex;
    params.state.record.metadata.objective_epoch_pruning_frozen_at_request = scoped.updatedCheckpoint.frozenAtRequest;
    params.state.record.metadata.objective_epoch_pruning_frozen_message_count = scoped.updatedCheckpoint.frozenMessageCount;

    if (
      objectiveEpoch.objectiveChanged
      || scoped.droppedPreBoundaryCount > 0
      || scoped.retainedEvidenceCount > 0
      || scoped.reanchored
    ) {
      input.recordSessionEvent(
        params.sessionKey,
        params.userId,
        params.orgId,
        "objective_scope_applied",
        "objective-scope",
        `epoch=${objectiveEpoch.epochId} changed=${objectiveEpoch.objectiveChanged} boundary=${scoped.boundaryIndex} retained=${scoped.retainedEvidenceCount} dropped=${scoped.droppedPreBoundaryCount} reanchored=${scoped.reanchored}`,
        params.requestId,
        {
          objective_epoch_id: objectiveEpoch.epochId,
          objective_changed: objectiveEpoch.objectiveChanged,
          objective_similarity: objectiveEpoch.similarityToPrevious,
          boundary_index: scoped.boundaryIndex,
          retained_evidence: scoped.retainedEvidenceCount,
          dropped_pre_boundary: scoped.droppedPreBoundaryCount,
          anchor_matched: scoped.anchorMatched,
          reanchored: scoped.reanchored,
        },
      );
    }

    return {
      scopedMessages: scoped.scopedMessages,
      relevantEvidenceBlock: scoped.relevantEvidenceBlock,
      artifactBridgeBlock: scoped.artifactBridgeBlock,
      boundaryIndex: scoped.boundaryIndex,
      retainedEvidenceCount: scoped.retainedEvidenceCount,
      droppedPreBoundaryCount: scoped.droppedPreBoundaryCount,
      objectiveChanged: objectiveEpoch.objectiveChanged,
      epochId: objectiveEpoch.epochId,
    };
  }

  function persistStateConfidence(
    metadata: Record<string, unknown>,
    assessment: StateConfidenceAssessment,
  ): void {
    metadata.state_confidence_chat = assessment.chatConfidence;
    metadata.state_confidence_file = assessment.fileConfidence;
    metadata.state_confidence_overall = assessment.overallConfidence;
    metadata.state_confidence_needs_reground = assessment.needsReground;
    metadata.state_confidence_recommended_path = assessment.recommendedReadPath ?? "";
    metadata.state_confidence_reasons = assessment.reasons;
  }

  return {
    persistGovernorPauseContextMetadata,
    clearGovernorPauseContextMetadata,
    buildGovernorPauseResumeBlockForUser,
    applyObjectiveScopeAndPersist,
    persistStateConfidence,
  };
}
