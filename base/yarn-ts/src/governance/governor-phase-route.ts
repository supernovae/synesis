import {
  governorPhaseToWorkflowPhase,
  resolveGovernanceUserCue,
  type GovernorInputMessage,
  type SessionPhase,
} from "./execution-governor.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";

export interface GovernorPhaseRouteSession {
  lastGovernorPhase?: SessionPhase;
  consecutiveRecoveryFires: number;
  governorPrePauseAttemptsByRule: Map<string, number>;
  implementationSoftStallNudgeStrikes: 0 | 1;
}

export interface GovernorPhaseRouteIdentity {
  userId: string;
  orgId: string;
}

export interface GovernorPhaseRouteInput<TSession extends GovernorPhaseRouteSession> {
  session: TSession;
  sessionKey: string;
  identity: GovernorPhaseRouteIdentity;
  requestId: string;
  governorPhase: SessionPhase;
  workingPhase?: WorkflowPhase;
  orchestratorPhaseOverride?: WorkflowPhase | null;
  messages: GovernorInputMessage[];
  recordSessionEvent: (
    sessionKey: string,
    userId: string,
    orgId: string,
    eventType: string,
    source: string,
    summary: string,
    requestId: string,
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface GovernorPhaseRouteResult {
  governorWorkflowPhase: WorkflowPhase;
  phaseTransitioned: boolean;
  mismatchRecorded: boolean;
}

export function applyGovernorPhaseRouteBookkeeping<TSession extends GovernorPhaseRouteSession>(
  input: GovernorPhaseRouteInput<TSession>,
): GovernorPhaseRouteResult {
  const governorWorkflowPhase = governorPhaseToWorkflowPhase(input.governorPhase);
  let mismatchRecorded = false;
  if (input.workingPhase && input.workingPhase !== governorWorkflowPhase) {
    const userCue = resolveGovernanceUserCue(input.messages);
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "governor_orchestrator_phase_mismatch",
      "execution-governor",
      `working=${input.workingPhase} governor=${governorWorkflowPhase}`,
      input.requestId,
      {
        governor_phase: input.governorPhase,
        governor_workflow_phase: governorWorkflowPhase,
        orchestrator_working_phase: input.workingPhase,
        orchestrator_phase_override: input.orchestratorPhaseOverride ?? null,
        latest_user_text_source: userCue.source,
      },
    );
    mismatchRecorded = true;
  }

  let phaseTransitioned = false;
  if (input.session.lastGovernorPhase && input.governorPhase !== input.session.lastGovernorPhase) {
    input.session.consecutiveRecoveryFires = 0;
    input.session.governorPrePauseAttemptsByRule.clear();
    input.session.implementationSoftStallNudgeStrikes = 0;
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "governor_phase_transition",
      "execution-governor",
      `${input.session.lastGovernorPhase} → ${input.governorPhase}`,
      input.requestId,
    );
    phaseTransitioned = true;
  }
  input.session.lastGovernorPhase = input.governorPhase;

  return {
    governorWorkflowPhase,
    phaseTransitioned,
    mismatchRecorded,
  };
}
