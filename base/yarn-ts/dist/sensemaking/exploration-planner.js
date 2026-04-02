/**
 * Exploration Planner — implements future-backward reasoning to build
 * structured exploration plans from gap analysis.
 *
 * Future-backward: start from the desired end state, derive what must be true
 * (preconditions), identify verifiable checkpoints, then produce a forward
 * path of concrete actions to close the evidence gaps.
 */
const GOAL_TRUNCATE = 300;
export function buildExplorationPlan(gaps, ctx) {
    const desiredEndState = inferDesiredEndState(ctx);
    const preconditions = derivePreconditions(gaps);
    const evidenceCheckpoints = deriveCheckpoints(gaps, preconditions);
    const forwardPath = generateForwardPath(gaps, ctx);
    const fallbackBranches = generateFallbacks(gaps);
    return {
        desiredEndState,
        preconditions,
        evidenceCheckpoints,
        forwardPath,
        fallbackBranches,
    };
}
function inferDesiredEndState(ctx) {
    if (ctx.workingFrameGoal) {
        return ctx.workingFrameGoal.slice(0, GOAL_TRUNCATE);
    }
    const text = ctx.userText.trim();
    if (!text)
        return "Complete the requested task successfully";
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
    return firstLine.slice(0, GOAL_TRUNCATE);
}
function derivePreconditions(gaps) {
    const preconditions = [];
    for (const gap of gaps.unknown) {
        preconditions.push(`Resolve unknown: ${gap.description}`);
    }
    for (const gap of gaps.knowBetter) {
        preconditions.push(`Strengthen evidence: ${gap.description}`);
    }
    if (preconditions.length === 0) {
        preconditions.push("All evidence gaps are resolved — proceed with implementation");
    }
    return preconditions;
}
function deriveCheckpoints(gaps, preconditions) {
    const checkpoints = [];
    if (gaps.unknown.length > 0) {
        checkpoints.push(`Identify and resolve ${gaps.unknown.length} unknown evidence gap(s)`);
    }
    if (gaps.knowBetter.length > 0) {
        checkpoints.push(`Strengthen ${gaps.knowBetter.length} partial evidence item(s) to high confidence`);
    }
    if (gaps.unknown.length > 0 || gaps.knowBetter.length > 0) {
        checkpoints.push("Re-evaluate evidence confidence after gathering new information");
    }
    if (preconditions.length > 0 && gaps.known.length > 0) {
        checkpoints.push("Verify approach against known constraints before generating code");
    }
    if (checkpoints.length === 0) {
        checkpoints.push("Proceed directly — evidence is sufficient");
    }
    return checkpoints;
}
function generateForwardPath(gaps, ctx) {
    const actions = [];
    for (const gap of gaps.unknown) {
        actions.push(...actionsForUnknownGap(gap, ctx));
    }
    for (const gap of gaps.knowBetter) {
        actions.push(...actionsForKnowBetterGap(gap, ctx));
    }
    if (actions.length === 0 && ctx.phase === "explore") {
        actions.push({
            kind: "tool",
            tool: "synesis_inspect_repo",
            description: "Inspect the repository structure to discover project conventions and architecture",
            priority: "recommended",
        });
        actions.push({
            kind: "search",
            tool: "synesis_knowledge_search",
            description: "Search the knowledge base for relevant documentation and patterns",
            priority: "recommended",
        });
    }
    return actions;
}
function actionsForUnknownGap(gap, ctx) {
    const actions = [];
    switch (gap.domain) {
        case "recall":
            actions.push({
                kind: "search",
                tool: "synesis_knowledge_search",
                description: "Search the knowledge base for fix patterns and documentation related to this issue",
                priority: "required",
            });
            break;
        case "language":
            actions.push({
                kind: "tool",
                tool: "synesis_inspect_repo",
                description: "Inspect the project to identify languages and frameworks in use",
                priority: "required",
            });
            actions.push({
                kind: "tool",
                tool: "synesis_classify_project",
                description: "Classify the project to activate appropriate language pack intelligence",
                priority: "recommended",
            });
            break;
        default:
            actions.push({
                kind: "question",
                description: `Ask the user for more context about: ${gap.description}`,
                priority: "required",
            });
    }
    return actions;
}
function actionsForKnowBetterGap(gap, ctx) {
    const actions = [];
    switch (gap.domain) {
        case "recall":
            actions.push({
                kind: "search",
                tool: "synesis_knowledge_search",
                description: "Query knowledge base for additional evidence to strengthen recall confidence",
                priority: "recommended",
            });
            break;
        case "evidence":
            actions.push({
                kind: "search",
                tool: "synesis_knowledge_search",
                description: "Search for more authoritative sources to confirm or strengthen evidence",
                priority: "recommended",
            });
            break;
        case "verification": {
            const verifTools = buildVerificationToolActions(ctx);
            if (verifTools.length > 0) {
                actions.push(...verifTools);
            }
            else {
                actions.push({
                    kind: "tool",
                    description: "Run project test suite or linter to gather verification data",
                    priority: "recommended",
                });
            }
            break;
        }
        default:
            actions.push({
                kind: "search",
                tool: "synesis_knowledge_search",
                description: `Search for stronger evidence about: ${gap.description}`,
                priority: "recommended",
            });
    }
    return actions;
}
function buildVerificationToolActions(ctx) {
    const actions = [];
    if (ctx.languages.includes("typescript") || ctx.languages.includes("javascript")) {
        actions.push({
            kind: "tool",
            tool: "tsc",
            description: "Run TypeScript compiler to identify type errors",
            priority: "recommended",
        });
    }
    if (ctx.languages.includes("go")) {
        actions.push({
            kind: "tool",
            tool: "go-vet",
            description: "Run go vet to check for common issues",
            priority: "recommended",
        });
    }
    if (ctx.languages.includes("python")) {
        actions.push({
            kind: "tool",
            tool: "ruff",
            description: "Run ruff linter to check for Python issues",
            priority: "recommended",
        });
    }
    if (ctx.languages.includes("rust")) {
        actions.push({
            kind: "tool",
            tool: "cargo-check",
            description: "Run cargo check to identify compilation errors",
            priority: "recommended",
        });
    }
    return actions;
}
function generateFallbacks(gaps) {
    const fallbacks = [];
    if (gaps.unknown.length > 0) {
        fallbacks.push("If exploration does not resolve unknowns, escalate to a higher-capability model tier");
    }
    if (gaps.knowBetter.length > 0) {
        fallbacks.push("If evidence cannot be strengthened sufficiently, proceed with explicit uncertainty caveats");
    }
    if (gaps.unknown.length === 0 && gaps.knowBetter.length === 0) {
        fallbacks.push("No fallback needed — evidence is sufficient");
    }
    return fallbacks;
}
