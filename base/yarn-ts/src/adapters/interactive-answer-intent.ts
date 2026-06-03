export type InteractiveAnswerIntent =
  | "approve_plan"
  | "request_implementation"
  | "request_plan_changes"
  | "request_verification"
  | "decline"
  | "clarification_answer"
  | "unknown";

export interface InteractiveAnswerMessage {
  role?: string;
  content?: unknown;
  name?: string;
}

export interface InteractiveAnswerContext {
  planReadyContext?: boolean;
  questionContext?: boolean;
}

export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const row = item as Record<string, unknown>;
      return typeof row.text === "string" ? row.text
        : typeof row.content === "string" ? row.content
        : "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    const row = content as Record<string, unknown>;
    return typeof row.text === "string" ? row.text
      : typeof row.content === "string" ? row.content
      : "";
  }
  return "";
}

export function isQuestionToolName(value: unknown): boolean {
  const normalized = String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  return normalized === "question"
    || normalized === "askquestion"
    || normalized === "askuserquestion"
    || normalized === "askfollowupquestion"
    || normalized === "userquestion";
}

export function hasRecentPlanReadyPrompt(messages: InteractiveAnswerMessage[]): boolean {
  const recent = messages.slice(-12);
  return recent.some((message) => {
    const role = String(message.role ?? "").toLowerCase();
    if (role !== "assistant" && role !== "tool" && role !== "tool_result" && role !== "user") return false;
    const text = messageContentText(message.content).toLowerCase();
    return /\bready to code\??\b/.test(text)
      || /\bready for (?:your )?(?:review|approval)\b/.test(text)
      || /\bplan (?:is )?(?:ready|complete|done|prepared|created)\b/.test(text)
      || /\bplan (?:was|is) already approved\b/.test(text)
      || /\buser has approved your plan\b/.test(text)
      || /\byou can now start coding\b/.test(text)
      || /\bwould you like (?:me )?to proceed\b/.test(text)
      || /\bwould you like to proceed\?\b/.test(text)
      || String(message.name ?? "").toLowerCase().includes("exitplanmode");
  });
}

export function classifyInteractiveAnswerText(
  text: string,
  context: InteractiveAnswerContext = {},
): InteractiveAnswerIntent {
  const normalized = normalizeAnswerText(text);
  if (!normalized || normalized.startsWith("/plan")) return "unknown";
  const candidateTexts = answerCandidateTexts(normalized);
  const selectedAnswer = candidateTexts[0] ?? normalized;

  if (isPlanChangeRequest(selectedAnswer)) return "request_plan_changes";
  if (isDecline(selectedAnswer)) return "decline";
  if (isVerificationRequest(selectedAnswer)) return "request_verification";
  if (candidateTexts.some(isPlanApprovalText)) {
    return context.planReadyContext ? "approve_plan" : "request_implementation";
  }
  if (candidateTexts.some(isImplementationRequest)) {
    return context.planReadyContext ? "approve_plan" : "request_implementation";
  }
  if (context.questionContext && normalized.length <= 500) return "clarification_answer";
  return "unknown";
}

export function isPlanImplementationApprovalMessages(
  messages: InteractiveAnswerMessage[] | undefined | null,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const planReadyContext = hasRecentPlanReadyPrompt(messages);
  const latestUser = [...messages].reverse()
    .find((message) => String(message.role ?? "").toLowerCase() === "user");
  if (latestUser && classifyInteractiveAnswerText(messageContentText(latestUser.content), { planReadyContext }) === "approve_plan") {
    return true;
  }

  return messages.slice(-8).some((message) => {
    const role = String(message.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "tool_result" && role !== "user") return false;
    const text = messageContentText(message.content);
    if (/\buser has approved your plan\b/i.test(text) || /\byou can now start coding\b/i.test(text)) return true;
    const questionContext = role !== "user" || isQuestionToolName(message.name);
    return classifyInteractiveAnswerText(text, { planReadyContext, questionContext }) === "approve_plan";
  });
}

function normalizeAnswerText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function answerCandidateTexts(normalized: string): string[] {
  const candidates: string[] = [];
  const arrowParts = normalized.split(/\s*(?:→|=>)\s*/).map((part) => part.trim()).filter(Boolean);
  if (arrowParts.length > 1) candidates.push(arrowParts[arrowParts.length - 1]!);
  const answeredMatch = /\banswer(?:ed)?[:\s]+(.+)$/i.exec(normalized);
  if (answeredMatch?.[1]) candidates.push(answeredMatch[1].trim());
  candidates.push(normalized);
  return [...new Set(candidates.filter(Boolean))];
}

function isPlanApprovalText(normalized: string): boolean {
  if (normalized.length > 800) return false;
  if (normalized.length <= 140) {
    return /^(yes|y|ok|okay|approved|approve|yes, approved|yes auto-accept edits|yes, auto-accept edits|yes manually approve edits|yes, manually approve edits|continue|continue please|proceed|go ahead|do it|start|start coding|implement|implement it|implement the plan|build it|looks good|ready|ready to code)$/.test(normalized)
      || /\b(continue|proceed|implement|start|build|generate)\b.*\b(plan|coding|implementation|work|code)\b/.test(normalized);
  }
  return /(?:→|=>|answer(?:ed)?[:\s]).*\b(?:yes|approved|proceed|continue|implement|start|build|generate)\b.*\b(?:implementation|plan|work|coding|code|edits)\b/.test(normalized);
}

function isImplementationRequest(normalized: string): boolean {
  if (normalized.length > 800) return false;
  return /\b(?:proceed|continue|implement|start|build|generate)\s+(?:with\s+)?(?:the\s+)?(?:implementation|plan|work|coding|code)\b/.test(normalized)
    || /\b(?:write|create|generate)\s+(?:the\s+)?(?:code|files|project|implementation)\b/.test(normalized)
    || /(?:→|=>|answer(?:ed)?[:\s]).*\b(?:proceed|continue|implement|start|build|generate)\b.*\b(?:implementation|plan|work|coding|code|edits)\b/.test(normalized);
}

function isPlanChangeRequest(normalized: string): boolean {
  return /\b(?:tell|show)\s+(?:claude|agent|assistant)?\s*(?:what\s+)?to\s+change\b/.test(normalized)
    || /\b(?:change|revise|update|edit|modify)\s+(?:the\s+)?plan\b/.test(normalized)
    || /\bprefer\s+(?:a\s+)?different\s+(?:approach|plan|domain)\b/.test(normalized);
}

function isVerificationRequest(normalized: string): boolean {
  return /\b(?:run|do|perform)\s+(?:one\s+)?(?:targeted\s+)?verification\b/.test(normalized)
    || /\b(?:verify|test|check)\s+(?:it|this|the\s+build|the\s+plan)\s+(?:first|now)?\b/.test(normalized);
}

function isDecline(normalized: string): boolean {
  return /^(no|n|stop|cancel|abort|do not proceed|don't proceed|wait|pause)$/.test(normalized)
    || /\b(?:do not|don't)\s+(?:implement|proceed|continue|start|build)\b/.test(normalized);
}
