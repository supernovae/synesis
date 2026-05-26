import type { AppConfig } from "../config.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import type { PhaseAwareToolChoice } from "../governance/phase-execution-policy.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import type { OptimizationCacheDiagnostics } from "../telemetry/optimization-ledger.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import { claudeToolsToSDK } from "../tool-mapping.js";
import { cachePolicyLogRecord } from "../telemetry/cache-policy-controller.js";
import { buildCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";
import {
  buildYarnUpperHarnessContext,
  type UpperHarnessDecision,
  type YarnUpperHarnessContext,
} from "../upper-harness/bridge.js";
import {
  appendSystemMessageAndNormalize,
  normalizeSystemMessageOrdering,
} from "../transcript/system-message-ordering.js";
import { hasClaudeNativeWebSearchTool } from "../protocol/claude-messages-helpers.js";
import { applyRouteAdapterPivot } from "./route-adapter-pivot.js";
import { applyRoutePhasePolicy } from "./route-phase-policy.js";
import { assembleRouteModelMessages } from "./route-model-message-assembly.js";
import { admissionErrorMessage } from "./context-admission.js";
import { runRouteContextAdmission } from "./route-context-admission.js";
import {
  buildClaudeMessagesProviderRequestOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "./provider-options.js";
import {
  architecturePolicyTrace,
  applyArchitectureMediationMode,
  buildArchitecturePolicySystemHint,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
  type ModelArchitectureProfileOverride,
} from "../providers/model-architecture-profile.js";
import { prepareRouteTools } from "./route-tool-preparation.js";

type Logger = {
  info(record: Record<string, unknown>, message?: string): void;
  warn(record: Record<string, unknown>, message?: string): void;
};

type SessionLike = {
  record: { metadata: Record<string, unknown> };
  editMissForceReadPending?: boolean;
  consecutiveEditContextMisses: number;
};

type RoutePersistenceLike = {
  recordSessionEvent(eventKind: string, component: string, detail: string, metadataJson?: Record<string, unknown>): void;
  persistDecisionTelemetry(input: unknown): unknown;
};

type ResolvedLike = {
  resolvedModelId: string;
  model: unknown;
  adapter: ModelAdapter;
};

type TierRegistryLike = {
  getTierConfig(modelId: string): {
    backendModel?: string;
    baseUrl: string;
    samplingDefaults?: unknown;
    contextCeilingTokens?: number | null;
    architectureProfile?: ModelArchitectureProfileOverride | null;
  } | undefined;
};

type ConfigSlice = Pick<
  AppConfig,
  | "SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED"
  | "SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP"
  | "SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED"
  | "SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE"
  | "SYNESIS_YARN_GOVERNANCE_DISABLED"
  | "SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED"
  | "SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED"
  | "SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES"
  | "SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS"
  | "SYNESIS_YARN_QWEN_STAGNATION_WINDOW"
  | "SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD"
  | "SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT"
  | "SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT"
  | "SYNESIS_YARN_CONTEXT_BUDGET_ENABLED"
  | "SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS"
  | "SYNESIS_YARN_CONTEXT_BUDGET_OUTPUT_RESERVE"
  | "SYNESIS_YARN_CONTEXT_ADMISSION_MODE"
  | "SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS"
  | "SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS"
  | "SYNESIS_YARN_ARCHITECTURE_MEDIATION_MODE"
>;

export interface ClaudeMessagesProviderPreparationInput {
  config: ConfigSlice;
  logger: Logger;
  body: ClaudeMessagesRequest;
  processedTools: unknown[];
  normalizedMessages: Array<{ role: string; content: unknown }>;
  resolved: ResolvedLike;
  messages: unknown;
  session: SessionLike;
  sessionKey: string;
  requestId: string;
  logRequestId: string;
  routePersistence: RoutePersistenceLike;
  cachePolicy: { compactionMode: string; action?: string; reasons?: string[] };
  clientToolCapabilities: { planModeRequested?: boolean };
  clientKind: string;
  orchestration: { phase: unknown };
  adapterProfile: { features: { toolSchemaBudgetCap?: number } };
  phasePolicyEnabledByMatrix: boolean;
  governorPhase: SessionPhase;
  executionGovernor: { matchedRules: string[] };
  editMissGuard: unknown;
  needsStateReground: boolean;
  stateConfidence: { recommendedReadPath?: string | null; reasons?: string[] };
  clientToolInventory: unknown[];
  workspaceInspection: unknown;
  latestUserContent?: unknown;
  policyPrecheck: { pivotPrompt?: string | null };
  latestReadRefresh: { filePath?: string | null };
  promptIntake: { systemBlock?: string | null };
  sensemakingDecision?: { responseLevel?: string; shouldPause?: boolean } | null;
  taskCue: unknown;
  tierRegistry: TierRegistryLike;
  resolveEndpointCapabilityId(baseUrl: string): string;
  chatState: unknown;
  fileState: unknown;
  artifactStore: unknown;
  contextAdmissionStats: unknown;
  compactionOptions: { backendModelHint?: string };
  transcriptPruning: unknown;
  forceCheckpoint(): void;
  recordUpperHarnessDecision(label: string, decision: UpperHarnessDecision, options?: { recordAllow?: boolean }): void;
  isOpenClawProfile(profile: unknown): boolean;
  adapterUsesToolLoopSteering(adapterFamily: string): boolean;
  isWriteCapableToolName(name: string): boolean;
  applyEditContextMissReadGate(tools: unknown[] | undefined): unknown;
  findPreferredReadToolName(tools: unknown[]): string | undefined;
  ensureReadToolAvailabilityForEditMissGuard(tools: unknown[] | undefined, fallbackTools: unknown[] | undefined): unknown;
  buildEditContextMissGuardPrompt(...args: unknown[]): string;
  buildEditContextMissForcedReadPrompt(...args: unknown[]): string;
  buildStateRegroundReadPrompt(...args: unknown[]): string;
  toolSchemaPruningStats: unknown;
}

export type ClaudeMessagesProviderPreparationResult =
  | {
      ok: false;
      statusCode: number;
      body: Record<string, unknown>;
    }
  | {
      ok: true;
      adapter: ResolvedLike["adapter"];
      upperHarness: YarnUpperHarnessContext;
      recentCallsForSteering: Array<{ toolName: string }>;
      effectiveTools: unknown[];
      sdkTools: unknown;
      effectiveToolChoice: unknown;
      providerOptions: unknown;
      samplingOptions: Record<string, unknown>;
      phasePolicy: ReturnType<typeof applyRoutePhasePolicy>["phasePolicy"];
      nativeWebSearchRequested: boolean;
      forceNonStreamKickoff: boolean;
      forensicsPhasePolicy: RequestForensicsRecord["phasePolicy"];
      contextAdmission: ReturnType<typeof runRouteContextAdmission>["contextAdmission"];
      cacheShapeDiagnostics: OptimizationCacheDiagnostics;
      persistDecisionTelemetry(input: unknown): unknown;
      modelMessages: unknown;
    };

export function prepareClaudeMessagesProviderRuntime(
  input: ClaudeMessagesProviderPreparationInput,
): ClaudeMessagesProviderPreparationResult {
  const { resolved, session, routePersistence, config, logger } = input;
  const { adapter } = resolved;
  const resolvedTierForHarness = input.tierRegistry.getTierConfig(resolved.resolvedModelId);
  const providerForHarness = resolvedTierForHarness
    ? input.resolveEndpointCapabilityId(resolvedTierForHarness.baseUrl)
    : "anthropic";
  const architectureProfile = resolveModelArchitectureProfile({
    modelId: resolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
    provider: providerForHarness,
    family: adapter.family,
    declaredContextTokens: resolvedTierForHarness?.contextCeilingTokens,
    override: resolvedTierForHarness?.architectureProfile,
  });
  const architectureMediationMode = resolveArchitectureMediationMode({
    metadata: recordOrNull(input.body.metadata),
    configMode: config.SYNESIS_YARN_ARCHITECTURE_MEDIATION_MODE,
  });
  const modelExecutionPolicy = applyArchitectureMediationMode(
    deriveModelExecutionPolicy(architectureProfile),
    architectureMediationMode,
  );
  const upperHarness = buildYarnUpperHarnessContext({
    surface: "claude",
    modelId: resolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
    requestedModel: input.body.model,
    adapter: adapter as never,
    baseUrl: resolvedTierForHarness?.baseUrl,
    provider: providerForHarness,
  });

  const toolPreparation = prepareRouteTools({
    rawTools: input.processedTools,
    adapter: adapter as never,
    clientCapabilities: input.clientToolCapabilities as never,
    clientKind: input.clientKind,
    phase: input.orchestration.phase as never,
    profileToolBudgetCap: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && input.isOpenClawProfile(input.adapterProfile)
      ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
      : input.adapterProfile.features.toolSchemaBudgetCap,
    pruningEnabled: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED,
    pruningMaxOverride: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE,
    toolChoice: input.body.tool_choice,
    latestUserContent: input.latestUserContent,
    recentCallMessages: input.normalizedMessages,
    recoveryMessages: input.normalizedMessages,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    toolLoopSteeringEnabled: input.adapterUsesToolLoopSteering(adapter.family),
    harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
    requestId: input.requestId,
    stats: input.toolSchemaPruningStats as never,
    logger,
    isWriteCapableToolName: input.isWriteCapableToolName,
    recordSessionEvent: routePersistence.recordSessionEvent,
  });
  const recentCallsForSteering = toolPreparation.recentCallsForSteering;
  let effectiveTools = toolPreparation.effectiveTools;
  const clientToolChoice = toolPreparation.clientToolChoice;
  if (toolPreparation.invalidToolChoice) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: {
          type: "invalid_request_error",
          message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
        },
      },
    };
  }

  const forceReadRecovery = Boolean(
    session.editMissForceReadPending
    && input.executionGovernor.matchedRules.includes("edit_failure_replay"),
  );
  let modelMessages = assembleRouteModelMessages({
    adapter: adapter as never,
    effectiveTools,
    messages: input.messages as never,
    workspaceInspection: input.workspaceInspection as never,
    policyPivotPrompt: input.policyPrecheck.pivotPrompt,
    editMissGuard: input.editMissGuard as never,
    forceReadRecovery,
    latestReadRefreshFilePath: input.latestReadRefresh.filePath,
    consecutiveEditContextMisses: session.consecutiveEditContextMisses,
    stateReground: {
      required: input.needsStateReground,
      recommendedReadPath: input.stateConfidence.recommendedReadPath,
      reasons: input.stateConfidence.reasons ?? [],
    },
    promptIntakeSystemBlock: input.promptIntake.systemBlock,
    architecturePolicySystemHint: buildArchitecturePolicySystemHint(modelExecutionPolicy),
    buildEditContextMissGuardPrompt: input.buildEditContextMissGuardPrompt as never,
    buildEditContextMissForcedReadPrompt: input.buildEditContextMissForcedReadPrompt as never,
    buildStateRegroundReadPrompt: input.buildStateRegroundReadPrompt as never,
  }).messages as unknown;

  const governanceRecoveryActive = Boolean(
    input.policyPrecheck.pivotPrompt
    || (input.editMissGuard as { active?: boolean } | null | undefined)?.active
    || forceReadRecovery
    || input.needsStateReground
    || (input.sensemakingDecision && input.sensemakingDecision.responseLevel !== "allow"),
  );
  modelMessages = applyRouteAdapterPivot({
    surface: "claude",
    adapter: adapter as never,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    modelMessages: modelMessages as Array<{ role: string; content?: unknown }>,
    normalizedMessages: input.normalizedMessages,
    recentCalls: recentCallsForSteering,
    recentUserPrompt: input.taskCue as never,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    toolLoopSteeringEnabled: input.adapterUsesToolLoopSteering(adapter.family),
    governanceRecoveryActive,
    harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
    skipTelemetry: {
      policy_pivot: Boolean(input.policyPrecheck.pivotPrompt),
      edit_miss_guard: Boolean((input.editMissGuard as { active?: boolean } | null | undefined)?.active),
      force_read_recovery: forceReadRecovery,
      state_confidence_reground: input.needsStateReground,
      governor_soft_fail_pause: Boolean(input.sensemakingDecision?.shouldPause),
    },
    cooldownTurns: config.SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS,
    stagnationWindow: config.SYNESIS_YARN_QWEN_STAGNATION_WINDOW,
    stagnationThreshold: config.SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD,
    planNoActionLimit: config.SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT,
    editRetryLimit: config.SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT,
    dampeningLogEvent: "adapter_dampening_claude",
    logger,
    appendSystemMessageAndNormalize: (messagesToAppend, content) => appendSystemMessageAndNormalize(
      messagesToAppend,
      content,
    ) as typeof messagesToAppend,
    recordSessionEvent: routePersistence.recordSessionEvent,
  }).modelMessages as unknown;

  modelMessages = normalizeSystemMessageOrdering(modelMessages as Array<{ role: string }>) as typeof modelMessages;

  const resolvedTierConfig = input.tierRegistry.getTierConfig(resolved.resolvedModelId);
  const providerRequestOptions = buildClaudeMessagesProviderRequestOptions({
    request: input.body,
    tierSamplingDefaults: resolvedTierConfig?.samplingDefaults as never,
    adapterSampling: adapter.defaultSamplingParams?.(),
    adapterProviderOptions: adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined,
    supportsTopK: adapter.family !== "minimax",
  });
  const samplingOptions = providerRequestOptions.samplingOptions;
  let providerOptions = providerRequestOptions.providerOptions;
  const phaseApplication = applyRoutePhasePolicy({
    adapterFamily: adapter.family,
    basePolicyEnabled: Boolean(config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED && input.phasePolicyEnabledByMatrix),
    policyEnabledByMatrix: input.phasePolicyEnabledByMatrix,
    enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
    phase: input.governorPhase,
    matchedRules: input.executionGovernor.matchedRules,
    stream: !!input.body.stream,
    effectiveTools,
    clientToolChoice: clientToolChoice as PhaseAwareToolChoice | undefined,
    editMissGuard: input.editMissGuard as never,
    editMissForceReadPending: Boolean(session.editMissForceReadPending),
    forceReadRecovery,
    consecutiveEditContextMisses: session.consecutiveEditContextMisses,
    stateRegroundRequired: input.needsStateReground,
    stateRegroundReadPath: input.stateConfidence.recommendedReadPath,
    clientToolInventory: input.clientToolInventory,
    recordSessionEvent: routePersistence.recordSessionEvent,
    applyEditContextMissReadGate: input.applyEditContextMissReadGate as never,
    findPreferredReadToolName: input.findPreferredReadToolName,
    ensureReadToolAvailability: input.ensureReadToolAvailabilityForEditMissGuard as never,
  });
  const phasePolicy = phaseApplication.phasePolicy;
  const phaseFiltered = phaseApplication.phaseFiltered;
  effectiveTools = phaseApplication.effectiveTools;
  const effectiveToolChoice = phaseApplication.effectiveToolChoice;
  const thinkingToolChoiceGuard = suppressThinkingWhenRequiredToolChoice(
    providerOptions,
    effectiveToolChoice as PhaseAwareToolChoice | undefined,
  );
  providerOptions = thinkingToolChoiceGuard.providerOptions;
  if (thinkingToolChoiceGuard.suppressed) {
    routePersistence.recordSessionEvent(
      "phase_required_tool_choice_thinking_guard",
      "execution-governor",
      "Suppressed thinking because tool_choice=required is incompatible with provider thinking mode.",
      {
        path: "claude",
        phase: input.governorPhase,
        phase_reason: phasePolicy.reason ?? null,
      },
    );
  }

  const sdkTools = claudeToolsToSDK(effectiveTools as never);
  const forensicsPhasePolicy: RequestForensicsRecord["phasePolicy"] = {
    enabled: phasePolicy.active,
    source: clientToolChoice !== undefined ? "client" : (effectiveToolChoice !== undefined ? "phase_policy" : "none"),
    phase: input.governorPhase,
    effectiveToolChoice: typeof effectiveToolChoice === "string" ? effectiveToolChoice : effectiveToolChoice ? "tool" : undefined,
    filteredToolCount: phaseFiltered.removed.length,
  };
  if (phasePolicy.active && (phaseFiltered.filtered || clientToolChoice === undefined)) {
    routePersistence.recordSessionEvent(
      "phase_execution_policy_applied",
      "execution-governor",
      `phase=${input.governorPhase} reason=${phasePolicy.reason ?? "none"} tool_choice=${typeof effectiveToolChoice === "string" ? effectiveToolChoice : "tool"} filtered=${phaseFiltered.removed.length}`,
      {
        matched_rules: input.executionGovernor.matchedRules,
        removed_tools: phaseFiltered.removed,
        state_confidence_reground: input.needsStateReground,
        state_confidence_recommended_path: input.stateConfidence.recommendedReadPath,
      },
    );
  }

  const nativeWebSearchRequested = hasClaudeNativeWebSearchTool(input.body.tools as unknown[] | undefined);
  const forceNonStreamKickoff =
    !!input.body.stream && phasePolicy.active && phasePolicy.toolChoice === "required" && !!phasePolicy.enforceNonStreaming;
  const admissionResult = runRouteContextAdmission({
    surface: "claude",
    messages: modelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
    tools: effectiveTools,
    sessionKey: input.sessionKey,
    logRequestId: input.logRequestId,
    metadata: session.record.metadata,
    chatState: input.chatState as never,
    fileState: input.fileState as never,
    artifactStore: input.artifactStore as never,
    contextBudgetEnabled: config.SYNESIS_YARN_CONTEXT_BUDGET_ENABLED,
    modelContextCeilingTokens: resolvedTierConfig?.contextCeilingTokens,
    budgetCeilingTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS,
    outputReserveTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_OUTPUT_RESERVE,
    admissionMode: config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
    admissionWarnTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
    admissionHardTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
    compactionMode: input.cachePolicy.compactionMode as never,
    modelExecutionPolicy,
    cachePolicyRecord: cachePolicyLogRecord(input.cachePolicy as never),
    upperHarnessContext: upperHarness,
    upperHarnessCeilingTokens: resolvedTierForHarness?.contextCeilingTokens,
    stats: input.contextAdmissionStats as never,
    backendModelHint: input.compactionOptions.backendModelHint,
    transcriptPruning: input.transcriptPruning as never,
    logger,
    recordSessionEvent: routePersistence.recordSessionEvent,
    recordUpperHarnessDecision: (label, decision, options) =>
      input.recordUpperHarnessDecision(label, decision, options),
    forceCheckpoint: input.forceCheckpoint,
  });
  modelMessages = admissionResult.messages;
  const contextAdmission = admissionResult.contextAdmission;
  if (admissionResult.rejected) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: admissionErrorMessage(contextAdmission),
        },
        context_admission: {
          decision: contextAdmission.decision,
          estimated_tokens: contextAdmission.estimatedTokens,
          estimated_chars: contextAdmission.estimatedChars,
          reason: contextAdmission.reason,
        },
      },
    };
  }

  const cacheShapeDiagnostics = {
    ...buildCacheShapeDiagnostics({
      messages: modelMessages as Array<{ role?: string; content?: unknown }>,
      tools: effectiveTools,
      providerOptions,
      cachePolicy: input.cachePolicy,
      modelProviderResolution: {
        surface: "claude",
        requestedModel: input.body.model,
        resolvedModelId: resolved.resolvedModelId,
        adapterFamily: adapter.family,
        backendModel: resolvedTierForHarness?.backendModel ?? resolvedTierConfig?.backendModel,
        baseUrl: resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl,
        provider: (resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl)
          ? input.resolveEndpointCapabilityId((resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl) as string)
          : "anthropic",
      },
    }),
    architectureAttention: architectureProfile.attention,
    architectureActivation: architectureProfile.activation,
    architectureDecoding: architectureProfile.decoding,
    executionPolicyHash: modelExecutionPolicy.policyHash,
    effectiveContextCeilingTokens: modelExecutionPolicy.effectiveContextCeilingTokens,
    architecturePolicyReasons: modelExecutionPolicy.reasons,
  };
  routePersistence.recordSessionEvent(
    "model_architecture_profile_selected",
    "model-architecture",
    `attention=${architectureProfile.attention} activation=${architectureProfile.activation} decoding=${architectureProfile.decoding}`,
    architecturePolicyTrace(architectureProfile, modelExecutionPolicy),
  );

  return {
    ok: true,
    adapter,
    upperHarness,
    recentCallsForSteering,
    effectiveTools,
    sdkTools,
    effectiveToolChoice,
    providerOptions,
    samplingOptions,
    phasePolicy,
    nativeWebSearchRequested,
    forceNonStreamKickoff,
    forensicsPhasePolicy,
    contextAdmission,
    cacheShapeDiagnostics,
    persistDecisionTelemetry: routePersistence.persistDecisionTelemetry,
    modelMessages,
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
