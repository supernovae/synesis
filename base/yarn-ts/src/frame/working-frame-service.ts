import type {
  Complexity,
  ProjectManifest,
  ManifestComparison,
  WorkingFrame as RichWorkingFrame,
} from "@synesis/manifest";

export interface FrameMessage {
  role: string;
  content: unknown;
}

/** Lightweight M3 frame — used for tiny/small tasks. */
export interface WorkingFrame {
  goal: string;
  constraints: string[];
  activeFiles: string[];
  currentPhase: "explore" | "planning" | "implementation" | "validation";
  pendingChecks: string[];
  openDecisions: string[];
}

export interface WorkingFrameStats {
  builtCount: number;
  avgActiveFiles: number;
  richFrameCount: number;
}

/** Context passed in from the manifest pipeline for medium/large tasks. */
export interface ManifestContext {
  complexity: Complexity;
  manifest?: ProjectManifest;
  comparison?: ManifestComparison;
}

/** Optional client-provided anchors (see SESSION_EXECUTION_CONTEXT). */
export interface WorkingFramePathHints {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

const FILE_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export class WorkingFrameService {
  private builtCount = 0;
  private activeFilesTotal = 0;
  private richFrameCount = 0;

  constructor(private readonly maxFiles: number) {}

  /**
   * Build a lightweight M3 frame (tiny/small fast path).
   * Also called as an internal step for the rich path.
   */
  build(messages: FrameMessage[]): WorkingFrame {
    const texts = messages.map((m) => ({ role: m.role, text: asText(m.content) }));
    const latestUser = [...texts].reverse().find((m) => m.role === "user")?.text ?? "";
    const systemTexts = texts.filter((m) => m.role === "system").map((m) => m.text);
    const allText = texts.map((m) => m.text).join("\n");

    const constraints = uniq(
      systemTexts
        .flatMap((t) => t.split("\n"))
        .filter((line) => /\b(do not|must|never|required)\b/i.test(line))
        .map((line) => line.trim())
        .slice(0, 6)
    );

    let currentPhase: WorkingFrame["currentPhase"] = "implementation";
    if (/\b(explore|discover|research|investigate|understand)\b/i.test(latestUser)) currentPhase = "explore";
    else if (/\b(plan|roadmap|design)\b/i.test(latestUser)) currentPhase = "planning";
    else if (/\b(test|verify|validate|check)\b/i.test(latestUser)) currentPhase = "validation";

    // Context eviction: if we are not in explore phase, only look at recent messages for active files
    // to avoid dragging in files that were only relevant during exploration.
    const filesSourceText = currentPhase === "explore" 
      ? allText 
      : texts.slice(-8).map((m) => m.text).join("\n");

    const rawFiles = uniq((filesSourceText.match(FILE_RE) ?? []).map((f) => f.trim()));
    
    // Prefix Caching Rules: Always preserve core rule files in the active files list
    // regardless of phase eviction, so they stay in the context window and benefit from prefix caching.
    const ruleFiles = uniq((allText.match(FILE_RE) ?? []).map(f => f.trim())).filter(f => 
      f.includes(".cursorrules") || 
      f.includes(".claude.md") || 
      f.includes("AGENTS.md") || 
      f.includes(".windsurfrules")
    );
    
    const files = uniq([...ruleFiles, ...rawFiles]).slice(0, this.maxFiles);

    const pendingChecks: string[] = [];
    if (/\b(test|pytest|vitest|go test|cargo test)\b/i.test(allText)) pendingChecks.push("tests");
    if (/\b(ruff|eslint|lint)\b/i.test(allText)) pendingChecks.push("lint");
    if (/\b(typecheck|tsc|mypy)\b/i.test(allText)) pendingChecks.push("typecheck");

    const openDecisions = uniq(
      latestUser
        .split(/[\n.]/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith("?"))
        .slice(0, 4)
    );

    const goal = (latestUser.split("\n").find((s) => s.trim()) ?? "Complete the current coding task.").trim();
    const frame: WorkingFrame = {
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
  buildRich(messages: FrameMessage[], ctx: ManifestContext): RichWorkingFrame {
    const base = this.build(messages);
    this.richFrameCount += 1;

    const manifestFacts: string[] = [];
    const doneCriteria: string[] = [];
    const validationFocus: string[] = [];
    const assumptions: string[] = [];
    const blockers: string[] = [];

    if (ctx.manifest) {
      for (const pattern of ctx.manifest.codingPatterns.slice(0, 4)) {
        manifestFacts.push(pattern);
      }
      for (const rule of ctx.manifest.styleRules.slice(0, 3)) {
        manifestFacts.push(rule);
      }
      for (const tool of ctx.manifest.recommendedTools) {
        if (tool.required) validationFocus.push(tool.command || tool.name);
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

    const phase = base.currentPhase === "explore" ? "explore" as const
      : base.currentPhase === "planning" ? "plan" as const
      : base.currentPhase === "validation" ? "validate" as const
      : "implement" as const;

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
  toSystemBlock(frame: WorkingFrame, pathHints?: WorkingFramePathHints | null): string {
    const lines = ["<WORKING_FRAME>"];
    if (pathHints?.projectRoot?.trim()) {
      lines.push(`project_root=${pathHints.projectRoot.trim()}`);
    }
    if (pathHints?.shellCwd?.trim()) {
      lines.push(`shell_cwd=${pathHints.shellCwd.trim()}`);
    }
    lines.push(
      `goal=${frame.goal}`,
      `current_phase=${frame.currentPhase}`,
      `active_files=${frame.activeFiles.join(",") || "none"}`,
      `pending_checks=${frame.pendingChecks.join(",") || "none"}`,
      `constraints=${frame.constraints.join(" | ") || "none"}`,
      `open_decisions=${frame.openDecisions.join(" | ") || "none"}`,
    );

    if (frame.currentPhase === "explore") {
      lines.push("phase_directive=You are in the discovery phase. Your ONLY goal is to build a mental map of the codebase. Do not propose edits. Use search tools to trace data flows.");
    } else if (frame.currentPhase === "validation") {
      lines.push("phase_directive=A verification step failed. Before reading any more files, explicitly state 3 possible hypotheses for this failure.");
    }

    lines.push(
      "formatting_rules=Cite existing code as ```startLine:endLine:filepath. Use standard markdown for new code. Use specialized edit tools (like str_replace) instead of rewriting entire files.",
      "</WORKING_FRAME>",
    );
    return lines.join("\n");
  }

  /** Emit a rich system block for medium/large tasks with manifest context. */
  toRichSystemBlock(frame: RichWorkingFrame, pathHints?: WorkingFramePathHints | null): string {
    const lines = [
      "<WORKING_FRAME>",
    ];
    if (pathHints?.projectRoot?.trim()) {
      lines.push(`project_root=${pathHints.projectRoot.trim()}`);
    }
    if (pathHints?.shellCwd?.trim()) {
      lines.push(`shell_cwd=${pathHints.shellCwd.trim()}`);
    }
    lines.push(
      `goal=${frame.currentGoal}`,
      `phase=${frame.phase}`,
      `complexity=${frame.complexity}`,
      `plan_required=${frame.planRequired}`,
      `domain=${frame.domain || "none"}`,
      `relevant_files=${frame.relevantFiles.join(",") || "none"}`,
    );
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

    if (frame.phase === "explore") {
      lines.push("phase_directive=You are in the discovery phase. Your ONLY goal is to build a mental map of the codebase. Do not propose edits. Use search tools to trace data flows.");
    } else if (frame.phase === "validate") {
      lines.push("phase_directive=A verification step failed. Before reading any more files, explicitly state 3 possible hypotheses for this failure.");
    }

    lines.push("formatting_rules=Cite existing code as ```startLine:endLine:filepath. Use standard markdown for new code. Use specialized edit tools (like str_replace) instead of rewriting entire files.");
    lines.push("</WORKING_FRAME>");
    return lines.join("\n");
  }

  getStats(): WorkingFrameStats {
    return {
      builtCount: this.builtCount,
      avgActiveFiles: this.builtCount > 0 ? this.activeFilesTotal / this.builtCount : 0,
      richFrameCount: this.richFrameCount,
    };
  }
}
