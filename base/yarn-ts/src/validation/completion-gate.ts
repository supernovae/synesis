import type { AppConfig } from "../config.js";
import { evaluateCliProjectAcceptance } from "../acceptance/cli-project-harness.js";
import type { PlanGraph } from "../planning/plan-graph.js";
import { isPlanComplete } from "../planning/plan-graph.js";
import {
  evaluateRequirementCoverage,
  summarizeMissingCoverage,
  type RequirementChecklist,
} from "./requirement-coverage.js";
import { looksLikeClarificationTurnAssistantMessage } from "./clarification-turn.js";
import type { VerificationAssessment } from "../verification/staff-completion.js";

export type CompletionGateOutcome = {
  finalText: string;
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
  blockingVerificationFailures: number;
  suggestedNextActions: string[];
};

function buildCompletionGapMessage(missingSummary: string): string {
  return [
    "Partial completion detected. I have not yet implemented all required request items.",
    "",
    "Missing requirements:",
    missingSummary,
    "",
    "Next step: continue implementation to close these gaps (instead of marking the task done).",
  ].join("\n");
}

function extractNewFileMentions(text: string): string[] {
  const out = new Set<string>();
  const rx = /\b(?:created|added|new file)\b[^.\n]*\b([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
    if (out.size >= 12) break;
  }
  return [...out];
}

function hasUsageOrReferenceCue(text: string, filePath: string): boolean {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`\\b(import|use|used by|wired|hooked|referenced|route|register|include)\\b[^\\n]{0,140}${escaped}`, "i");
  return rx.test(text);
}

export function applyCompletionGate(input: {
  config: AppConfig;
  checklist: RequirementChecklist | null;
  originalText: string;
  traceRootPrompt: string;
  latestUserPrompt: string;
  verification: VerificationAssessment;
  planGraph?: PlanGraph | null;
}): CompletionGateOutcome {
  const blockedByVerification =
    input.config.SYNESIS_YARN_COMPLETION_GATE_BLOCK_VERIFICATION
    && input.verification.hasBlockingFailures;
  if (blockedByVerification) {
    const top = input.verification.failures.slice(0, 3);
    const detail = top.map((f, i) => `- ${i + 1}. [${f.category}] ${f.summary}`).join("\n");
    const boundedCleanup = input.config.SYNESIS_YARN_COMPLETION_GATE_BOUNDED_CLEANUP_PASS
      ? [
          "Run one bounded cleanup pass before finalizing:",
          "- Scope: changed files / touched package only",
          "- Fix only blocking diagnostics and obvious patch debris",
          "- Re-run the same failing verification preset(s)",
        ].join("\n")
      : "";
    const nextActions = [
      ...top.map((f) => `rerun verification preset ${f.preset ?? "unknown"} after minimal fix`),
      "only finalize when blocking verification failures are cleared",
    ];
    return {
      finalText: [
        "Not complete: blocking verification failures remain.",
        "",
        "Blocking failures:",
        detail || "- (no details)",
        ...(boundedCleanup ? ["", boundedCleanup] : []),
        "",
        "Next: repair these failures and rerun verification before finalizing.",
      ].join("\n"),
      applied: true,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: true,
      blockingVerificationFailures: input.verification.failingSignals,
      suggestedNextActions: nextActions,
    };
  }
  if (!input.config.SYNESIS_YARN_COMPLETION_GATE_ENABLED || !input.checklist) {
    return {
      finalText: input.originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  if (input.checklist.must.length === 0 && input.checklist.should.length === 0) {
    return {
      finalText: input.originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  if (
    input.config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION &&
    looksLikeClarificationTurnAssistantMessage(input.originalText)
  ) {
    return {
      finalText: input.originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  const evidence = [input.traceRootPrompt, input.latestUserPrompt, input.originalText].filter(Boolean).join("\n");
  const report = evaluateRequirementCoverage(input.checklist, evidence);
  let cliAcceptanceNotes: string[] = [];
  if (input.config.SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED) {
    const fileMatches = evidence.match(/[a-zA-Z0-9_\-./]+/g) ?? [];
    const acceptance = evaluateCliProjectAcceptance({
      repoTree: fileMatches.filter((v) => v.includes("/") || v.includes(".")),
      promptText: input.traceRootPrompt,
      verificationSummary: input.originalText,
    });
    if (!acceptance.passed) {
      cliAcceptanceNotes = [
        ...acceptance.missingRequired.map((v) => `missing required path: ${v}`),
        ...acceptance.notes,
      ];
    }
  }
  const newFileNotes: string[] = [];
  const mentionedNewFiles = extractNewFileMentions(input.originalText);
  for (const fp of mentionedNewFiles) {
    if (!hasUsageOrReferenceCue(input.originalText, fp) && !hasUsageOrReferenceCue(input.latestUserPrompt, fp)) {
      newFileNotes.push(`new file mentioned without usage reference: ${fp}`);
    }
  }
  const planAdvisory: string[] = [];
  if (input.planGraph && !isPlanComplete(input.planGraph)) {
    planAdvisory.push(`Plan stage is "${input.planGraph.activeStage}", not finalize. Advance plan stages before final completion.`);
  }
  if (report.missingMust.length === 0) {
    return {
      finalText: input.originalText,
      applied: false,
      missingMust: 0,
      missingShould: report.missingShould.length,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [...planAdvisory, ...cliAcceptanceNotes, ...newFileNotes],
    };
  }
  const summary = summarizeMissingCoverage(report);
  const replacement = input.config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL
    ? [
        "Completion blocked: required items are still missing.",
        "",
        "Missing requirements:",
        summary,
        "",
        "Continue implementation before declaring completion.",
      ].join("\n")
    : buildCompletionGapMessage(summary);
  return {
    finalText: replacement,
    applied: true,
    missingMust: report.missingMust.length,
    missingShould: report.missingShould.length,
    blockedByVerification: false,
    blockingVerificationFailures: 0,
    suggestedNextActions: [
      "continue implementation to close missing must-have requirements",
      ...planAdvisory,
      ...cliAcceptanceNotes,
      ...newFileNotes,
    ],
  };
}
