export type WorkflowPhase = "planning" | "implementation" | "validation";
export type EffortTier = "synesis-pulse" | "synesis-core" | "synesis-horizon";

export interface OrchestratorContext {
  requestedModel: string;
  latestUserText: string;
  workingPhase?: WorkflowPhase;
  riskProfile?: "low" | "standard" | "high";
}

export interface OrchestratorDecision {
  selectedModel: string;
  phase: WorkflowPhase;
  tier: EffortTier;
  maxOutputTokens: number;
  reasons: string[];
}

export interface OrchestratorStats {
  decisions: number;
  pulseCount: number;
  coreCount: number;
  horizonCount: number;
}

function detectPhase(text: string, fallback: WorkflowPhase = "implementation"): WorkflowPhase {
  const t = text.toLowerCase();
  if (/\b(plan|design|roadmap|architecture)\b/.test(t)) return "planning";
  if (/\b(test|validate|verify|check|lint|typecheck)\b/.test(t)) return "validation";
  return fallback;
}

export class PhaseModelOrchestrator {
  private stats: OrchestratorStats = {
    decisions: 0,
    pulseCount: 0,
    coreCount: 0,
    horizonCount: 0
  };

  decide(ctx: OrchestratorContext): OrchestratorDecision {
    const reasons: string[] = [];
    const phase = detectPhase(ctx.latestUserText, ctx.workingPhase ?? "implementation");
    const requested = ctx.requestedModel;
    let tier: EffortTier = "synesis-core";

    if (ctx.riskProfile === "high") {
      tier = "synesis-horizon";
      reasons.push("risk_profile_high");
    } else if (ctx.riskProfile === "low" && phase === "validation") {
      tier = "synesis-pulse";
      reasons.push("low_risk_validation");
    } else if (phase === "planning" && /\b(complex|multi|migration|critical|security)\b/i.test(ctx.latestUserText)) {
      tier = "synesis-horizon";
      reasons.push("complex_planning");
    } else if (phase === "validation") {
      tier = "synesis-pulse";
      reasons.push("validation_fast_path");
    } else {
      tier = "synesis-core";
      reasons.push("default_balanced");
    }

    // Respect explicit direct tier choice unless risk is high and request is pulse.
    if (requested === "synesis-pulse" || requested === "synesis-core" || requested === "synesis-horizon") {
      if (!(ctx.riskProfile === "high" && requested === "synesis-pulse")) {
        tier = requested;
        reasons.push("explicit_requested_tier");
      } else {
        reasons.push("escalated_over_explicit_pulse_due_to_high_risk");
      }
    }

    const maxOutputTokens =
      tier === "synesis-pulse" ? 1800 :
      tier === "synesis-core" ? 2800 : 4200;

    this.stats.decisions += 1;
    if (tier === "synesis-pulse") this.stats.pulseCount += 1;
    if (tier === "synesis-core") this.stats.coreCount += 1;
    if (tier === "synesis-horizon") this.stats.horizonCount += 1;

    return {
      selectedModel: tier,
      phase,
      tier,
      maxOutputTokens,
      reasons
    };
  }

  getStats(): OrchestratorStats {
    return { ...this.stats };
  }
}
