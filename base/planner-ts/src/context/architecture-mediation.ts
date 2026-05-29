import {
  applyArchitectureMediationMode,
  architecturePolicyTrace,
  buildArchitecturePolicySystemHint,
  buildContextMediationArtifacts,
  deriveModelExecutionPolicy,
  filterContextBlocksForMediation,
  resolveArchitectureMediationMode,
  resolveArchitectureProfileSource,
  resolveModelArchitectureProfile,
  type ArchitectureMediationMode,
  type ArchitectureProfileSource,
  type ContextMediationArtifacts,
  type ModelArchitectureProfile,
  type ModelExecutionPolicy,
} from "@synesis/upper-harness";
import { createHash } from "node:crypto";
import type { ChatMessage } from "./session-store.js";

export type PlannerChatProfile =
  | "general_assistant"
  | "tutoring_study"
  | "long_form_advisory"
  | "roleplay_creative_continuity"
  | "rag_grounded_answer";

export interface PlannerArchitectureMediation {
  profile: ModelArchitectureProfile;
  policy: ModelExecutionPolicy;
  profileSource: ArchitectureProfileSource;
  artifacts: ContextMediationArtifacts;
  chatProfile: PlannerChatProfile;
  activeStateHeader: string | null;
  systemHint: string | null;
  trace: Record<string, unknown>;
}

export interface ResolvePlannerArchitectureMediationInput {
  headers?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  configMode?: string | null;
  configSource?: string | null;
  requestedModel: string;
  writerModel?: string | null;
  provider?: string | null;
  family?: string | null;
  declaredContextTokens?: number | null;
  messages: ChatMessage[];
  taskDescription?: string | null;
  evidenceBlock?: string | null;
  plannerSignals?: {
    assumptions?: string[];
    openQuestions?: string[];
    commitments?: string[];
  };
}

export function refreshPlannerArchitectureMediation(
  current: PlannerArchitectureMediation | undefined,
  input: {
    messages: ChatMessage[];
    taskDescription?: string | null;
    evidenceBlock?: string | null;
    plannerSignals?: {
      assumptions?: string[];
      openQuestions?: string[];
      commitments?: string[];
    };
  },
): PlannerArchitectureMediation | undefined {
  if (!current) return undefined;
  const governanceBlocks = [
    plannerChatProfilePrompt(current.chatProfile),
    input.evidenceBlock ? `Evidence available for this turn:\n${input.evidenceBlock}` : "",
    ...(input.plannerSignals?.assumptions ?? []).map((item) => `Planner assumption: ${item}`),
    ...(input.plannerSignals?.openQuestions ?? []).map((item) => `Planner open question: ${item}`),
    ...(input.plannerSignals?.commitments ?? []).map((item) => `Planner commitment: ${item}`),
  ].filter((block) => block.trim().length > 0);
  const artifacts = buildContextMediationArtifacts({
    messages: input.messages,
    governanceBlocks,
    policy: current.policy,
    objective: input.taskDescription,
  });
  const activeStateHeader = current.policy.stateReinforcement.activeStateHeader
    ? buildPlannerActiveStateHeader({
        mode: current.policy.mediationMode,
        policy: current.policy,
        chatProfile: current.chatProfile,
        artifacts,
        taskDescription: input.taskDescription,
        plannerSignals: input.plannerSignals,
      })
    : null;
  const trace = {
    ...architecturePolicyTrace(current.profile, current.policy),
    architecture_profile_source: current.profileSource,
    chat_profile: current.chatProfile,
    hygiene_score: artifacts.hygieneReport.hygieneScore,
    active_state_header_hash: activeStateHeader ? shortHash(activeStateHeader) : null,
    fact_pin_count: artifacts.criticalFactPins.length,
    evidence_manifest_count: artifacts.evidenceManifest.length,
    verification_warnings: artifacts.verificationWarnings,
  };
  return {
    ...current,
    artifacts,
    activeStateHeader,
    trace,
  };
}

export function resolvePlannerArchitectureMediation(
  input: ResolvePlannerArchitectureMediationInput,
): PlannerArchitectureMediation {
  const modelId = input.writerModel?.trim() || input.requestedModel || "unknown";
  const profileSource = resolveArchitectureProfileSource({
    headers: input.headers,
    metadata: input.metadata,
    extraBody: input.extraBody,
    configSource: input.configSource,
  });
  const mode = resolveArchitectureMediationMode({
    headers: input.headers,
    metadata: input.metadata,
    extraBody: input.extraBody,
    configMode: input.configMode,
  });
  const profile = profileSource === "raw"
    ? resolveModelArchitectureProfile({ modelId: "unknown", family: "generic" })
    : resolveModelArchitectureProfile({
        modelId,
        provider: input.provider,
        family: input.family,
        declaredContextTokens: input.declaredContextTokens,
      });
  const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), mode);
  const chatProfile = inferPlannerChatProfile({
    messages: input.messages,
    taskDescription: input.taskDescription,
    hasEvidence: Boolean(input.evidenceBlock?.trim()),
  });
  const governanceBlocks = [
    plannerChatProfilePrompt(chatProfile),
    input.evidenceBlock ? `Evidence available for this turn:\n${input.evidenceBlock}` : "",
    ...(input.plannerSignals?.assumptions ?? []).map((item) => `Planner assumption: ${item}`),
    ...(input.plannerSignals?.openQuestions ?? []).map((item) => `Planner open question: ${item}`),
    ...(input.plannerSignals?.commitments ?? []).map((item) => `Planner commitment: ${item}`),
  ].filter((block) => block.trim().length > 0);
  const artifacts = buildContextMediationArtifacts({
    messages: input.messages,
    governanceBlocks,
    policy,
    objective: input.taskDescription,
  });
  const activeStateHeader = policy.stateReinforcement.activeStateHeader
    ? buildPlannerActiveStateHeader({
        mode,
        policy,
        chatProfile,
        artifacts,
        taskDescription: input.taskDescription,
        plannerSignals: input.plannerSignals,
      })
    : null;
  const systemHint = buildArchitecturePolicySystemHint(policy);
  const trace = {
    ...architecturePolicyTrace(profile, policy),
    architecture_profile_source: profileSource,
    chat_profile: chatProfile,
    hygiene_score: artifacts.hygieneReport.hygieneScore,
    active_state_header_hash: activeStateHeader ? shortHash(activeStateHeader) : null,
    fact_pin_count: artifacts.criticalFactPins.length,
    evidence_manifest_count: artifacts.evidenceManifest.length,
    verification_warnings: artifacts.verificationWarnings,
  };

  return {
    profile,
    policy,
    profileSource,
    artifacts,
    chatProfile,
    activeStateHeader,
    systemHint,
    trace,
  };
}

export function applyPlannerContextHygiene(
  messages: ChatMessage[],
  policy: ModelExecutionPolicy,
): { messages: ChatMessage[]; removedCount: number } {
  if (policy.mediationMode === "off" || policy.mediationMode === "observe") {
    return { messages, removedCount: 0 };
  }
  const candidates = messages.filter((message) => message.role !== "system");
  const filtered = filterContextBlocksForMediation(candidates.map((message) => message.content), policy);
  if (filtered.blocks.length === candidates.length) return { messages, removedCount: 0 };
  const remaining = new Map<string, number>();
  for (const block of filtered.blocks) {
    const key = canonicalBlock(block);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const retained = messages.filter((message) => {
    if (message.role === "system") return true;
    const key = canonicalBlock(message.content);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) return false;
    remaining.set(key, count - 1);
    return true;
  });
  return { messages: retained, removedCount: messages.length - retained.length };
}

export function plannerChatProfilePrompt(profile: PlannerChatProfile): string {
  switch (profile) {
    case "tutoring_study":
      return [
        "CHAT PROFILE: tutoring/study.",
        "Preserve the learner's level, last exercise state, and requested drill style.",
        "For short answers, continue the drill in context and give targeted feedback before moving on.",
      ].join("\n");
    case "long_form_advisory":
      return [
        "CHAT PROFILE: long-form advisory.",
        "Preserve stated goals, constraints, tradeoffs, and prior recommendations.",
        "Call out changed assumptions when the latest user message revises earlier context.",
      ].join("\n");
    case "roleplay_creative_continuity":
      return [
        "CHAT PROFILE: roleplay/creative continuity.",
        "Pin canon, character voice, scene location, unresolved beats, and user boundaries.",
        "Continue the scene from the latest turn; do not summarize or break character unless asked.",
      ].join("\n");
    case "rag_grounded_answer":
      return [
        "CHAT PROFILE: RAG-grounded answer.",
        "Ground factual claims in supplied evidence, preserve source IDs, and avoid unsupported citations.",
      ].join("\n");
    case "general_assistant":
      return [
        "CHAT PROFILE: general assistant.",
        "Answer the latest user request directly while preserving explicit constraints and preferences.",
      ].join("\n");
  }
}

function inferPlannerChatProfile(input: {
  messages: ChatMessage[];
  taskDescription?: string | null;
  hasEvidence: boolean;
}): PlannerChatProfile {
  if (input.hasEvidence) return "rag_grounded_answer";
  const text = [
    input.taskDescription ?? "",
    ...input.messages.slice(-8).map((message) => message.content),
  ].join("\n").toLowerCase();
  if (/\b(roleplay|rp\b|character|scene|canon|in character|narrat|dialogue|campaign|npc|persona)\b/.test(text)) {
    return "roleplay_creative_continuity";
  }
  if (/\b(tutor|teach|study|quiz|flashcard|practice|drill|homework|explain step|test me)\b/.test(text)) {
    return "tutoring_study";
  }
  if (/\b(strategy|roadmap|advice|recommend|trade[- ]?off|decision|plan over time|long[- ]?term)\b/.test(text)) {
    return "long_form_advisory";
  }
  return "general_assistant";
}

function buildPlannerActiveStateHeader(input: {
  mode: ArchitectureMediationMode;
  policy: ModelExecutionPolicy;
  chatProfile: PlannerChatProfile;
  artifacts: ContextMediationArtifacts;
  taskDescription?: string | null;
  plannerSignals?: {
    assumptions?: string[];
    openQuestions?: string[];
    commitments?: string[];
  };
}): string {
  const lines = [
    `<SYNESIS_PLANNER_ACTIVE_STATE mode="${input.mode}" policy_hash="${input.policy.policyHash}" chat_profile="${input.chatProfile}">`,
    `context_interpretation: ${input.policy.contextBudget.interpretation}`,
    `hygiene_score: ${input.artifacts.hygieneReport.hygieneScore}`,
  ];
  if (input.taskDescription?.trim()) {
    lines.push(`latest_user_task: ${trimLine(input.taskDescription, 260)}`);
  }
  const pins = input.artifacts.criticalFactPins.slice(0, 12);
  if (pins.length > 0) {
    lines.push("critical_fact_pins:");
    for (const pin of pins) {
      lines.push(`  - ${pin.id} ${pin.source}: ${trimLine(pin.text, 220)}`);
    }
  }
  const manifest = input.artifacts.evidenceManifest.slice(0, 12);
  if (manifest.length > 0) {
    lines.push("evidence_manifest:");
    for (const entry of manifest) {
      lines.push(`  - ${entry.blockId} ${entry.kind} critical=${entry.critical}: ${trimLine(entry.summary, 180)}`);
    }
  }
  for (const assumption of (input.plannerSignals?.assumptions ?? []).slice(0, 5)) {
    lines.push(`assumption: ${trimLine(assumption, 180)}`);
  }
  for (const question of (input.plannerSignals?.openQuestions ?? []).slice(0, 5)) {
    lines.push(`unresolved_question: ${trimLine(question, 180)}`);
  }
  lines.push("</SYNESIS_PLANNER_ACTIVE_STATE>");
  return lines.join("\n");
}

function canonicalBlock(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function trimLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 3))}...`;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
