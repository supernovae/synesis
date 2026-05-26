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

    try {
      input.tierRegistry.setCurrentRequestContext({
        sessionKey: options.sessionKey,
        requestId: options.requestId,
        clientKind: options.identity.clientKind,
      });
      const plannerModelId = (input.config.SYNESIS_YARN_PLANNER_TODO_MODEL || "coder-horizon").trim() || "coder-horizon";
      const resolved = input.tierRegistry.resolve(plannerModelId, "synesis-horizon");
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
        abortSignal: AbortSignal.timeout(Math.max(500, input.config.SYNESIS_YARN_PLANNER_TODO_TIMEOUT_MS)),
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
          },
        );
        return null;
      }

      options.session.record.metadata.planner_todo_packet = serializePlannerTodoPacket(parsed.packet);
      options.session.record.metadata.planner_todo_packet_source_hash = sourceHash;
      options.session.record.metadata.planner_todo_packet_model = resolved.resolvedModelId;
      options.session.record.metadata.planner_todo_packet_updated_at = Date.now();
      options.session.record.metadata.planner_todo_packet_ambiguity = parsed.packet.ambiguity;
      options.session.record.metadata.planner_todo_packet_todos = parsed.packet.todos.length;
      options.session.record.metadata.planner_todo_packet_questions = parsed.packet.questions.length;
      options.session.record.metadata.planner_todo_packet_carrier = options.clientToolCapabilities.hasTodoTool
        ? "native_todo_tool"
        : "prompt_block";

      if (!options.session.taskLedger || options.session.taskLedger.tasks.length === 0) {
        options.session.taskLedger = createEmptyLedger(
          options.session.record.sessionKey,
          Boolean(options.session.taskCapabilities?.hasExplicitTodoTool ?? options.clientToolCapabilities.hasTodoTool),
          Boolean(options.session.taskCapabilities?.hasExplicitPlanMode ?? options.clientToolCapabilities.planModeRequested),
        );
        options.session.taskLedger = reconcileFromText(
          options.session.taskLedger,
          plannerTodoPacketToHarnessTasks(parsed.packet, options.session.record.requestCount),
          options.session.record.requestCount,
        );
      }

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
      input.logger.warn({ err, sessionKey: options.sessionKey, surface: options.surface }, "planner_todo_packet_failed");
      input.recordSessionEvent(
        options.sessionKey,
        options.identity.userId,
        options.identity.orgId,
        "planner_todo_packet_failed",
        "planner-todo",
        `surface=${options.surface} ${detail.slice(0, 240)}`,
        options.requestId,
        {
          surface: options.surface,
          source_hash: sourceHash,
          model_id: input.config.SYNESIS_YARN_PLANNER_TODO_MODEL,
          error: detail.slice(0, 500),
        },
      );
      return null;
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
