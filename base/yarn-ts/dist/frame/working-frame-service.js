const FILE_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;
function asText(content) {
    if (typeof content === "string")
        return content;
    try {
        return JSON.stringify(content);
    }
    catch {
        return String(content);
    }
}
function uniq(arr) {
    return [...new Set(arr)];
}
export class WorkingFrameService {
    maxFiles;
    builtCount = 0;
    activeFilesTotal = 0;
    richFrameCount = 0;
    constructor(maxFiles) {
        this.maxFiles = maxFiles;
    }
    /**
     * Build a lightweight M3 frame (tiny/small fast path).
     * Also called as an internal step for the rich path.
     */
    build(messages) {
        const texts = messages.map((m) => ({ role: m.role, text: asText(m.content) }));
        const latestUser = [...texts].reverse().find((m) => m.role === "user")?.text ?? "";
        const systemTexts = texts.filter((m) => m.role === "system").map((m) => m.text);
        const allText = texts.map((m) => m.text).join("\n");
        const constraints = uniq(systemTexts
            .flatMap((t) => t.split("\n"))
            .filter((line) => /\b(do not|must|never|required)\b/i.test(line))
            .map((line) => line.trim())
            .slice(0, 8));
        const files = uniq((allText.match(FILE_RE) ?? []).map((f) => f.trim())).slice(0, this.maxFiles);
        const pendingChecks = [];
        if (/\b(test|pytest|vitest|go test|cargo test)\b/i.test(allText))
            pendingChecks.push("tests");
        if (/\b(ruff|eslint|lint)\b/i.test(allText))
            pendingChecks.push("lint");
        if (/\b(typecheck|tsc|mypy)\b/i.test(allText))
            pendingChecks.push("typecheck");
        const openDecisions = uniq(latestUser
            .split(/[\n.]/)
            .map((s) => s.trim())
            .filter((s) => s.endsWith("?"))
            .slice(0, 6));
        let currentPhase = "implementation";
        if (/\b(explore|discover|research|investigate|understand)\b/i.test(latestUser))
            currentPhase = "explore";
        else if (/\b(plan|roadmap|design)\b/i.test(latestUser))
            currentPhase = "planning";
        else if (/\b(test|verify|validate|check)\b/i.test(latestUser))
            currentPhase = "validation";
        const goal = (latestUser.split("\n").find((s) => s.trim()) ?? "Complete the current coding task.").trim();
        const frame = {
            goal: goal.slice(0, 220),
            constraints,
            activeFiles: files,
            currentPhase,
            pendingChecks: uniq(pendingChecks),
            openDecisions
        };
        this.builtCount += 1;
        this.activeFilesTotal += frame.activeFiles.length;
        return frame;
    }
    /**
     * Build a rich manifest-aware frame for medium/large tasks.
     * Merges the lightweight frame with manifest/comparison context.
     */
    buildRich(messages, ctx) {
        const base = this.build(messages);
        this.richFrameCount += 1;
        const manifestFacts = [];
        const doneCriteria = [];
        const validationFocus = [];
        const assumptions = [];
        const blockers = [];
        if (ctx.manifest) {
            for (const pattern of ctx.manifest.codingPatterns.slice(0, 4)) {
                manifestFacts.push(pattern);
            }
            for (const rule of ctx.manifest.styleRules.slice(0, 3)) {
                manifestFacts.push(rule);
            }
            for (const tool of ctx.manifest.recommendedTools) {
                if (tool.required)
                    validationFocus.push(tool.command || tool.name);
            }
        }
        if (ctx.comparison) {
            const reqMissing = ctx.comparison.missingFiles.filter((f) => f.required);
            for (const f of reqMissing.slice(0, 4)) {
                doneCriteria.push(`Create ${f.path} (${f.purpose})`);
            }
            if (ctx.comparison.missingDocSections.length > 0) {
                doneCriteria.push(`Add documentation sections: ${ctx.comparison.missingDocSections.slice(0, 3).join(", ")}`);
            }
        }
        if (doneCriteria.length === 0) {
            doneCriteria.push("Task completed successfully");
        }
        const phase = base.currentPhase === "explore" ? "explore"
            : base.currentPhase === "planning" ? "plan"
                : base.currentPhase === "validation" ? "validate"
                    : "implement";
        return {
            taskId: "",
            userIntent: base.goal,
            taskType: "general",
            phase,
            domain: ctx.manifest?.detectedKind ?? "",
            subdomain: "",
            currentGoal: base.goal,
            nextStep: "",
            relevantFiles: base.activeFiles,
            relevantDirectories: [],
            relevantManifestFacts: manifestFacts,
            constraints: base.constraints,
            assumptions,
            blockers,
            validationFocus,
            doneCriteria,
            complexity: ctx.complexity,
            planRequired: ctx.complexity === "large",
        };
    }
    /** Emit a compact system block — adapts density to frame type. */
    toSystemBlock(frame, pathHints) {
        const lines = ["<WORKING_FRAME>"];
        if (pathHints?.projectRoot?.trim()) {
            lines.push(`project_root=${pathHints.projectRoot.trim()}`);
        }
        if (pathHints?.shellCwd?.trim()) {
            lines.push(`shell_cwd=${pathHints.shellCwd.trim()}`);
        }
        lines.push(`goal=${frame.goal}`, `current_phase=${frame.currentPhase}`, `active_files=${frame.activeFiles.join(",") || "none"}`, `pending_checks=${frame.pendingChecks.join(",") || "none"}`, `constraints=${frame.constraints.join(" | ") || "none"}`, `open_decisions=${frame.openDecisions.join(" | ") || "none"}`, "</WORKING_FRAME>");
        return lines.join("\n");
    }
    /** Emit a rich system block for medium/large tasks with manifest context. */
    toRichSystemBlock(frame, pathHints) {
        const lines = [
            "<WORKING_FRAME>",
        ];
        if (pathHints?.projectRoot?.trim()) {
            lines.push(`project_root=${pathHints.projectRoot.trim()}`);
        }
        if (pathHints?.shellCwd?.trim()) {
            lines.push(`shell_cwd=${pathHints.shellCwd.trim()}`);
        }
        lines.push(`goal=${frame.currentGoal}`, `phase=${frame.phase}`, `complexity=${frame.complexity}`, `plan_required=${frame.planRequired}`, `domain=${frame.domain || "none"}`, `relevant_files=${frame.relevantFiles.join(",") || "none"}`);
        if (frame.relevantManifestFacts.length > 0) {
            lines.push(`manifest_facts=${frame.relevantManifestFacts.join(" | ")}`);
        }
        if (frame.constraints.length > 0) {
            lines.push(`constraints=${frame.constraints.join(" | ")}`);
        }
        if (frame.validationFocus.length > 0) {
            lines.push(`validation=${frame.validationFocus.join(",")}`);
        }
        if (frame.doneCriteria.length > 0) {
            lines.push(`done_criteria=${frame.doneCriteria.join(" | ")}`);
        }
        if (frame.blockers.length > 0) {
            lines.push(`blockers=${frame.blockers.join(" | ")}`);
        }
        lines.push("</WORKING_FRAME>");
        return lines.join("\n");
    }
    getStats() {
        return {
            builtCount: this.builtCount,
            avgActiveFiles: this.builtCount > 0 ? this.activeFilesTotal / this.builtCount : 0,
            richFrameCount: this.richFrameCount,
        };
    }
}
