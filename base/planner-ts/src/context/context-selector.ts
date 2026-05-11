import { buildDomainProfile } from "../nodes/domain-profile.js";
import type { ChatMessage } from "./session-store.js";

export type ContextSelectionMode =
  | "latest_turn"
  | "referential_followup"
  | "same_topic_continuity"
  | "topic_shift";

export interface ContextSelectionMetadata {
  enabled: boolean;
  mode: ContextSelectionMode;
  selectedHistoryMessages: number;
  droppedHistoryMessages: number;
  inputMessages: number;
  outputMessages: number;
  latestUserChars: number;
}

export interface ContextSelectionResult {
  messages: ChatMessage[];
  metadata: ContextSelectionMetadata;
}

const REFERENTIAL_RE =
  /\b(earlier|previous|above|before|same|continue|expand|elaborate|clarify|what\s+did\s+you\s+mean|you\s+said|as\s+mentioned)\b/i;
const REFERENTIAL_LEADING_PRONOUN_RE = /^(that|this|these|those)\b/i;

function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .match(/\b[a-z][a-z0-9_-]{2,}\b/g) ?? [];
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "are", "was", "were", "have",
    "has", "had", "you", "your", "about", "from", "what", "why", "how", "some",
    "more", "than", "then", "into", "can", "could", "would", "should",
  ]);
  return new Set(words.filter((word) => !stop.has(word)));
}

function lexicalOverlap(a: string, b: string): number {
  const aWords = contentWords(a);
  const bWords = contentWords(b);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap += 1;
  }
  return overlap / Math.min(aWords.size, bWords.size);
}

function domainOverlap(a: string, b: string): boolean {
  const aDomains = buildDomainProfile(a).domains
    .filter((domain) => domain.key !== "general" || domain.weight >= 0.7)
    .map((domain) => domain.key);
  const bDomains = buildDomainProfile(b).domains
    .filter((domain) => domain.key !== "general" || domain.weight >= 0.7)
    .map((domain) => domain.key);
  return aDomains.some((domain) => bDomains.includes(domain));
}

function isReferentialFollowup(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (REFERENTIAL_RE.test(trimmed)) return true;
  if (REFERENTIAL_LEADING_PRONOUN_RE.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 5 && /(^\s*(yes|no|ok|okay|sure|why|how)\b|^what\s+about\b|\)$|\?$)/i.test(trimmed);
}

function classifyMode(latestUser: string, priorMessages: ChatMessage[]): ContextSelectionMode {
  if (priorMessages.length === 0) return "latest_turn";
  if (isReferentialFollowup(latestUser)) return "referential_followup";

  const priorText = priorMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-6)
    .map((message) => message.content)
    .join("\n");
  if (domainOverlap(latestUser, priorText) || lexicalOverlap(latestUser, priorText) >= 0.18) {
    return "same_topic_continuity";
  }
  return "topic_shift";
}

export function selectConversationContext(
  input: ChatMessage[],
  options: {
    enabled: boolean;
    recentTurns: number;
  },
): ContextSelectionResult {
  const disabledMetadata: ContextSelectionMetadata = {
    enabled: false,
    mode: "latest_turn",
    selectedHistoryMessages: Math.max(input.length - 1, 0),
    droppedHistoryMessages: 0,
    inputMessages: input.length,
    outputMessages: input.length,
    latestUserChars: 0,
  };
  if (!options.enabled) {
    return { messages: input, metadata: disabledMetadata };
  }

  const system = input.filter((message) => message.role === "system");
  const nonSystem = input.filter((message) => message.role !== "system");
  const latestUserIndex = (() => {
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
      if (nonSystem[i].role === "user") return i;
    }
    return -1;
  })();

  if (latestUserIndex < 0) {
    return {
      messages: input,
      metadata: {
        enabled: true,
        mode: "latest_turn",
        selectedHistoryMessages: nonSystem.length,
        droppedHistoryMessages: 0,
        inputMessages: input.length,
        outputMessages: input.length,
        latestUserChars: 0,
      },
    };
  }

  const latestUser = nonSystem[latestUserIndex];
  const prior = nonSystem.slice(0, latestUserIndex);
  const trailing = nonSystem.slice(latestUserIndex + 1);
  const mode = classifyMode(latestUser.content, prior);
  const recentTurnMessages = Math.max(0, Math.floor(options.recentTurns) * 2);
  const priorLimit =
    mode === "referential_followup"
      ? Math.max(recentTurnMessages, 8)
      : mode === "topic_shift"
        ? Math.min(recentTurnMessages, 2)
        : recentTurnMessages;
  const selectedPrior = priorLimit <= 0 ? [] : prior.slice(-priorLimit);
  const selected = [...system, ...selectedPrior, latestUser, ...trailing];

  return {
    messages: selected,
    metadata: {
      enabled: true,
      mode,
      selectedHistoryMessages: selectedPrior.length,
      droppedHistoryMessages: prior.length - selectedPrior.length,
      inputMessages: input.length,
      outputMessages: selected.length,
      latestUserChars: latestUser.content.length,
    },
  };
}
