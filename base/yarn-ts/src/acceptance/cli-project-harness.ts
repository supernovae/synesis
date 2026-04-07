export interface CliProjectAcceptanceInput {
  repoTree: string[];
  promptText: string;
  verificationSummary?: string;
}

export interface CliProjectAcceptanceResult {
  score: number;
  passed: boolean;
  missingRequired: string[];
  notes: string[];
}

const REQUIRED_CLI_FILES = [
  "cmd/synesis",
  "README.md",
  "Makefile",
  "Containerfile",
  ".golangci.yml",
];

function hasAnyTreeMatch(tree: string[], required: string): boolean {
  return tree.some((p) => p === required || p.startsWith(`${required}/`));
}

export function evaluateCliProjectAcceptance(input: CliProjectAcceptanceInput): CliProjectAcceptanceResult {
  const tree = input.repoTree.map((v) => v.trim()).filter(Boolean);
  const missingRequired = REQUIRED_CLI_FILES.filter((required) => !hasAnyTreeMatch(tree, required));
  let score = 1 - missingRequired.length / REQUIRED_CLI_FILES.length;
  const notes: string[] = [];

  const prompt = input.promptText.toLowerCase();
  if (prompt.includes("/v1/chat/completions")) {
    const hasApiClientHint = tree.some((p) => /internal\/.*(api|client)/i.test(p));
    if (!hasApiClientHint) {
      score -= 0.15;
      notes.push("Missing obvious API client package path for OpenAI-compatible endpoint work.");
    }
  }

  if (prompt.includes("session")) {
    const hasSessionHint = tree.some((p) => /session/i.test(p));
    if (!hasSessionHint) {
      score -= 0.1;
      notes.push("Prompt asked for session support but no session-related path was detected.");
    }
  }

  if (input.verificationSummary && /fail|error/i.test(input.verificationSummary)) {
    score -= 0.1;
    notes.push("Verification summary still reports failures.");
  }

  const normalized = Math.max(0, Math.min(1, score));
  return {
    score: Number(normalized.toFixed(3)),
    passed: normalized >= 0.8 && missingRequired.length === 0,
    missingRequired,
    notes,
  };
}
