import { createDiffStats } from "../governance/diff-accumulator.js";
import type { SessionState } from "./session-state.js";
import { clearWorkspaceScopedMetadata } from "./workspace-session-boundary.js";

type SessionMapLike = {
  delete(key: string): unknown;
  has(key: string): boolean;
};

type StablePrefixSessionCache = {
  evictSession(key: string): void;
};

export interface WorkspaceSessionStateHelpers {
  resetWorkspaceScopedSessionState(sessionKey: string, state: SessionState): void;
  workspaceStatePresence(sessionKey: string): {
    hasFileSnapshot: boolean;
    hasContentDedup: boolean;
    hasStructuralIndex: boolean;
    sessionMemoryCount: number;
  };
}

export function createWorkspaceSessionStateHelpers(input: {
  contentDedupBySession: SessionMapLike;
  fileSnapshotBySession: SessionMapLike;
  structuralIndexBySession: SessionMapLike;
  memoryGovernorBySession: SessionMapLike;
  blockedDiscoveryBySession: Pick<SessionMapLike, "delete">;
  stablePrefixService: StablePrefixSessionCache;
  clearSessionMemory(sessionKey: string): void;
  getSessionMemoryCount(sessionKey: string): number;
}): WorkspaceSessionStateHelpers {
  function resetWorkspaceScopedSessionState(sessionKey: string, state: SessionState): void {
    clearWorkspaceScopedMetadata(state.record.metadata);
    input.contentDedupBySession.delete(sessionKey);
    input.fileSnapshotBySession.delete(sessionKey);
    input.structuralIndexBySession.delete(sessionKey);
    input.memoryGovernorBySession.delete(sessionKey);
    input.clearSessionMemory(sessionKey);
    input.blockedDiscoveryBySession.delete(sessionKey);
    input.stablePrefixService.evictSession(sessionKey);
    state.history = [];
    state.lastVolatileContent = undefined;
    state.lastVolatileHash = undefined;
    state.pruningWatermark = 0;
    state.consecutiveToolCalls = 0;
    state.stagnantToolCycles = 0;
    state.lastToolSignalHash = "";
    state.awaitingToolLoopUserAck = false;
    state.toolLoopAckAnchorUserHash = "";
    state.toolLoopNoUserAckCount = 0;
    state.blockBroadVerificationUntilEdit = false;
    state.blockFailingVerificationUntilEdit = false;
    state.consecutiveRecoveryFires = 0;
    state.consecutiveEditContextMisses = 0;
    state.editReplayHardStopGraceUsed = false;
    state.editMissForceReadPending = false;
    state.artifactEditTurns.clear();
    state.seenFailureSignatures.clear();
    state.previousFailureSignature = null;
    state.lastEvidenceDelta = null;
    state.lastIncomingMessageCount = 0;
    state.governorPrePauseAttemptsByRule.clear();
    state.implementationSoftStallNudgeStrikes = 0;
    state.regroundCooldownRemaining = 0;
    state.lastGovernorNoPauseAt = 0;
    state.lastGovernorCachedResult = null;
    state.skipToolIdStabilization = false;
    state.gitInspectionBlockCount = 0;
    state.scopeEnvelope = "unconstrained";
    state.diffStats = createDiffStats();
    state.taskLedger = null;
    state.taskCapabilities = null;
  }

  function workspaceStatePresence(sessionKey: string) {
    return {
      hasFileSnapshot: input.fileSnapshotBySession.has(sessionKey),
      hasContentDedup: input.contentDedupBySession.has(sessionKey),
      hasStructuralIndex: input.structuralIndexBySession.has(sessionKey),
      sessionMemoryCount: input.getSessionMemoryCount(sessionKey),
    };
  }

  return {
    resetWorkspaceScopedSessionState,
    workspaceStatePresence,
  };
}
