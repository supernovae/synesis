export const DEFAULT_THRESHOLDS = {
    deterministicPathThreshold: 0.85,
    constrainedPathThreshold: 0.5,
    abstainEvidenceFloor: 0.2,
    escalationFailedVerifLimit: 2,
};
const TIER_ORDER = {
    "synesis-pulse": 0,
    "synesis-core": 1,
    "synesis-horizon": 2,
};
function detectPhase(text, fallback = "implementation") {
    const t = text.toLowerCase();
    if (/\b(explore|discover|research|investigate|understand)\b/.test(t))
        return "explore";
    if (/\b(plan|design|roadmap|architecture)\b/.test(t))
        return "planning";
    if (/\b(test|validate|verify|check|lint|typecheck)\b/.test(t))
        return "validation";
    return fallback;
}
function tierOutput(tier, phase) {
    if (phase === "explore")
        return 4200;
    if (tier === "synesis-pulse")
        return 1800;
    if (tier === "synesis-core")
        return 2800;
    return 4200;
}
function buildUncertaintyFraming(evidence, riskProfile) {
    const lines = [
        "<synesis_uncertainty_framing>",
        "The system has insufficient evidence to produce a high-confidence answer for this request.",
        "",
    ];
    const missing = [];
    if ((evidence.evidenceConfidence ?? 0) < 0.2)
        missing.push("domain-specific evidence from the knowledge base");
    if ((evidence.recallConfidence ?? 0) < 0.2)
        missing.push("matching fix recipes or error patterns");
    if (evidence.verificationStalled)
        missing.push("productive verification results (loop stalled)");
    if (missing.length > 0) {
        lines.push(`Missing signals: ${missing.join("; ")}.`);
        lines.push("");
    }
    lines.push("Recommended actions before generating code:");
    lines.push("- Ask the user targeted clarifying questions about requirements or constraints.");
    lines.push("- Suggest running available verification tools (linter, type checker, tests) to gather evidence.");
    lines.push("- Retrieve relevant documentation via knowledge search before proceeding.");
    lines.push("- Present multiple options with trade-offs rather than a single uncertain guess.");
    lines.push("");
    lines.push(`Risk profile: ${riskProfile}. Prefer cautious, evidence-gathering responses.`);
    lines.push("</synesis_uncertainty_framing>");
    return lines.join("\n");
}
export class PhaseModelOrchestrator {
    stats = {
        decisions: 0,
        pulseCount: 0,
        coreCount: 0,
        horizonCount: 0,
        deterministicCount: 0,
        constrainedCount: 0,
        inferenceFirstCount: 0,
        abstainCount: 0,
        escalationCount: 0,
        deescalationCount: 0,
        byPhase: { explore: 0, planning: 0, implementation: 0, validation: 0 },
    };
    lastTierBySession = new Map();
    thresholds = { ...DEFAULT_THRESHOLDS };
    setThresholds(t) {
        Object.assign(this.thresholds, t);
    }
    getThresholds() {
        return { ...this.thresholds };
    }
    decide(ctx, sessionKey) {
        const reasons = [];
        const phase = detectPhase(ctx.latestUserText, ctx.workingPhase ?? "implementation");
        const ev = ctx.evidence ?? {};
        const th = this.thresholds;
        let tier;
        let decisionPath;
        let uncertaintyFraming;
        if (ctx.decisionMatrixEnabled && hasEvidenceSignals(ev)) {
            const result = this.classifyDecisionPath(ev, ctx.riskProfile ?? "standard", phase, ctx.latestUserText, th);
            decisionPath = result.path;
            tier = result.tier;
            uncertaintyFraming = result.uncertaintyFraming;
            reasons.push(...result.reasons);
        }
        else {
            const result = this.classifyLegacy(ctx, phase);
            decisionPath = "inference_first";
            tier = result.tier;
            reasons.push(...result.reasons);
        }
        // Escalation triggers that apply across all paths
        const escalationResult = this.applyEscalationOverrides(tier, ev, ctx.riskProfile ?? "standard", th, reasons);
        tier = escalationResult.tier;
        // Respect explicit tier unless risk escalation overrides
        const requested = ctx.requestedModel;
        if (requested === "synesis-pulse" || requested === "synesis-core" || requested === "synesis-horizon") {
            if (!(ctx.riskProfile === "high" && requested === "synesis-pulse")) {
                tier = requested;
                reasons.push("explicit_requested_tier");
            }
            else {
                reasons.push("escalated_over_explicit_pulse_due_to_high_risk");
            }
        }
        const maxOutputTokens = tierOutput(tier, phase);
        // Track escalation relative to previous tier for this session
        let escalated = escalationResult.wasEscalated;
        let escalationReason = escalationResult.reason;
        if (sessionKey) {
            const prev = this.lastTierBySession.get(sessionKey);
            if (prev && TIER_ORDER[tier] > TIER_ORDER[prev]) {
                escalated = true;
                if (!escalationReason)
                    escalationReason = `tier_increased_${prev}_to_${tier}`;
                this.stats.escalationCount++;
            }
            else if (prev && TIER_ORDER[tier] < TIER_ORDER[prev]) {
                this.stats.deescalationCount++;
            }
            this.lastTierBySession.set(sessionKey, tier);
        }
        this.stats.decisions++;
        if (tier === "synesis-pulse")
            this.stats.pulseCount++;
        if (tier === "synesis-core")
            this.stats.coreCount++;
        if (tier === "synesis-horizon")
            this.stats.horizonCount++;
        this.stats.byPhase[phase]++;
        switch (decisionPath) {
            case "deterministic":
                this.stats.deterministicCount++;
                break;
            case "constrained":
                this.stats.constrainedCount++;
                break;
            case "inference_first":
                this.stats.inferenceFirstCount++;
                break;
            case "abstain":
                this.stats.abstainCount++;
                break;
        }
        return {
            selectedModel: tier,
            phase,
            tier,
            decisionPath,
            maxOutputTokens,
            reasons,
            escalated,
            escalationReason,
            uncertaintyFraming,
        };
    }
    /**
     * Evidence-aware four-path classification (Decision Policy Matrix).
     */
    classifyDecisionPath(ev, riskProfile, phase, userText, th) {
        const recallConf = ev.recallConfidence ?? 0;
        const evidConf = ev.evidenceConfidence ?? 0;
        const recallRoute = ev.recallRouting;
        const stalled = ev.verificationStalled ?? false;
        // 1. Deterministic Answer Path
        if (recallRoute === "bypass" &&
            recallConf >= th.deterministicPathThreshold &&
            !stalled) {
            return {
                path: "deterministic",
                tier: "synesis-pulse",
                reasons: ["deterministic_path", `recall_conf=${recallConf.toFixed(2)}`],
            };
        }
        // 2. Constrained Prompt Path
        if (recallRoute === "enrich" ||
            (evidConf >= th.constrainedPathThreshold && ev.evidenceAuthoritative)) {
            const reasons = ["constrained_path"];
            if (recallRoute === "enrich")
                reasons.push(`recall_enrich_conf=${recallConf.toFixed(2)}`);
            if (evidConf >= th.constrainedPathThreshold)
                reasons.push(`evidence_conf=${evidConf.toFixed(2)}`);
            return {
                path: "constrained",
                tier: "synesis-core",
                reasons,
            };
        }
        // 3. Abstain Path — insufficient evidence + high risk
        if (evidConf < th.abstainEvidenceFloor && riskProfile === "high") {
            return {
                path: "abstain",
                tier: "synesis-core",
                reasons: ["abstain_path", `evidence_conf=${evidConf.toFixed(2)}`, "risk_high"],
                uncertaintyFraming: buildUncertaintyFraming(ev, riskProfile),
            };
        }
        // 4. Inference-First Path (default)
        let tier = "synesis-core";
        const reasons = ["inference_first_path"];
        if (riskProfile === "high") {
            tier = "synesis-horizon";
            reasons.push("risk_profile_high");
        }
        else if (phase === "validation") {
            tier = "synesis-pulse";
            reasons.push("validation_fast_path");
        }
        else if (phase === "planning" &&
            /\b(complex|multi|migration|critical|security)\b/i.test(userText)) {
            tier = "synesis-horizon";
            reasons.push("complex_planning");
        }
        return { path: "inference_first", tier, reasons };
    }
    /**
     * Legacy keyword-only routing when decision matrix is disabled or
     * no evidence signals are present (backward-compatible).
     */
    classifyLegacy(ctx, phase) {
        const reasons = [];
        if (ctx.riskProfile === "high") {
            return { tier: "synesis-horizon", reasons: ["risk_profile_high"] };
        }
        if (ctx.riskProfile === "low" && phase === "validation") {
            return { tier: "synesis-pulse", reasons: ["low_risk_validation"] };
        }
        if (phase === "planning" &&
            /\b(complex|multi|migration|critical|security)\b/i.test(ctx.latestUserText)) {
            return { tier: "synesis-horizon", reasons: ["complex_planning"] };
        }
        if (phase === "validation") {
            return { tier: "synesis-pulse", reasons: ["validation_fast_path"] };
        }
        reasons.push("default_balanced");
        return { tier: "synesis-core", reasons };
    }
    /**
     * Cross-cutting escalation overrides applied after path classification.
     */
    applyEscalationOverrides(baseTier, ev, riskProfile, th, reasons) {
        let tier = baseTier;
        let wasEscalated = false;
        let reason;
        // High risk forces at minimum core
        if (riskProfile === "high" && TIER_ORDER[tier] < TIER_ORDER["synesis-core"]) {
            tier = "synesis-core";
            wasEscalated = true;
            reason = "risk_profile_high_floor";
            reasons.push(reason);
        }
        // Repeated failed verifications escalate to horizon
        const failedVerifs = ev.consecutiveFailedVerifications ?? 0;
        if (failedVerifs >= th.escalationFailedVerifLimit) {
            if (TIER_ORDER[tier] < TIER_ORDER["synesis-horizon"]) {
                tier = "synesis-horizon";
                wasEscalated = true;
                reason = `failed_verifications=${failedVerifs}`;
                reasons.push("escalated_failed_verifications");
            }
        }
        // Stalled verification loop with multiple rounds
        const round = ev.verificationRound ?? 0;
        if (ev.verificationStalled && round >= 2) {
            if (TIER_ORDER[tier] < TIER_ORDER["synesis-horizon"]) {
                tier = "synesis-horizon";
                wasEscalated = true;
                reason = `stalled_verification_round=${round}`;
                reasons.push("escalated_stalled_verification");
            }
        }
        return { tier, wasEscalated, reason };
    }
    getLastTier(sessionKey) {
        return this.lastTierBySession.get(sessionKey);
    }
    getStats() {
        return {
            ...this.stats,
            byPhase: { ...this.stats.byPhase },
        };
    }
}
function hasEvidenceSignals(ev) {
    return (ev.recallConfidence !== undefined ||
        ev.recallRouting !== undefined ||
        ev.evidenceConfidence !== undefined ||
        ev.verificationRound !== undefined ||
        ev.consecutiveFailedVerifications !== undefined);
}
