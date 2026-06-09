/**
 * Verification Loop Tracker — tracks verification rounds within a session,
 * detects stagnation (finding count not decreasing), and manages budget.
 *
 * Integrates with the reduction pipeline: when a tool result is identified
 * as verification output (matches a verification command), the tracker
 * records the round and its findings for loop state management.
 */

import type { EnrichedItem } from "../reduction/types.js";
import type { VerificationLoopState, VerificationRoundResult, VerificationStats } from "./types.js";

export class VerificationLoopTracker {
  private state: VerificationLoopState = {
    round: 0,
    findings: [],
    allResolved: false,
    stalled: false,
    budgetExhausted: false,
    history: [],
  };

  private loopStartedAt: number = 0;
  private readonly maxRounds: number;
  private readonly budgetMs: number;

  constructor(maxRounds: number = 3, budgetMs: number = 30_000) {
    this.maxRounds = maxRounds;
    this.budgetMs = budgetMs;
  }

  /**
   * Record a verification round. Call this when a tool result has been
   * identified as output from a verification command.
   */
  recordRound(
    command: string,
    findings: EnrichedItem[],
    bypassEligible: boolean,
    stats?: VerificationStats,
    language?: string,
  ): VerificationLoopState {
    if (this.state.round === 0) {
      this.loopStartedAt = Date.now();
      if (stats) stats.loopsStarted++;
    }

    this.state.round++;
    const prevFindingCount = this.state.findings.length;
    this.state.findings = findings;

    const resolvedCount = prevFindingCount > 0
      ? Math.max(0, prevFindingCount - findings.length)
      : 0;

    const roundResult: VerificationRoundResult = {
      round: this.state.round,
      command,
      findingCount: findings.length,
      resolvedCount,
      bypassEligible,
      timestampMs: Date.now(),
    };
    this.state.history.push(roundResult);

    if (stats) {
      stats.totalRounds++;
      stats.totalFindingsDetected += findings.length;
      stats.totalFindingsResolved += resolvedCount;
      if (language) {
        if (!stats.byLanguage[language]) {
          stats.byLanguage[language] = { loops: 0, rounds: 0, resolved: 0 };
        }
        stats.byLanguage[language].rounds++;
        stats.byLanguage[language].resolved += resolvedCount;
      }
    }

    this.state.allResolved = findings.length === 0;

    // Stall detection: if finding count didn't decrease for 2+ consecutive rounds
    if (this.state.history.length >= 2) {
      const last = this.state.history[this.state.history.length - 1];
      const prev = this.state.history[this.state.history.length - 2];
      this.state.stalled = last.findingCount >= prev.findingCount && prev.findingCount > 0;
    }

    const elapsedMs = Date.now() - this.loopStartedAt;
    this.state.budgetExhausted =
      this.state.round >= this.maxRounds || elapsedMs >= this.budgetMs;

    if (this.state.allResolved || this.state.budgetExhausted) {
      if (stats) {
        stats.loopsCompleted++;
        if (this.state.budgetExhausted && !this.state.allResolved) {
          stats.budgetExhaustions++;
        }
        if (this.state.stalled) stats.stallCount++;
        if (language && stats.byLanguage[language]) {
          stats.byLanguage[language].loops++;
        }
      }
    }

    return { ...this.state, history: [...this.state.history] };
  }

  getState(): VerificationLoopState {
    return { ...this.state, history: [...this.state.history] };
  }

  /**
   * Returns true if this tracker considers the current tool-call cycle
   * to be a productive verification loop (finding count is decreasing),
   * distinguishing it from a stagnant loop that policy should interrupt.
   */
  isProductiveLoop(): boolean {
    if (this.state.round < 2) return true;
    return !this.state.stalled && !this.state.allResolved;
  }

  shouldContinue(): boolean {
    return !this.state.allResolved && !this.state.budgetExhausted && !this.state.stalled;
  }

  /**
   * Format a progress annotation for the tool result summary.
   */
  formatProgressAnnotation(): string | null {
    if (this.state.round === 0) return null;

    const latest = this.state.history[this.state.history.length - 1];
    if (!latest) return null;
    const round = safeNonNegativeInteger(this.state.round);
    const findingCount = safeNonNegativeInteger(latest.findingCount);
    const resolvedCount = safeNonNegativeInteger(latest.resolvedCount);

    if (this.state.allResolved) {
      return `<synesis_verification_status round="${round}" status="resolved">All verification issues resolved.</synesis_verification_status>`;
    }

    if (this.state.stalled) {
      return `<synesis_verification_status round="${round}" status="stalled" findings="${findingCount}">Verification loop stalled — remaining issues require manual review or different approach.</synesis_verification_status>`;
    }

    if (this.state.budgetExhausted) {
      return `<synesis_verification_status round="${round}" status="budget_exhausted" findings="${findingCount}">Verification budget exhausted (${safeNonNegativeInteger(this.maxRounds)} rounds). ${findingCount} issue(s) remain.</synesis_verification_status>`;
    }

    const prevRound = this.state.history.length >= 2
      ? this.state.history[this.state.history.length - 2]
      : undefined;

    const delta = prevRound
      ? ` (was ${safeNonNegativeInteger(prevRound.findingCount)}). ${resolvedCount} resolved.`
      : "";

    return `<synesis_verification_status round="${round}" status="in_progress" findings="${findingCount}">Verification round ${round}: ${findingCount} issue(s) remain${delta}</synesis_verification_status>`;
  }

  reset(): void {
    this.state = {
      round: 0,
      findings: [],
      allResolved: false,
      stalled: false,
      budgetExhausted: false,
      history: [],
    };
    this.loopStartedAt = 0;
  }
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
