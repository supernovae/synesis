import { generateText as aiGenerateText } from "ai";

import type { AppConfig } from "../config.js";
import type { ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { SessionState } from "../state/session-state.js";
import type { YarnPromptIntakeResult } from "../upper-harness/bridge.js";
import {
  buildChecklistFromPrompt,
  type RequirementChecklist,
} from "../validation/requirement-coverage.js";
import {
  buildPlannerTodoPacketPrompt,
  buildFallbackPlannerTodoPacket,
  deserializePlannerTodoPacket,
  formatPlannerTodoPacketBlock,
  parsePlannerTodoPacket,
  plannerTodoPacketToHarnessTasks,
  serializePlannerTodoPacket,
  shouldGeneratePlannerTodoPacket,
} from "./planner-todo-packet.js";
import { buildTaskIntake, type TaskIntake } from "./task-intake.js";
import {
  advancePlanGraph,
  createPlanGraph,
  deserializePlanGraph,
  type PlanGraph,
} from "./plan-graph.js";
import {
  createEmptyLedger,
  reconcileFromText,
} from "../task-ledger/index.js";
import { extractRecentToolNames } from "../pipeline/route-tool-preparation.js";

type GenerateTextFn = typeof aiGenerateText;

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

interface PlannerTierRegistryLike {
  setCurrentRequestContext(context: {
    sessionKey: string;
    requestId: string;
    clientKind: SessionIdentity["clientKind"];
  }): void;
  resolve(modelId: string, fallback: string): {
    model: unknown;
    resolvedModelId: string;
  };
}

export interface PlanningStateHelpers {
  getChecklistSourceHash(meta: Record<string, unknown>): string;
  maybeBuildPlannerTodoPacketBlock(options: {
    session: SessionState;
    sessionKey: string;
    identity: SessionIdentity;
    requestId: string;
    surface: "openai" | "claude";
    latestUserPrompt: string;
    promptIntake: YarnPromptIntakeResult;
    clientToolCapabilities: ClientToolCapabilities;
  }): Promise<string | null>;
  parsePlanGraph(meta: Record<string, unknown>): PlanGraph | null;
  persistPromptIntakeSnapshot(state: SessionState, result: YarnPromptIntakeResult): void;
  recordPromptIntakeEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    surface: string,
    result: YarnPromptIntakeResult,
  ): void;
  refreshRequirementChecklist(state: SessionState): RequirementChecklist | null;
  refreshTaskIntake(state: SessionState): TaskIntake | null;
  updatePlanGraph(
    state: SessionState,
    intake: TaskIntake | null,
    messages: Array<{ role: string; content: unknown }>,
    verificationFailures: number,
  ): PlanGraph | null;
}

export interface PlanningStateHelpersInput {
  config: AppConfig;
  tierRegistry: PlannerTierRegistryLike;
  generateText: GenerateTextFn;
  clampMaxOutputTokensForSafety(n: number): number;
  hashTextSignal(value: unknown): string;
  getMetadataString(meta: Record<string, unknown>, key: string): string;
  recordSessionEvent: RecordSessionEventFn;
  logger: {
    warn(obj: Record<string, unknown>, message: string): void;
  };
}

function buildRequirementChecklistSnapshot(checklist: RequirementChecklist): Record<string, unknown> {
  return {
    version: checklist.version,
    sourceHash: checklist.sourceHash,
    sourcePreview: checklist.sourcePreview,
    updatedAt: Date.now(),
    must: checklist.must.map((r) => ({ id: r.id, title: r.title })),
    should: checklist.should.map((r) => ({ id: r.id, title: r.title })),
  };
}

function buildTaskIntakeSnapshot(intake: TaskIntake): Record<string, unknown> {
  return {
    sourceHash: intake.sourceHash,
    sourcePreview: intake.sourcePreview,
    acceptanceCriteriaCount: intake.acceptanceCriteria.length,
    rubric: intake.rubric,
    updatedAt: Date.now(),
  };
}

function classifyPlannerTodoFailure(err: unknown): "timeout" | "abort" | "provider_error" {
  if (!err || typeof err !== "object") return "provider_error";
  const row = err as { name?: unknown; message?: unknown };
  const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
  const message = typeof row.message === "string" ? row.message.toLowerCase() : "";
  if (name.includes("timeout") || message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (name.includes("abort") || message.includes("aborted")) return "abort";
  return "provider_error";
}

export function parsePlanGraph(meta: Record<string, unknown>): PlanGraph | null {
  const raw = meta.plan_graph;
  if (!raw || typeof raw !== "object") return null;
  return deserializePlanGraph(raw as Record<string, unknown>);
}

export function getChecklistSourceHash(meta: Record<string, unknown>): string {
  const row = meta.requirement_checklist;
  if (!row || typeof row !== "object") return "";
  const value = (row as Record<string, unknown>).sourceHash;
  return typeof value === "string" ? value : "";
}

export function createPlanningStateHelpers(input: PlanningStateHelpersInput): PlanningStateHelpers {
  function refreshRequirementChecklist(state: SessionState): RequirementChecklist | null {
    const rootPrompt = input.getMetadataString(state.record.metadata, "trace_root_prompt");
    if (!rootPrompt) return null;
    const sourceHash = input.hashTextSignal(rootPrompt);
    if (!sourceHash) return null;
    const checklist = buildChecklistFromPrompt(rootPrompt, sourceHash);
    state.record.metadata.requirement_checklist = buildRequirementChecklistSnapshot(checklist);
    return checklist;
  }

  function persistPromptIntakeSnapshot(
    state: SessionState,
    result: YarnPromptIntakeResult,
  ): void {
    state.record.metadata.prompt_intake = result.metadataSnapshot;
    state.record.metadata.prompt_scope = result.decision.scope;
    state.record.metadata.prompt_intake_source_hash = result.decision.source_hash;
    state.record.metadata.prompt_intake_planning_steered = result.shouldAppend;
    state.record.metadata.prompt_intake_override = result.decision.override;
  }

  function recordPromptIntakeEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    surface: string,
    result: YarnPromptIntakeResult,
  ): void {
    if (result.decision.scope === "micro" && !result.shouldAppend && !result.decision.override) return;
    const planMode = result.metadataSnapshot.plan_mode_requested === true ? " plan_mode=true" : "";
    input.recordSessionEvent(
      sessionKey,
      userId,
      orgId,
      "prompt_intake_evaluated",
      "upper-harness",
      `${surface} scope=${result.decision.scope} action=${result.decision.action} steered=${result.shouldAppend} override=${result.decision.override}${planMode}`,
      requestId,
      result.metadataSnapshot,
    );
  }

  async function maybeBuildPlannerTodoPacketBlock(options: Parameters<PlanningStateHelpers["maybeBuildPlannerTodoPacketBlock"]>[0]): Promise<string | null> {
    const sourceHash = options.promptIntake.decision.source_hash || input.hashTextSignal(options.latestUserPrompt);
    if (!sourceHash) return null;
    const cachedSourceHash = input.getMetadataString(options.session.record.metadata, "planner_todo_packet_source_hash");
    const cachedPacket = cachedSourceHash === sourceHash
      ? deserializePlannerTodoPacket(options.session.record.metadata.planner_todo_packet)
      : null;
    const cachedModelId = input.getMetadataString(options.session.record.metadata, "planner_todo_packet_model");
    const effectiveExistingTaskCount = cachedSourceHash === sourceHash
      ? options.session.taskLedger?.tasks.length ?? 0
      : 0;

    const basePlannerTodoDecision = {
      enabled: input.config.SYNESIS_YARN_PLANNER_TODO_PACKET_ENABLED,
      governanceDisabled: input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      requireClientPlanningTool: input.config.SYNESIS_YARN_PLANNER_TODO_REQUIRE_NATIVE_TOOL,
      promptScope: options.promptIntake.decision.scope,
      planningSteered: options.promptIntake.shouldAppend,
      planningOverride: options.promptIntake.decision.override,
      planModeRequested: options.promptIntake.metadataSnapshot.plan_mode_requested === true
        || options.clientToolCapabilities.planModeRequested,
      capabilities: options.clientToolCapabilities,
    };
    const cachedPacketAllowed = shouldGeneratePlannerTodoPacket({
      ...basePlannerTodoDecision,
      existingTaskCount: effectiveExistingTaskCount,
    });
    if (cachedPacket && cachedPacketAllowed) {
      return formatPlannerTodoPacketBlock({
        packet: cachedPacket,
        sourceHash,
        modelId: cachedModelId || input.config.SYNESIS_YARN_PLANNER_TODO_MODEL,
        capabilities: options.clientToolCapabilities,
      });
    }

    const shouldGenerate = shouldGeneratePlannerTodoPacket({
      ...basePlannerTodoDecision,
      existingTaskCount: effectiveExistingTaskCount,
    });
    if (!shouldGenerate) return null;

    const plannerModelId = (input.config.SYNESIS_YARN_PLANNER_TODO_MODEL || "coder-horizon").trim() || "coder-horizon";
    let resolvedModelIdForTrace = plannerModelId;
    const plannerTimeoutMs = Math.max(500, input.config.SYNESIS_YARN_PLANNER_TODO_TIMEOUT_MS);
    const startedAt = Date.now();

    const persistPlannerPacket = (
      packet: NonNullable<ReturnType<typeof deserializePlannerTodoPacket>>,
      modelId: string,
      origin: "upreach" | "deterministic_fallback",
      failureKind?: string,
    ): void => {
      options.session.record.metadata.planner_todo_packet = serializePlannerTodoPacket(packet);
      options.session.record.metadata.planner_todo_packet_source_hash = sourceHash;
      options.session.record.metadata.planner_todo_packet_model = modelId;
      options.session.record.metadata.planner_todo_packet_updated_at = Date.now();
      options.session.record.metadata.planner_todo_packet_ambiguity = packet.ambiguity;
      options.session.record.metadata.planner_todo_packet_todos = packet.todos.length;
      options.session.record.metadata.planner_todo_packet_questions = packet.questions.length;
      options.session.record.metadata.planner_todo_packet_carrier = options.clientToolCapabilities.hasTodoTool
        ? "native_todo_tool"
        : "prompt_block";
      options.session.record.metadata.planner_todo_packet_origin = origin;
      options.session.record.metadata.planner_todo_packet_timeout_ms = plannerTimeoutMs;
      if (failureKind) {
        options.session.record.metadata.planner_todo_packet_failure_kind = failureKind;
      } else {
        delete options.session.record.metadata.planner_todo_packet_failure_kind;
      }

      if (!options.session.taskLedger || options.session.taskLedger.tasks.length === 0) {
        options.session.taskLedger = createEmptyLedger(
          options.session.record.sessionKey,
          Boolean(options.session.taskCapabilities?.hasExplicitTodoTool ?? options.clientToolCapabilities.hasTodoTool),
          Boolean(options.session.taskCapabilities?.hasExplicitPlanMode ?? options.clientToolCapabilities.planModeRequested),
        );
        options.session.taskLedger = reconcileFromText(
          options.session.taskLedger,
          plannerTodoPacketToHarnessTasks(packet, options.session.record.requestCount),
          options.session.record.requestCount,
        );
      }
    };

    const buildFallbackBlock = (failureKind: string, detail: string): string | null => {
      if (!input.config.SYNESIS_YARN_PLANNER_TODO_FALLBACK_ENABLED) return null;
      const fallbackPacket = buildFallbackPlannerTodoPacket({
        prompt: options.latestUserPrompt,
        sourceHash,
        reason: failureKind,
        maxPromptChars: Math.max(1000, input.config.SYNESIS_YARN_PLANNER_TODO_MAX_PROMPT_CHARS),
      });
      const fallbackModelId = `${resolvedModelIdForTrace}:fallback`;
      persistPlannerPacket(fallbackPacket, fallbackModelId, "deterministic_fallback", failureKind);
      input.recordSessionEvent(
        options.sessionKey,
        options.identity.userId,
        options.identity.orgId,
        "planner_todo_packet_fallback_generated",
        "planner-todo",
        `surface=${options.surface} model=${resolvedModelIdForTrace} failure=${failureKind} todos=${fallbackPacket.todos.length}`,
        options.requestId,
        {
          surface: options.surface,
          source_hash: sourceHash,
          model_id: resolvedModelIdForTrace,
          fallback_model_id: fallbackModelId,
          failure_kind: failureKind,
          failure_detail: detail.slice(0, 500),
          timeout_ms: plannerTimeoutMs,
          elapsed_ms: Date.now() - startedAt,
          todo_count: fallbackPacket.todos.length,
          carrier: options.clientToolCapabilities.hasTodoTool ? "native_todo_tool" : "prompt_block",
        },
      );
      return formatPlannerTodoPacketBlock({
        packet: fallbackPacket,
        sourceHash,
        modelId: fallbackModelId,
        capabilities: options.clientToolCapabilities,
      });
    };

    try {
      input.tierRegistry.setCurrentRequestContext({
        sessionKey: options.sessionKey,
        requestId: options.requestId,
        clientKind: options.identity.clientKind,
      });
      const resolved = input.tierRegistry.resolve(plannerModelId, "synesis-horizon");
      resolvedModelIdForTrace = resolved.resolvedModelId;
      const plannerPrompt = buildPlannerTodoPacketPrompt({
        prompt: options.latestUserPrompt,
        sourceHash,
        capabilities: options.clientToolCapabilities,
        maxPromptChars: Math.max(1000, input.config.SYNESIS_YARN_PLANNER_TODO_MAX_PROMPT_CHARS),
      });
      const result = await input.generateText({
        model: resolved.model as never,
        maxOutputTokens: input.clampMaxOutputTokensForSafety(
          Math.max(300, input.config.SYNESIS_YARN_PLANNER_TODO_MAX_OUTPUT_TOKENS),
        ),
        messages: [
          {
            role: "system",
            content: "Return strict JSON only. You are planning for another coding model; never write implementation code.",
          },
          { role: "user", content: plannerPrompt },
        ] as never,
        abortSignal: AbortSignal.timeout(plannerTimeoutMs),
      });
      const parsed = parsePlannerTodoPacket(result.text);
      if (!parsed.packet) {
        input.recordSessionEvent(
          options.sessionKey,
          options.identity.userId,
          options.identity.orgId,
          "planner_todo_packet_failed",
          "planner-todo",
          `surface=${options.surface} model=${resolved.resolvedModelId} parse_error=${parsed.parseError ?? "unknown"}`,
          options.requestId,
          {
            surface: options.surface,
            source_hash: sourceHash,
            model_id: resolved.resolvedModelId,
            parse_error: parsed.parseError ?? "unknown",
            timeout_ms: plannerTimeoutMs,
            elapsed_ms: Date.now() - startedAt,
          },
        );
        return buildFallbackBlock("parse_error", parsed.parseError ?? "unknown");
      }

      persistPlannerPacket(parsed.packet, resolved.resolvedModelId, "upreach");

      input.recordSessionEvent(
        options.sessionKey,
        options.identity.userId,
        options.identity.orgId,
        "planner_todo_packet_generated",
        "planner-todo",
        `surface=${options.surface} model=${resolved.resolvedModelId} todos=${parsed.packet.todos.length} questions=${parsed.packet.questions.length} ambiguity=${parsed.packet.ambiguity}`,
        options.requestId,
        {
          surface: options.surface,
          source_hash: sourceHash,
          model_id: resolved.resolvedModelId,
          todo_count: parsed.packet.todos.length,
          question_count: parsed.packet.questions.length,
          ambiguity: parsed.packet.ambiguity,
          todo_tool: options.clientToolCapabilities.todoToolName,
          question_tool: options.clientToolCapabilities.questionToolName,
          carrier: options.clientToolCapabilities.hasTodoTool ? "native_todo_tool" : "prompt_block",
          timeout_ms: plannerTimeoutMs,
          elapsed_ms: Date.now() - startedAt,
        },
      );

      return formatPlannerTodoPacketBlock({
        packet: parsed.packet,
        sourceHash,
        modelId: resolved.resolvedModelId,
        capabilities: options.clientToolCapabilities,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const failureKind = classifyPlannerTodoFailure(err);
      input.logger.warn({
        err,
        sessionKey: options.sessionKey,
        surface: options.surface,
        modelId: resolvedModelIdForTrace,
        failureKind,
        timeoutMs: plannerTimeoutMs,
        elapsedMs: Date.now() - startedAt,
      }, "planner_todo_packet_failed");
      input.recordSessionEvent(
        options.sessionKey,
        options.identity.userId,
        options.identity.orgId,
        "planner_todo_packet_failed",
        "planner-todo",
        `surface=${options.surface} model=${resolvedModelIdForTrace} failure=${failureKind} ${detail.slice(0, 200)}`,
        options.requestId,
        {
          surface: options.surface,
          source_hash: sourceHash,
          configured_model_id: plannerModelId,
          model_id: resolvedModelIdForTrace,
          failure_kind: failureKind,
          timeout_ms: plannerTimeoutMs,
          elapsed_ms: Date.now() - startedAt,
          error: detail.slice(0, 500),
        },
      );
      return buildFallbackBlock(failureKind, detail);
    }
  }

  function refreshTaskIntake(state: SessionState): TaskIntake | null {
    if (!input.config.SYNESIS_YARN_TASK_INTAKE_ENABLED) return null;
    const rootPrompt = input.getMetadataString(state.record.metadata, "trace_root_prompt");
    if (!rootPrompt) return null;
    const sourceHash = input.hashTextSignal(rootPrompt);
    if (!sourceHash) return null;
    const intake = buildTaskIntake(rootPrompt, sourceHash);
    state.record.metadata.task_intake = buildTaskIntakeSnapshot(intake);
    return intake;
  }

  function updatePlanGraph(
    state: SessionState,
    intake: TaskIntake | null,
    messages: Array<{ role: string; content: unknown }>,
    verificationFailures: number,
  ): PlanGraph | null {
    if (!input.config.SYNESIS_YARN_PLAN_GRAPH_ENABLED || !intake) return null;
    const existing = parsePlanGraph(state.record.metadata);
    const base = !existing || existing.sourceHash !== intake.sourceHash
      ? createPlanGraph(intake)
      : existing;
    const recentTools = extractRecentToolNames(messages);
    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const advanced = advancePlanGraph(base, {
      recentToolNames: recentTools,
      latestAssistantText: typeof latestAssistant?.content === "string" ? latestAssistant.content : "",
      verificationFailures,
    });
    state.record.metadata.plan_graph = advanced as unknown as Record<string, unknown>;
    return advanced;
  }

  return {
    getChecklistSourceHash,
    maybeBuildPlannerTodoPacketBlock,
    parsePlanGraph,
    persistPromptIntakeSnapshot,
    recordPromptIntakeEvent,
    refreshRequirementChecklist,
    refreshTaskIntake,
    updatePlanGraph,
  };
}
