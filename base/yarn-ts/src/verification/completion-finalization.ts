import type { AppConfig } from "../config.js";
import type { PlanGraph } from "../planning/plan-graph.js";
import { applyMarkdownGuardrail } from "../response-style.js";
import type { SessionState } from "../state/session-state.js";
import {
  evaluateTaskCompletionGate,
  incrementReconciliationAttempts,
  scrubTaskLedgerOutput,
} from "../task-ledger/index.js";
import { applyCompletionGate } from "../validation/completion-gate.js";
import type { RequirementChecklist } from "../validation/requirement-coverage.js";
import {
  evaluateDeterministicPreFinalize,
  type CriticAssessment,
  type VerificationAssessment,
} from "./staff-completion.js";
import { enforceNonSilentFinalizeText } from "./non-silent-finalize.js";

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

export type CompletionFinalizeResult = {
  finalText: string;
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
  criticBlocked: boolean;
};

export type PostStreamFinalizeResult = {
  finalText: string;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
};

export interface CompletionFinalizers {
  finalizeCompletionText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: RequirementChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: VerificationAssessment;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: PlanGraph | null;
    session?: SessionState | null;
  }): Promise<CompletionFinalizeResult>;
  finalizePostStreamText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    applyGate: boolean;
    checklist: RequirementChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: VerificationAssessment;
    toolStopReason: boolean;
    nonActionableEventDetail: string;
    planGraph?: PlanGraph | null;
  }): PostStreamFinalizeResult;
}

function isQwenModelName(modelName: string | undefined): boolean {
  return /qwen/i.test((modelName ?? "").toLowerCase());
}

function parseJsonIfPossible(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function createCompletionFinalizers(input: {
  config: AppConfig;
  recordSessionEvent: RecordSessionEventFn;
}): CompletionFinalizers {
  async function runPreFinalizeCritic(params: {
    assistantText: string;
    verification: VerificationAssessment;
    recentToolNames: string[];
  }): Promise<CriticAssessment> {
    const deterministic = evaluateDeterministicPreFinalize(params.verification, params.recentToolNames);
    if (!deterministic.blocked) return deterministic;
    const findings = deterministic.findings;
    const next = deterministic.suggestedNextActions;
    if (!input.config.SYNESIS_YARN_PREFINALIZE_LLM_CRITIC_ENABLED) {
      return {
        blocked: true,
        findings,
        suggestedNextActions: [
          ...next,
          "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
        ],
        source: "deterministic",
      };
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3500);
      const prompt = [
        "You are a strict pre-finalization critic for coding tasks.",
        "Evaluate if the task is genuinely complete. Fail if there are unverified assumptions, token bloat (e.g. repeating unchanged code), or unresolved verification failures.",
        "Return JSON only: {\"verdict\":\"pass|fail\",\"reason\":\"...\"}",
        `Assistant text: ${params.assistantText.slice(0, 1200)}`,
        `Verification failures: ${JSON.stringify(params.verification.failures).slice(0, 1600)}`,
        `Recent tool names: ${params.recentToolNames.join(",")}`,
      ].join("\n");
      const resp = await fetch(`${input.config.SYNESIS_YARN_CRITIC_URL}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          ...(input.config.SYNESIS_INTERNAL_SERVICE_TOKEN ? { authorization: `Bearer ${input.config.SYNESIS_INTERNAL_SERVICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          model: input.config.SYNESIS_YARN_CRITIC_MODEL,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
          ...(isQwenModelName(input.config.SYNESIS_YARN_CRITIC_MODEL)
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        return { blocked: true, findings, suggestedNextActions: next, source: "deterministic" };
      }
      const body = await resp.json() as Record<string, unknown>;
      const text = String((((body.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}).message as Record<string, unknown> | undefined)?.content ?? "");
      const parsed = parseJsonIfPossible(text) as { verdict?: string; reason?: string } | null;
      if (parsed?.verdict?.toLowerCase() === "pass") {
        return {
          blocked: false,
          findings: [`LLM critic override: ${parsed.reason ?? "passed"}`],
          suggestedNextActions: [],
          source: "llm_fallback",
        };
      }
      return {
        blocked: true,
        findings: [parsed?.reason ?? findings.join(" ")],
        suggestedNextActions: [
          ...next,
          "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
        ],
        source: "llm_fallback",
      };
    } catch {
      return {
        blocked: true,
        findings,
        suggestedNextActions: [
          ...next,
          "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
        ],
        source: "deterministic",
      };
    }
  }

  async function finalizeCompletionText(
    params: Parameters<CompletionFinalizers["finalizeCompletionText"]>[0],
  ): Promise<CompletionFinalizeResult> {
    if (params.session?.taskLedger) {
      const taskGate = evaluateTaskCompletionGate(params.session.taskLedger, params.session.taskCapabilities);
      if (!taskGate.allow && taskGate.nudge) {
        params.session.taskLedger = incrementReconciliationAttempts(params.session.taskLedger);
        input.recordSessionEvent(
          params.sessionKey,
          params.userId,
          params.orgId,
          "task_ledger_reconciliation_nudge",
          "task-ledger",
          `open_tasks=${params.session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length} attempt=${params.session.taskLedger.reconciliationAttempts}`,
          params.requestId,
        );
      }
    }

    const gate = applyCompletionGate({
      config: input.config,
      checklist: params.checklist,
      originalText: params.assistantText,
      traceRootPrompt: params.traceRootPrompt,
      latestUserPrompt: params.latestUserPrompt,
      verification: params.verification,
      planGraph: params.planGraph,
    });

    let finalText = gate.finalText;
    if (gate.applied) {
      input.recordSessionEvent(
        params.sessionKey,
        params.userId,
        params.orgId,
        gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
        "completion-gate",
        gate.blockedByVerification
          ? `Blocking verification failures (${gate.blockingVerificationFailures})`
          : `Missing must-have requirements (${gate.missingMust})`,
        params.requestId,
      );
    } else if (params.checklist) {
      input.recordSessionEvent(
        params.sessionKey,
        params.userId,
        params.orgId,
        "completion_pass",
        "completion-gate",
        "No missing must-have requirements detected",
        params.requestId,
      );
    }

    let criticBlocked = false;
    if (!gate.applied && input.config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
      const critic = await runPreFinalizeCritic({
        assistantText: finalText,
        verification: params.verification,
        recentToolNames: params.recentToolNames,
      });
      if (critic.blocked) {
        criticBlocked = true;
        finalText = [
          "Completion paused by pre-finalization critic.",
          "",
          "Findings:",
          ...critic.findings.map((f) => `- ${f}`),
          "",
          "Next actions:",
          ...(critic.suggestedNextActions.length > 0
            ? critic.suggestedNextActions.map((s) => `- ${s}`)
            : ["- Address verification/quality gaps and rerun checks."]),
        ].join("\n");
        input.recordSessionEvent(
          params.sessionKey,
          params.userId,
          params.orgId,
          "pre_finalize_critic_block",
          "completion-gate",
          `critic_source=${critic.source}`,
          params.requestId,
        );
      }
    }

    const nonSilent = enforceNonSilentFinalizeText(finalText);
    if (nonSilent.applied) {
      finalText = nonSilent.text;
      input.recordSessionEvent(
        params.sessionKey,
        params.userId,
        params.orgId,
        "completion_non_actionable_fallback",
        "completion-gate",
        params.nonActionableEventDetail,
        params.requestId,
      );
    }

    const scrubbed = scrubTaskLedgerOutput(finalText);
    if (scrubbed.scrubbed) {
      finalText = scrubbed.text;
      input.recordSessionEvent(
        params.sessionKey,
        params.userId,
        params.orgId,
        "task_ledger_output_scrubbed",
        "task-ledger",
        "Removed internal task-ledger governance from assistant output",
        params.requestId,
      );
    }

    return {
      finalText,
      applied: gate.applied,
      missingMust: gate.missingMust,
      missingShould: gate.missingShould,
      blockedByVerification: gate.blockedByVerification,
      criticBlocked,
    };
  }

  function finalizePostStreamText(
    params: Parameters<CompletionFinalizers["finalizePostStreamText"]>[0],
  ): PostStreamFinalizeResult {
    let finalText = params.assistantText;
    let missingMust = 0;
    let missingShould = 0;
    let blockedByVerification = false;
    if (params.applyGate && !params.toolStopReason) {
      const gate = applyCompletionGate({
        config: input.config,
        checklist: params.checklist,
        originalText: finalText,
        traceRootPrompt: params.traceRootPrompt,
        latestUserPrompt: params.latestUserPrompt,
        verification: params.verification,
        planGraph: params.planGraph,
      });
      finalText = gate.finalText;
      missingMust = gate.missingMust;
      missingShould = gate.missingShould;
      blockedByVerification = gate.blockedByVerification;
    }
    finalText = applyMarkdownGuardrail(
      finalText,
      input.config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    );
    if (!params.toolStopReason) {
      const nonSilent = enforceNonSilentFinalizeText(finalText);
      if (nonSilent.applied) {
        finalText = nonSilent.text;
        input.recordSessionEvent(
          params.sessionKey,
          params.userId,
          params.orgId,
          "completion_non_actionable_fallback",
          "completion-gate",
          params.nonActionableEventDetail,
          params.requestId,
        );
      }
    }
    return {
      finalText,
      missingMust,
      missingShould,
      blockedByVerification,
    };
  }

  return {
    finalizeCompletionText,
    finalizePostStreamText,
  };
}
