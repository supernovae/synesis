import type { GovernorPauseAction, GovernorPauseEnvelope } from "./execution-governor.js";

export const GOVERNOR_PAUSE_CONTEXT_METADATA_KEY = "governor_pause_context";
export const GOVERNOR_PAUSE_PENDING_METADATA_KEY = "governor_pause_pending";
export const GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION = "synesis_governor_pause_context_v1";

export type GovernorPauseSurface = "openai" | "claude";

export interface GovernorPauseContextSnapshot {
  schema_version: typeof GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION;
  surface: GovernorPauseSurface;
  request_id: string;
  updated_at: number;
  pause_reason: string;
  matched_rules: string[];
  recovery_attempts_used: number;
  hard_stop_threshold: number;
  user_facing_explanation: string;
  concrete_nudge: string;
  resume_hint: string;
  default_recommended_action: string;
  next_actions: Array<Pick<GovernorPauseAction, "id" | "label" | "description">>;
  question_tool_name: string | null;
  pause_message: string;
  chat_state_summary?: GovernorPauseEnvelope["chat_state_summary"];
  file_state_summary?: GovernorPauseEnvelope["file_state_summary"];
}

function compactText(value: unknown, maxChars: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function promptControlText(value: unknown, maxChars: number): string {
  return compactText(value, maxChars)
    .replace(/[<>"'`&]/g, "_")
    .replace(/=/g, ":")
    .trim();
}

function quotedPromptControl(value: unknown, maxChars: number): string {
  return JSON.stringify(promptControlText(value, maxChars));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function parseAction(value: unknown): Pick<GovernorPauseAction, "id" | "label" | "description"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = compactText(raw.id, 80);
  const label = compactText(raw.label, 120);
  const description = compactText(raw.description, 240);
  if (!id || !label) return null;
  return { id, label, description };
}

export function buildGovernorPauseContextSnapshot(params: {
  surface: GovernorPauseSurface;
  requestId: string;
  envelope: GovernorPauseEnvelope;
  pauseMessage: string;
  questionToolName?: string | null;
  now?: number;
}): GovernorPauseContextSnapshot {
  const questionToolName = compactText(params.questionToolName ?? params.envelope.interactive_question?.tool_name ?? "", 120);
  return {
    schema_version: GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION,
    surface: params.surface,
    request_id: compactText(params.requestId, 160),
    updated_at: params.now ?? Date.now(),
    pause_reason: compactText(params.envelope.pause_reason, 120),
    matched_rules: params.envelope.matched_rules.map((rule) => compactText(rule, 120)).filter(Boolean),
    recovery_attempts_used: params.envelope.recovery_attempts_used,
    hard_stop_threshold: params.envelope.hard_stop_threshold,
    user_facing_explanation: compactText(params.envelope.user_facing_explanation, 600),
    concrete_nudge: compactText(params.envelope.concrete_nudge, 600),
    resume_hint: compactText(params.envelope.resume_hint, 800),
    default_recommended_action: compactText(params.envelope.default_recommended_action, 120),
    next_actions: params.envelope.next_actions.map((action) => ({
      id: compactText(action.id, 80),
      label: compactText(action.label, 120),
      description: compactText(action.description, 240),
    })),
    question_tool_name: questionToolName || null,
    pause_message: compactText(params.pauseMessage, 1200),
    chat_state_summary: params.envelope.chat_state_summary,
    file_state_summary: params.envelope.file_state_summary,
  };
}

export function parseGovernorPauseContextSnapshot(raw: unknown): GovernorPauseContextSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION) return null;
  const surface = obj.surface === "claude" || obj.surface === "openai" ? obj.surface : null;
  if (!surface) return null;
  const nextActions = Array.isArray(obj.next_actions)
    ? obj.next_actions.map(parseAction).filter((action): action is Pick<GovernorPauseAction, "id" | "label" | "description"> => Boolean(action))
    : [];
  return {
    schema_version: GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION,
    surface,
    request_id: compactText(obj.request_id, 160),
    updated_at: Number(obj.updated_at ?? 0) || 0,
    pause_reason: compactText(obj.pause_reason, 120),
    matched_rules: stringArray(obj.matched_rules).map((rule) => compactText(rule, 120)),
    recovery_attempts_used: Number(obj.recovery_attempts_used ?? 0) || 0,
    hard_stop_threshold: Number(obj.hard_stop_threshold ?? 0) || 0,
    user_facing_explanation: compactText(obj.user_facing_explanation, 600),
    concrete_nudge: compactText(obj.concrete_nudge, 600),
    resume_hint: compactText(obj.resume_hint, 800),
    default_recommended_action: compactText(obj.default_recommended_action, 120),
    next_actions: nextActions,
    question_tool_name: compactText(obj.question_tool_name, 120) || null,
    pause_message: compactText(obj.pause_message, 1200),
    chat_state_summary: obj.chat_state_summary as GovernorPauseContextSnapshot["chat_state_summary"],
    file_state_summary: obj.file_state_summary as GovernorPauseContextSnapshot["file_state_summary"],
  };
}

export function isGovernorPauseSummaryRequest(text: string): boolean {
  const normalized = compactText(text, 1000).toLowerCase();
  if (!normalized) return false;
  if (/^(?:option\s*)?3(?:[.)\s]|$)/i.test(normalized)) return true;
  return [
    /\bstop\s+(?:and\s+)?summari[sz]e\b/,
    /\bsummari[sz](?:e|ing|ation)\b/,
    /\bsummary\b/,
    /\bcurrent status\b/,
    /\bstatus\b.*\b(?:blocked|stuck|missing|left|fix|trying)\b/,
    /\bwhat\s+(?:we(?:'re| are)|we are)\s+trying\s+to\s+fix\b/,
    /\bwhat(?:'s| is)\s+(?:still\s+)?(?:missing|left)\b/,
    /\bhandoff\b/,
  ].some((pattern) => pattern.test(normalized));
}

export function buildGovernorPauseResumeBlock(
  snapshot: GovernorPauseContextSnapshot,
  latestUserPrompt: string,
): string {
  const nextActions = snapshot.next_actions
    .map((action) => {
      const id = promptControlText(action.id, 80);
      const label = promptControlText(action.label, 120);
      const description = promptControlText(action.description, 240);
      return `${id}: ${label} - ${description}`;
    })
    .join("; ");
  const chatState = snapshot.chat_state_summary
    ? compactText(JSON.stringify(snapshot.chat_state_summary), 900)
    : "";
  const fileState = snapshot.file_state_summary
    ? compactText(JSON.stringify(snapshot.file_state_summary), 900)
    : "";

  return [
    `<SYNESIS_GOVERNOR_PAUSE_RECOVERY mode="summarize_and_stop" version="${GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION}">`,
    `user_request: ${quotedPromptControl(latestUserPrompt, 500)}`,
    `instruction: ${quotedPromptControl("The user selected stop/summarize/status after a governor pause. Reply with a concise current-status summary only. Do not call tools, restart servers, retry commands, edit files, or restate a fresh plan.", 500)}`,
    `surface: ${quotedPromptControl(snapshot.surface, 40)}`,
    `pause_request_id: ${quotedPromptControl(snapshot.request_id, 160)}`,
    `pause_reason: ${quotedPromptControl(snapshot.pause_reason, 120)}`,
    `matched_rules: ${quotedPromptControl(snapshot.matched_rules.join(","), 400)}`,
    `recovery_attempts_used: ${quotedPromptControl(snapshot.recovery_attempts_used, 40)}`,
    `user_facing_explanation: ${quotedPromptControl(snapshot.user_facing_explanation, 600)}`,
    `concrete_nudge: ${quotedPromptControl(snapshot.concrete_nudge, 600)}`,
    `default_recommended_action: ${quotedPromptControl(snapshot.default_recommended_action, 120)}`,
    `next_actions: ${quotedPromptControl(nextActions, 900)}`,
    snapshot.question_tool_name ? `question_tool: ${quotedPromptControl(snapshot.question_tool_name, 120)}` : "",
    snapshot.pause_message ? `previous_pause_message: ${quotedPromptControl(snapshot.pause_message, 1200)}` : "",
    snapshot.resume_hint ? `resume_hint: ${quotedPromptControl(snapshot.resume_hint, 800)}` : "",
    chatState ? `chat_state_summary: ${quotedPromptControl(chatState, 900)}` : "",
    fileState ? `file_state_summary: ${quotedPromptControl(fileState, 900)}` : "",
    "</SYNESIS_GOVERNOR_PAUSE_RECOVERY>",
  ].filter(Boolean).join("\n");
}
