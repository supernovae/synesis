import type { AppConfig } from "../config.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import type { PhaseAwareToolChoice } from "../governance/phase-execution-policy.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import { cachePolicyLogRecord } from "../telemetry/cache-policy-controller.js";
import { buildCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";
import { buildYarnUpperHarnessContext } from "../upper-harness/bridge.js";
import { openAIToolsToSDK } from "../tool-mapping.js";
import { appendSystemMessageAndNormalize, normalizeSystemMessageOrdering } from "../transcript/system-message-ordering.js";
import { applyRouteAdapterPivot } from "./route-adapter-pivot.js";
import { applyRoutePhasePolicy } from "./route-phase-policy.js";
import { assembleRouteModelMessages } from "./route-model-message-assembly.js";
import { admissionErrorMessage, countMessageRoles } from "./context-admission.js";
import { runRouteContextAdmission } from "./route-context-admission.js";
import {
  createOpenAIChatRouteFinalizerBase,
  createOpenAIChatRouteTelemetryBase,
  createOpenAIChatRouteToolHandlingBase,
} from "./openai-route-inputs.js";
import {
  buildOpenAIChatProviderRequestOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "./provider-options.js";
import {
  architecturePolicyTrace,
  applyArchitectureMediationMode,
  buildArchitecturePolicySystemHint,
  defaultConservativeArchitectureProfile,
  deriveModelExecutionPolicy,
  parseArchitectureMediationModeContract,
  parseArchitectureProfileSourceContract,
  resolveModelArchitectureProfile,
  type ModelArchitectureProfileOverride,
} from "../providers/model-architecture-profile.js";
import {
  extractRecentToolNames,
  prepareRouteTools,
} from "./route-tool-preparation.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

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
  adapter: {
    family: string;
    providerOptions?: () => Record<string, Record<string, unknown>> | undefined;
    defaultSamplingParams?: () => { temperature?: number; top_p?: number } | undefined;
  };
};

type TierRegistryLike = {
  getTierConfig(modelId: string): {
    backendModel?: string;
    baseUrl: string;
    samplingDefaults?: unknown;
    contextCeilingTokens?: number | null;
    architectureProfile?: ModelArchitectureProfileOverride | null;
    modelCapabilityPreset?: string | null;
    defaultContextMediationMode?: string | null;
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
  | "SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED"
  | "SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED"
  | "SYNESIS_YARN_RESPONSE_STYLE_MODE"
  | "SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE"
  | "SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED"
  | "SYNESIS_YARN_PATH_SANDBOX_ENABLED"
>;

export interface OpenAIChatProviderPreparationInput {
  config: ConfigSlice;
  logger: Logger;
  request: Record<string, unknown>;
  headers?: Record<string, unknown> | null;
  normalizedRequest: {
    stream?: boolean;
    tools?: unknown[];
    tool_choice?: unknown;
    messages: unknown[];
  };
  normalizedOpenAI: { messages: unknown[] };
  resolved: ResolvedLike;
  messages: unknown;
  session: SessionLike;
  sessionKey: string;
  identity: { userId: string; orgId: string };
  requestId: string;
  routePersistence: RoutePersistenceLike;
  cachePolicy: { compactionMode: string; action?: string; reasons?: string[] };
  clientToolCapabilities: { planModeRequested?: boolean };
  clientTaskCue: unknown;
  clientKind: string;
  orchestration: { phase: unknown; escalated?: boolean };
  adapterProfile: { features: { toolSchemaBudgetCap?: number } };
  openClawStrictGovernance: boolean;
  phasePolicyEnabledByMatrix: boolean;
  governorPhase: SessionPhase;
  executionGovernor: { matchedRules: string[] };
  editMissGuard: unknown;
  needsStateReground: boolean;
  stateConfidence: { recommendedReadPath?: string | null; reasons?: string[] };
  clientToolInventory: unknown[];
  workspaceInspection: unknown;
  latestUserText?: { content?: unknown } | null;
  policyPrecheck: { pivotPrompt?: string | null; matchedRules: string[] };
  latestReadRefresh: { filePath?: string | null };
  promptIntake: { systemBlock?: string | null };
  sensemakingDecision?: { responseLevel?: string; shouldPause?: boolean; shouldRestrictDiscovery?: boolean } | null;
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
  recordUpperHarnessDecision(label: string, decision: unknown, options?: unknown): void;
  optimizationLedger: {
    recordCacheDiagnostics(record: Record<string, unknown>): void;
  };
  reductions: {
    toolResultReduction: unknown;
    validationNormalization: unknown;
  };
  reducedToolResults: number;
  evidence: {
    prefetched: boolean;
    confidence?: number;
  prefetchResult?: { authoritative?: unknown; latencyMs?: unknown; matched?: unknown; confidence?: unknown };
    patternResult?: unknown;
    quality?: unknown;
  };
  sensemakingResult?: { triggered?: boolean; reason?: string } | null;
  governorSummaries: {
    chat?: unknown;
    file?: unknown;
  };
  inferVerificationSteps(input: unknown): unknown;
  trajectoryDiagnostics: unknown;
  enriched: {
    promptProfileIds?: number[];
    promptProfileHashes?: string[];
    prefixHash?: string;
    prefixChangeReasons?: string[];
  };
  requirementChecklist: { must: unknown[]; should: unknown[] } | null;
  pushDiagnostic(diagnostic: Record<string, unknown>): void;
  getMetadataString(metadata: Record<string, unknown>, key: string): string;
  verificationAssessment: unknown;
  planGraph: unknown;
  effectivePathContext: unknown;
  artifactShadows: unknown;
  toolArgHardeningStats: unknown;
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: unknown): Promise<unknown>;
  isOpenClawProfile(profile: unknown): boolean;
  adapterUsesToolLoopSteering(adapterFamily: string): boolean;
  isWriteCapableToolName(name: string): boolean;
  applyEditContextMissReadGate(tools: unknown[] | undefined): unknown;
  findPreferredReadToolName(tools: unknown[]): string | undefined;
  ensureReadToolAvailabilityForEditMissGuard(tools: unknown[] | undefined, fallbackTools: unknown[] | undefined): unknown;
  buildEditContextMissGuardPrompt(...args: unknown[]): string;
  buildEditContextMissForcedReadPrompt(...args: unknown[]): string;
  buildStateRegroundReadPrompt(...args: unknown[]): string;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializeShadow(data: unknown): unknown;
  buildDefaultPolicy(root: string): unknown;
  buildEvidenceTraceSummary(prefetchResult: unknown, patternResult: unknown): unknown;
}

export type OpenAIChatProviderPreparationResult =
  | { ok: false; result: OpenAIChatPipelineResult }
  | {
      ok: true;
      adapter: ResolvedLike["adapter"];
      upperHarness: unknown;
      effectiveTools: unknown[];
      sdkTools: unknown;
      effectiveToolChoice: unknown;
      providerOptions: unknown;
      structuredOutput: unknown;
      samplingOptions: unknown;
      phasePolicy: unknown;
      forensicsPhasePolicy: RequestForensicsRecord["phasePolicy"];
      telemetryRouteBase: unknown;
      finalizerRouteBase: unknown;
      toolHandlingRouteBase: unknown;
      persistDecisionTelemetry(input: unknown): unknown;
      modelMessages: unknown;
    };

export function prepareOpenAIChatProviderRuntime(
  input: OpenAIChatProviderPreparationInput,
): OpenAIChatProviderPreparationResult {
  const { resolved, session, normalizedRequest, routePersistence, config, logger } = input;
  const { adapter } = resolved;
  const resolvedTierForHarness = input.tierRegistry.getTierConfig(resolved.resolvedModelId);
  const providerForHarness = resolvedTierForHarness
    ? input.resolveEndpointCapabilityId(resolvedTierForHarness.baseUrl)
    : undefined;
  const architectureProfileSource = parseArchitectureProfileSourceContract({
    headers: input.headers ?? null,
    metadata: recordOrNull(input.request.metadata),
    extraBody: recordOrNull(input.request.extra_body),
  });
  const architectureProfile = architectureProfileSource === "raw"
    ? defaultConservativeArchitectureProfile(
        resolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
        providerForHarness,
        resolvedTierForHarness?.contextCeilingTokens,
      )
    : resolveModelArchitectureProfile({
        modelId: resolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
        provider: providerForHarness,
        family: adapter.family,
        modelCapabilityPreset: resolvedTierForHarness?.modelCapabilityPreset,
        declaredContextTokens: resolvedTierForHarness?.contextCeilingTokens,
        override: architectureProfileSource === "model-registry" ? resolvedTierForHarness?.architectureProfile : null,
      });
  const architectureMediationMode = parseArchitectureMediationModeContract({
    headers: input.headers ?? null,
    metadata: recordOrNull(input.request.metadata),
    extraBody: recordOrNull(input.request.extra_body),
    configMode: firstString(resolvedTierForHarness?.defaultContextMediationMode, config.SYNESIS_YARN_ARCHITECTURE_MEDIATION_MODE),
  });
  const modelExecutionPolicy = applyArchitectureMediationMode(
    deriveModelExecutionPolicy(architectureProfile),
    architectureMediationMode,
  );
  const upperHarness = buildYarnUpperHarnessContext({
    surface: "openai",
    modelId: resolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
    requestedModel: String(input.request.model ?? ""),
    baseUrl: resolvedTierForHarness?.baseUrl,
    provider: providerForHarness,
  });
  const rawTools = ((normalizedRequest.tools as unknown[]) ?? []);
  const toolPreparation = prepareRouteTools({
    rawTools,
    adapter: adapter as never,
    clientCapabilities: input.clientToolCapabilities as never,
    clientKind: input.clientKind,
    phase: input.orchestration.phase as never,
    profileToolBudgetCap: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && input.isOpenClawProfile(input.adapterProfile)
      ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
      : input.adapterProfile.features.toolSchemaBudgetCap,
    pruningEnabled: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED,
    pruningMaxOverride: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE,
    toolChoice: normalizedRequest.tool_choice,
    latestUserContent: input.latestUserText?.content,
    recentCallMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    recoveryMessages: input.normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    toolLoopSteeringEnabled: input.adapterUsesToolLoopSteering(adapter.family),
    harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
    requestId: input.requestId,
    stats: input.toolArgHardeningStats as never,
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
      result: {
        kind: "error",
        statusCode: 400,
        body: {
          error: {
            type: "invalid_request_error",
            message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
          },
        },
      },
    };
  }

  const forceReadRecovery = Boolean(
    session.editMissForceReadPending
    && input.executionGovernor.matchedRules.includes("edit_failure_replay"),
  );
  const phaseApplication = applyRoutePhasePolicy({
    adapterFamily: adapter.family,
    basePolicyEnabled: Boolean(config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED && input.phasePolicyEnabledByMatrix),
    policyEnabledByMatrix: input.phasePolicyEnabledByMatrix,
    enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
    phase: input.governorPhase,
    matchedRules: input.executionGovernor.matchedRules,
    stream: !!normalizedRequest.stream,
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
  const sdkTools = openAIToolsToSDK(effectiveTools as never);
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
    || (input.sensemakingDecision && input.sensemakingDecision.responseLevel !== "allow")
  );
  modelMessages = applyRouteAdapterPivot({
    surface: "openai",
    adapter: adapter as never,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    modelMessages: modelMessages as Array<{ role: string; content?: unknown }>,
    normalizedMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
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
    dampeningLogEvent: "adapter_dampening_oai",
    logger,
    appendSystemMessageAndNormalize: (messagesToAppend, content) => appendSystemMessageAndNormalize(
      messagesToAppend,
      content,
    ) as typeof messagesToAppend,
    recordSessionEvent: routePersistence.recordSessionEvent,
  }).modelMessages as unknown;

  modelMessages = normalizeSystemMessageOrdering(modelMessages as Array<{ role: string }>) as typeof modelMessages;

  const resolvedTierConfig = input.tierRegistry.getTierConfig(resolved.resolvedModelId);
  const providerRequestOptions = buildOpenAIChatProviderRequestOptions({
    request: input.request as never,
    tierSamplingDefaults: resolvedTierConfig?.samplingDefaults as never,
    adapterProviderOptions: adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined,
    adapterSampling: adapter.defaultSamplingParams?.(),
    supportsTopK: adapter.family !== "minimax",
  });
  const samplingOptions = providerRequestOptions.samplingOptions;
  const structuredOutput = providerRequestOptions.structuredOutput;
  let providerOptions = providerRequestOptions.providerOptions;
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
        path: "openai",
        phase: input.governorPhase,
        phase_reason: phasePolicy.reason ?? null,
      },
    );
  }
  const admissionResult = runRouteContextAdmission({
    surface: "openai",
    messages: modelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
    tools: effectiveTools,
    sessionKey: input.sessionKey,
    logRequestId: input.requestId,
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
      result: {
        kind: "error",
        statusCode: 400,
        body: {
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
      },
    };
  }
  const cacheShapeDiagnostics = buildCacheShapeDiagnostics({
    messages: modelMessages as Array<{ role?: string; content?: unknown }>,
    tools: effectiveTools,
    providerOptions,
    cachePolicy: input.cachePolicy,
    modelProviderResolution: {
      surface: "openai",
      requestedModel: input.request.model,
      resolvedModelId: resolved.resolvedModelId,
      adapterFamily: adapter.family,
      backendModel: resolvedTierForHarness?.backendModel ?? resolvedTierConfig?.backendModel,
      modelCapabilityPreset: resolvedTierForHarness?.modelCapabilityPreset ?? resolvedTierConfig?.modelCapabilityPreset,
      baseUrl: resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl,
      provider: (resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl)
        ? input.resolveEndpointCapabilityId((resolvedTierForHarness?.baseUrl ?? resolvedTierConfig?.baseUrl) as string)
        : undefined,
    },
  });
  input.optimizationLedger.recordCacheDiagnostics(cacheShapeDiagnostics as Record<string, unknown>);
  input.optimizationLedger.recordCacheDiagnostics({
    architectureAttention: architectureProfile.attention,
    architectureActivation: architectureProfile.activation,
    architectureDecoding: architectureProfile.decoding,
    executionPolicyHash: modelExecutionPolicy.policyHash,
    effectiveContextCeilingTokens: modelExecutionPolicy.effectiveContextCeilingTokens,
    architecturePolicyReasons: modelExecutionPolicy.reasons,
    architectureProfileSource,
  });
  routePersistence.recordSessionEvent(
    "model_architecture_profile_selected",
    "model-architecture",
    `attention=${architectureProfile.attention} activation=${architectureProfile.activation} decoding=${architectureProfile.decoding}`,
    { ...architecturePolicyTrace(architectureProfile, modelExecutionPolicy), architecture_profile_source: architectureProfileSource },
  );

  const telemetryRouteBase = createOpenAIChatRouteTelemetryBase({
    clientRequestedModel: String(input.request.model ?? ""),
    reductions: input.reductions as never,
    reducedToolResults: input.reducedToolResults,
    orchestration: input.orchestration as never,
    policyMatchedRules: input.policyPrecheck.matchedRules,
    evidencePrefetched: input.evidence.prefetched,
    evidenceConfidence: input.evidence.confidence,
    evidenceAuthoritative: input.evidence.prefetchResult?.authoritative as never,
    evidencePrefetchLatencyMs: input.evidence.prefetchResult?.latencyMs
      ? Math.round(Number(input.evidence.prefetchResult.latencyMs))
      : undefined,
    evidenceQuality: input.buildEvidenceTraceSummary(input.evidence.prefetchResult, input.evidence.patternResult) as never,
    sensemakingTriggered: input.sensemakingResult?.triggered,
    sensemakingReason: input.sensemakingResult?.reason,
    governorDecision: input.executionGovernor as never,
    governorChatStateSummary: input.governorSummaries.chat as never,
    governorFileStateSummary: input.governorSummaries.file as never,
    normalizedMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    inferVerificationSteps: input.inferVerificationSteps as never,
    trajectoryDiagnostics: input.trajectoryDiagnostics as never,
    toolDefinitionCount: effectiveTools.length,
    artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
    knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
    promptProfileIds: input.enriched.promptProfileIds,
    promptProfileHashes: input.enriched.promptProfileHashes,
    prefixHash: input.enriched.prefixHash,
    prefixChangeReasons: input.enriched.prefixChangeReasons,
    requirementChecklistMust: input.requirementChecklist?.must.length || undefined,
    requirementChecklistShould: input.requirementChecklist?.should.length || undefined,
    contextAdmission: {
      decision: contextAdmission.decision,
      reason: contextAdmission.reason,
      estimatedTokens: contextAdmission.estimatedTokens,
      estimatedChars: contextAdmission.estimatedChars,
    },
    cacheShapeDiagnostics,
    countMessageRoles,
    pushDiagnostic: input.pushDiagnostic,
  });
  const finalizerRouteBase = createOpenAIChatRouteFinalizerBase({
    session,
    checklist: input.requirementChecklist,
    traceRootPrompt: input.getMetadataString(session.record.metadata, "trace_root_prompt"),
    latestUserPrompt: input.getMetadataString(session.record.metadata, "latest_user_prompt"),
    verification: input.verificationAssessment,
    recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
    planGraph: input.planGraph,
    responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    applyMarkdownGuardrail: input.applyMarkdownGuardrail,
    finalizeCompletionText: input.finalizeCompletionText as never,
  });
  const toolHandlingRouteBase = createOpenAIChatRouteToolHandlingBase({
    adapter: adapter as never,
    clientKind: input.clientKind,
    effectiveTools,
    strictGovernance: input.openClawStrictGovernance,
    upperHarness: upperHarness as never,
    recentToolNames: recentCallsForSteering.map((call) => call.toolName),
    taskCue: input.taskCue,
    planModeRequested: Boolean(input.clientToolCapabilities.planModeRequested),
    sensemakingRestrictDiscovery: input.sensemakingDecision?.shouldRestrictDiscovery,
    pathContext: input.effectivePathContext as never,
    enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
    blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
    pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
    artifactShadows: input.artifactShadows as never,
    normalizedMessageCount: (input.normalizedOpenAI.messages as Array<{ role: string }>).length,
    session,
    stats: input.toolArgHardeningStats as never,
    logger: logger as never,
    isWriteCapableToolName: input.isWriteCapableToolName,
    shouldRestrictDiscoveryForPlanWork: input.shouldRestrictDiscoveryForPlanWork,
    deserializePlanShadow: input.deserializeShadow as never,
    buildPathSandboxPolicy: input.buildDefaultPolicy as never,
  });

  return {
    ok: true,
    adapter,
    upperHarness,
    effectiveTools,
    sdkTools,
    effectiveToolChoice,
    providerOptions,
    structuredOutput,
    samplingOptions,
    phasePolicy,
    forensicsPhasePolicy,
    telemetryRouteBase,
    finalizerRouteBase,
    toolHandlingRouteBase,
    persistDecisionTelemetry: routePersistence.persistDecisionTelemetry,
    modelMessages,
  };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
