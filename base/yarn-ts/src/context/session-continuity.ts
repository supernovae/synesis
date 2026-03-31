import type { SessionContinuity } from "../state/session-store.js";

const FILE_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh)\b/g;
const DECISION_PHRASES = /\b(decided|choosing|switched to|going with|will use|opted for|selected)\b/i;
const FINDING_PHRASES = /\b(found|discovered|noticed|identified|issue is|root cause|turns out|confirmed)\b/i;
const MAX_ITEMS = 8;

export interface SessionContinuityStats {
  extractionCount: number;
  continuityBlocksEmitted: number;
  recallBlocksEmitted: number;
  avgFindingsPerSession: number;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}

function extractSentences(text: string): string[] {
  return text
    .split(/[.\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && s.length < 300);
}

export class SessionContinuityService {
  private stats: SessionContinuityStats = {
    extractionCount: 0,
    continuityBlocksEmitted: 0,
    recallBlocksEmitted: 0,
    avgFindingsPerSession: 0
  };
  private totalFindings = 0;

  /**
   * Extract semantic session state from a conversation history.
   * Uses heuristic matching on assistant/user messages to identify
   * the current task, key findings, decisions, and files touched.
   */
  extract(
    history: Array<{ role: string; content: string }>
  ): SessionContinuity {
    const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
    const assistantMessages = history.filter((m) => m.role === "assistant").map((m) => m.content);
    const allText = history.map((m) => m.content).join("\n");

    const currentTask = userMessages.length > 0
      ? (userMessages[userMessages.length - 1].split("\n").find((s) => s.trim()) ?? "").slice(0, 300)
      : "";

    const allSentences = assistantMessages.flatMap(extractSentences);

    const findings = uniq(
      allSentences
        .filter((s) => FINDING_PHRASES.test(s))
        .slice(-MAX_ITEMS)
    );

    const decisions = uniq(
      allSentences
        .filter((s) => DECISION_PHRASES.test(s))
        .slice(-MAX_ITEMS)
    );

    const recentFiles = uniq(
      (allText.match(FILE_RE) ?? []).map((f) => f.trim())
    ).slice(-MAX_ITEMS);

    this.stats.extractionCount++;
    this.totalFindings += findings.length;
    this.stats.avgFindingsPerSession = this.stats.extractionCount > 0
      ? this.totalFindings / this.stats.extractionCount
      : 0;

    return {
      currentTask,
      keyFindings: findings,
      decisions,
      recentFiles,
      updatedAt: Date.now()
    };
  }

  /**
   * Build a system message block from a previous session's continuity data.
   * Returns null if the continuity has no useful content.
   */
  toSystemBlock(continuity: SessionContinuity): string | null {
    const parts: string[] = ["<SESSION_CONTINUITY>"];

    if (continuity.currentTask) {
      parts.push(`previous_task=${continuity.currentTask}`);
    }
    if (continuity.keyFindings.length > 0) {
      parts.push(`key_findings=${continuity.keyFindings.join(" | ")}`);
    }
    if (continuity.decisions.length > 0) {
      parts.push(`decisions=${continuity.decisions.join(" | ")}`);
    }
    if (continuity.recentFiles.length > 0) {
      parts.push(`recent_files=${continuity.recentFiles.join(",")}`);
    }

    if (parts.length <= 1) return null;

    parts.push("</SESSION_CONTINUITY>");
    this.stats.continuityBlocksEmitted++;
    return parts.join("\n");
  }

  /**
   * Build a recall block from a *prior* session's continuity loaded from Postgres.
   * Distinct from SESSION_CONTINUITY (same-session Redis) — this is cross-conversation recall.
   * Returns null if the continuity has no useful content.
   */
  toRecallBlock(continuity: SessionContinuity): string | null {
    const parts: string[] = ["<SESSION_RECALL source=\"prior_session\">"];

    if (continuity.currentTask) {
      parts.push(`last_task=${continuity.currentTask}`);
    }
    if (continuity.keyFindings.length > 0) {
      parts.push(`prior_findings=${continuity.keyFindings.join(" | ")}`);
    }
    if (continuity.decisions.length > 0) {
      parts.push(`prior_decisions=${continuity.decisions.join(" | ")}`);
    }
    if (continuity.recentFiles.length > 0) {
      parts.push(`prior_files=${continuity.recentFiles.join(",")}`);
    }

    if (parts.length <= 1) return null;

    const ageMs = Date.now() - (continuity.updatedAt || 0);
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    parts.push(`age_hours=${ageHours}`);
    parts.push("</SESSION_RECALL>");
    this.stats.recallBlocksEmitted++;
    return parts.join("\n");
  }

  getStats(): SessionContinuityStats {
    return { ...this.stats };
  }
}
