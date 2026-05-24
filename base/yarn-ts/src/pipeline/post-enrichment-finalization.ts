import type { AppConfig } from "../config.js";
import type { RequirementChecklist } from "../validation/requirement-coverage.js";
import { splitJitter, applyJitter } from "../compat/jitter-buffer.js";
import { applyTrustPackets } from "../security/transcript-trust.js";
import type { SecurityIngestConfig } from "@synesis/context-trust";

export interface EnrichedMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface FinalizePostEnrichmentInput<TMessage extends EnrichedMessage> {
  messages: TMessage[];
  config: AppConfig;
  requirementChecklist: RequirementChecklist | null;
  trustContext: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
  };
  securityIngestConfig: SecurityIngestConfig;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export type FinalizePostEnrichmentResult<TMessage extends EnrichedMessage> =
  | { ok: true; messages: TMessage[] }
  | { ok: false; messages: TMessage[]; blockDetail: string; trustCategory: string };

export function completionCriticBlock(checklist: RequirementChecklist): string {
  const must = checklist.must.map((m) => `- ${m.title}`).join("\n");
  const should = checklist.should.map((m) => `- ${m.title}`).join("\n");
  const sections = [
    "<COMPLETION_CRITIC>",
    "Before claiming completion, verify requested capability coverage.",
    "If any must-have item is not implemented yet, do not claim done; explicitly state partial completion and continue implementation.",
    "Must-have checklist:",
    must || "- (none detected)",
  ];
  if (should) {
    sections.push("Should-have checklist:", should);
  }
  sections.push("</COMPLETION_CRITIC>");
  return sections.join("\n");
}

export function appendCriticBlock<TMessage extends EnrichedMessage>(
  messages: TMessage[],
  checklist: RequirementChecklist | null,
): TMessage[] {
  if (!checklist || (checklist.must.length === 0 && checklist.should.length === 0)) return messages;
  const block = completionCriticBlock(checklist);
  const criticMsg = { role: "system", content: block } as TMessage;
  const next = [...messages];
  const sysIdx = next.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (sysIdx >= 0) {
    next.splice(sysIdx + 1, 0, criticMsg);
  } else {
    next.unshift(criticMsg);
  }
  return next;
}

export function finalizePostEnrichmentMessages<TMessage extends EnrichedMessage>(
  input: FinalizePostEnrichmentInput<TMessage>,
): FinalizePostEnrichmentResult<TMessage> {
  let messages = input.config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? input.messages
    : appendCriticBlock(input.messages, input.requirementChecklist);

  if (input.config.SYNESIS_YARN_JITTER_BUFFER_ENABLED && !input.config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const { stableMessages, jitterBlock } = splitJitter(messages);
    messages = applyJitter(stableMessages, jitterBlock) as TMessage[];
  }

  const trustResult = applyTrustPackets(
    messages,
    input.config,
    input.trustContext,
    input.securityIngestConfig,
    input.logger,
  );
  if (trustResult.blocked) {
    const blockDetail = trustResult.blockDetail ?? "Content blocked";
    const trustCategory = blockDetail.match(/Injection detected: (\S+)/)?.[1] ?? "content_policy";
    return {
      ok: false,
      messages: trustResult.messages as TMessage[],
      blockDetail,
      trustCategory,
    };
  }

  return {
    ok: true,
    messages: trustResult.messages as TMessage[],
  };
}
