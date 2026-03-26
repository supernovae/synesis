export interface FrameMessage {
  role: string;
  content: unknown;
}

export interface WorkingFrame {
  goal: string;
  constraints: string[];
  activeFiles: string[];
  currentPhase: "planning" | "implementation" | "validation";
  pendingChecks: string[];
  openDecisions: string[];
}

export interface WorkingFrameStats {
  builtCount: number;
  avgActiveFiles: number;
}

const FILE_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh)\b/g;

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

  constructor(private readonly maxFiles: number) {}

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
        .slice(0, 8)
    );

    const files = uniq((allText.match(FILE_RE) ?? []).map((f) => f.trim())).slice(0, this.maxFiles);
    const pendingChecks: string[] = [];
    if (/\b(test|pytest|vitest|go test|cargo test)\b/i.test(allText)) pendingChecks.push("tests");
    if (/\b(ruff|eslint|lint)\b/i.test(allText)) pendingChecks.push("lint");
    if (/\b(typecheck|tsc|mypy)\b/i.test(allText)) pendingChecks.push("typecheck");

    const openDecisions = uniq(
      latestUser
        .split(/[\n.]/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith("?"))
        .slice(0, 6)
    );

    let currentPhase: WorkingFrame["currentPhase"] = "implementation";
    if (/\b(plan|roadmap|design)\b/i.test(latestUser)) currentPhase = "planning";
    if (/\b(test|verify|validate|check)\b/i.test(latestUser)) currentPhase = "validation";

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

  toSystemBlock(frame: WorkingFrame): string {
    return [
      "<WORKING_FRAME>",
      `goal=${frame.goal}`,
      `current_phase=${frame.currentPhase}`,
      `active_files=${frame.activeFiles.join(",") || "none"}`,
      `pending_checks=${frame.pendingChecks.join(",") || "none"}`,
      `constraints=${frame.constraints.join(" | ") || "none"}`,
      `open_decisions=${frame.openDecisions.join(" | ") || "none"}`,
      "</WORKING_FRAME>"
    ].join("\n");
  }

  getStats(): WorkingFrameStats {
    return {
      builtCount: this.builtCount,
      avgActiveFiles: this.builtCount > 0 ? this.activeFilesTotal / this.builtCount : 0
    };
  }
}
