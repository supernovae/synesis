import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import type { GovernorPauseEnvelope } from "../governance/execution-governor.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "buildExecutionGovernorHardStopUserMessage"
  | "buildExecutionGovernorPauseEnvelope"
  | "buildSensemakingGuidanceInjection"
  | "buildSensemakingPauseMessage"
  | "clearGovernorPauseContextMetadata"
  | "config"
  | "injectGovernorRecoveryMessage"
  | "maybeCheckpoint"
  | "persistGovernorPauseContextMetadata"
  | "persistGovernorPauseSoftFail"
  | "recordSessionEvent"
  | "resetGovernorPauseRecoveryState"
  | "sessionPersistenceRunner"
  | "summarizeEvidenceDelta"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;

interface HandleOpenAIGovernorResponseInput {
  deps: Deps;
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  selectedModel: string;
  originalModel: string;
  messages: Array<{ role: string; content: unknown }>;
  executionGovernor: {
    pause: boolean;
    matchedRules: string[];
    reason?: string | null;
    telemetry: {
      activeGuards?: unknown;
    };
  };
  sensemakingDecision?: {
    shouldPause?: boolean;
    matchedRules: string[];
    domain: string;
    frictionScore: number;
    responseLevel: string;
  } | null;
  sensemakingPrimaryEnabled: boolean;
  hasActiveEditMissFailure: boolean;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  pauseContext: {
    artifactContext: unknown;
    chatStateSummary: unknown;
    fileStateSummary: unknown;
    taskContext: unknown;
  };
}

export type OpenAIGovernorResponseResult =
  | { kind: "continue" }
  | { kind: "softFail"; content: string; envelope: GovernorPauseEnvelope };

export function handleOpenAIGovernorResponse(
  input: HandleOpenAIGovernorResponseInput,
): OpenAIGovernorResponseResult {
  const {
    deps,
    session,
    sessionKey,
    identity,
    requestId,
    selectedModel,
    originalModel,
    messages,
    executionGovernor,
    sensemakingDecision,
    sensemakingPrimaryEnabled,
    hasActiveEditMissFailure,
    clientToolCapabilities,
    pauseContext,
  } = input;
  const {
    buildExecutionGovernorHardStopUserMessage,
    buildExecutionGovernorPauseEnvelope,
    buildSensemakingGuidanceInjection,
    buildSensemakingPauseMessage,
    clearGovernorPauseContextMetadata,
    config,
    injectGovernorRecoveryMessage,
    maybeCheckpoint,
    persistGovernorPauseContextMetadata,
    persistGovernorPauseSoftFail,
    recordSessionEvent,
    resetGovernorPauseRecoveryState,
    sessionPersistenceRunner,
    summarizeEvidenceDelta,
  } = deps;

  if (
    !sensemakingPrimaryEnabled
    && executionGovernor.pause
    && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED
  ) {
    const pause = persistGovernorPauseSoftFail({
      session,
      sessionKey,
      identity,
      requestId,
      selectedModel,
      originalModel,
      finishReason: "stop",
      buildPause: (consecutiveRecoveryFires) => {
        const content = buildExecutionGovernorHardStopUserMessage({
          consecutiveRecoveryFires,
          matchedRules: executionGovernor.matchedRules,
          questionToolName: clientToolCapabilities.questionToolName,
          taskContext: pauseContext.taskContext as never,
        });
        const envelope = buildExecutionGovernorPauseEnvelope({
          matchedRules: executionGovernor.matchedRules,
          consecutiveRecoveryFires,
          hardStopThreshold: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
          evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
          activeGuards: executionGovernor.telemetry.activeGuards as never,
          artifactContext: pauseContext.artifactContext as never,
          chatStateSummary: pauseContext.chatStateSummary as never,
          fileStateSummary: pauseContext.fileStateSummary as never,
          taskContext: pauseContext.taskContext as never,
          questionToolName: clientToolCapabilities.questionToolName,
        });
        return {
          content,
          envelope,
          eventType: "execution_governor_pause",
          eventSource: "execution-governor",
          eventSummary: `Pause: rules=${executionGovernor.matchedRules.slice(0, 3).join(",") || "unknown"}`,
          eventMetadata: {
            matchedRules: executionGovernor.matchedRules,
            reason: executionGovernor.reason,
            consecutiveRecoveryFires,
          },
        };
      },
      persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
        session: pauseSession,
        surface: "openai",
        requestId,
        pauseEnvelope,
        pauseContent,
        clientToolCapabilities,
      }),
      persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });
    return { kind: "softFail", content: pause.content, envelope: pause.envelope };
  }

  if (sensemakingPrimaryEnabled && sensemakingDecision && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED) {
    if (sensemakingDecision.shouldPause) {
      const pause = persistGovernorPauseSoftFail({
        session,
        sessionKey,
        identity,
        requestId,
        selectedModel,
        originalModel,
        finishReason: "stop",
        buildPause: (consecutiveRecoveryFires) => {
          const content = buildSensemakingPauseMessage(sensemakingDecision as never);
          const envelope = buildExecutionGovernorPauseEnvelope({
            matchedRules: sensemakingDecision.matchedRules,
            consecutiveRecoveryFires,
            hardStopThreshold: 7,
            evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
            activeGuards: executionGovernor.telemetry.activeGuards as never,
            artifactContext: pauseContext.artifactContext as never,
            chatStateSummary: pauseContext.chatStateSummary as never,
            fileStateSummary: pauseContext.fileStateSummary as never,
            taskContext: pauseContext.taskContext as never,
            questionToolName: clientToolCapabilities.questionToolName,
          });
          return {
            content,
            envelope,
            eventType: "sensemaking_governor_pause",
            eventSource: "sensemaking-governor",
            eventSummary: `Pause: domain=${sensemakingDecision.domain} friction=${(sensemakingDecision.frictionScore * 100).toFixed(0)}% signals=${sensemakingDecision.matchedRules.slice(0, 3).join(",")}`,
            eventMetadata: {
              domain: sensemakingDecision.domain,
              frictionScore: sensemakingDecision.frictionScore,
              matchedRules: sensemakingDecision.matchedRules,
              consecutiveRecoveryFires,
            },
          };
        },
        persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
          session: pauseSession,
          surface: "openai",
          requestId,
          pauseEnvelope,
          pauseContent,
          clientToolCapabilities,
        }),
        persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
        maybeCheckpoint,
        recordSessionEvent,
      });
      return { kind: "softFail", content: pause.content, envelope: pause.envelope };
    }

    const guidanceInjection = buildSensemakingGuidanceInjection(sensemakingDecision as never);
    if (guidanceInjection) {
      injectGovernorRecoveryMessage(messages, guidanceInjection);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "sensemaking_governor_guidance",
        "sensemaking-governor",
        `${sensemakingDecision.responseLevel}: domain=${sensemakingDecision.domain} friction=${(sensemakingDecision.frictionScore * 100).toFixed(0)}%`,
        requestId,
        {
          responseLevel: sensemakingDecision.responseLevel,
          domain: sensemakingDecision.domain,
          frictionScore: sensemakingDecision.frictionScore,
          guidance: guidanceInjection.slice(0, 200),
        },
      );
    }

    resetGovernorPauseRecoveryState(session, hasActiveEditMissFailure, clearGovernorPauseContextMetadata);
    return { kind: "continue" };
  }

  if (!executionGovernor.pause) {
    resetGovernorPauseRecoveryState(session, hasActiveEditMissFailure, clearGovernorPauseContextMetadata);
  }
  return { kind: "continue" };
}
