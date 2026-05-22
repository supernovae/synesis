import type { CommandEvent } from "./execution-governor.js";

export interface TurnEvidenceDelta {
  previousFailureSignature: string | null;
  currentFailureSignature: string | null;
  signatureChanged: boolean;
  /** Negative = fewer error lines = improvement. */
  failureCountDelta: number;
  changedFilesIntersectImplicated: boolean;
  verificationCoversChangedFiles: boolean;
  /** A file that didn't exist in a previous verification now appears (e.g. test file created). */
  newArtifactCreated: boolean;
  /** All distinct failure signatures observed across the session. */
  seenSignatures: Set<string>;
  /** Current signature matches one that was previously seen and then resolved. */
  regressionDetected: boolean;
}

export type EvidenceDeltaSummary = "improved" | "changed" | "stalled" | "regressed" | "unknown";

const FAILURE_RE =
  /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b|exit\s+code\b/i;

const COMPILE_LIKE_RE =
  /imported and not used|declared and not used|undefined\b|cannot find symbol|syntax error|failed to compile|build failed/i;

function isVerificationTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return t === "bash" || t === "shell" || t === "run_test"
    || t === "run_build" || t === "run_lint" || t === "execute" || t === "terminal";
}

function isVerificationLikeCommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\b(go\s+test|go\s+build|go\s+vet|npm\s+(test|run\s+build)|cargo\s+(test|build)|pytest|vitest|jest|make\b|tsc\b|mypy\b|bazel\s+(test|build))/.test(c);
}

function hasFailureSig(sig: string): boolean {
  return FAILURE_RE.test(sig) || COMPILE_LIKE_RE.test(sig);
}

function countErrorLines(sig: string): number {
  if (!sig) return 0;
  let count = 0;
  for (const line of sig.split(/\n|\\n|<n>/)) {
    if (FAILURE_RE.test(line) || COMPILE_LIKE_RE.test(line)) count += 1;
  }
  return Math.max(count, hasFailureSig(sig) ? 1 : 0);
}

/**
 * Extract file paths mentioned in an error signature.  Cheap heuristic:
 * look for slash-separated tokens ending in common source extensions.
 */
function extractImplicatedFiles(sig: string): Set<string> {
  const out = new Set<string>();
  const matches = sig.match(/[\w./-]+\.(go|ts|tsx|js|jsx|py|rs|java|rb|c|cpp|h|hpp)\b/g);
  if (matches) {
    for (const m of matches) out.add(m);
  }
  return out;
}

/**
 * Check whether any `changedFiles` share a path prefix with the
 * verification command's scope (e.g. `go test ./pkg/handler/...`
 * covers `pkg/handler/server.go`).
 */
function verificationScopeCoversFiles(
  command: string,
  changedFiles: readonly string[],
): boolean {
  if (changedFiles.length === 0) return false;
  const scopeMatch = command.match(/(?:go\s+test|pytest|vitest|jest)\s+(\S+)/i);
  if (!scopeMatch) return changedFiles.length > 0;
  let scope = scopeMatch[1].replace(/^\.\//, "").replace(/\/\.\.\.$/, "");
  if (scope === "." || scope === "./...") return true;
  scope = scope.replace(/\\/g, "/");
  return changedFiles.some((f) => {
    const normalized = f.replace(/\\/g, "/");
    return normalized.includes(scope) || scope.includes(normalized.replace(/\/[^/]+$/, ""));
  });
}

/**
 * Compute the evidence delta for the current turn.
 *
 * @param events        Command events from the current turn window
 * @param changedFiles  Files edited in the session so far
 * @param seenSignatures  Mutable set of all failure signatures seen across the
 *                        session.  New signatures from this turn are added.
 * @param previousFailureSignature  The failure signature from the previous turn
 *                                  (or null if none).
 */
export function computeEvidenceDelta(
  events: readonly CommandEvent[],
  changedFiles: readonly string[],
  seenSignatures: Set<string>,
  previousFailureSignature: string | null,
): TurnEvidenceDelta {
  let currentFailureSignature: string | null = null;
  let latestVerificationCommand = "";
  let currentErrorCount = 0;
  let newArtifactCreated = false;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const isVerif = isVerificationTool(e.toolName) && isVerificationLikeCommand(e.command);
    if (!isVerif) continue;
    if (hasFailureSig(e.resultSignature)) {
      currentFailureSignature = e.resultSignature.slice(0, 400);
      currentErrorCount = countErrorLines(e.resultSignature);
      latestVerificationCommand = e.command;
      break;
    }
    if (!currentFailureSignature) {
      latestVerificationCommand = e.command;
    }
  }

  for (const e of events) {
    if (/\b(write|edit|str_replace|create)\b/.test(e.toolName.toLowerCase())) {
      const target = e.argsObject
        ? String((e.argsObject as Record<string, unknown>).path ?? (e.argsObject as Record<string, unknown>).file_path ?? "")
        : "";
      if (target && /test|spec|_test\.|\.test\./i.test(target)) {
        newArtifactCreated = true;
      }
    }
  }

  const signatureChanged = currentFailureSignature !== previousFailureSignature;
  const previousErrorCount = previousFailureSignature ? countErrorLines(previousFailureSignature) : 0;
  const failureCountDelta = currentFailureSignature
    ? currentErrorCount - previousErrorCount
    : (previousFailureSignature ? -previousErrorCount : 0);

  const regressionDetected = currentFailureSignature !== null
    && signatureChanged
    && seenSignatures.has(currentFailureSignature);

  if (currentFailureSignature) {
    seenSignatures.add(currentFailureSignature);
  }
  if (previousFailureSignature) {
    seenSignatures.add(previousFailureSignature);
  }

  const implicatedFiles = currentFailureSignature
    ? extractImplicatedFiles(currentFailureSignature)
    : new Set<string>();
  const changedFilesIntersectImplicated = changedFiles.some(
    (f) => {
      const base = f.replace(/\\/g, "/");
      for (const imp of implicatedFiles) {
        if (base.includes(imp) || imp.includes(base.split("/").pop() ?? "")) return true;
      }
      return false;
    },
  );

  const verificationCoversChangedFiles = latestVerificationCommand
    ? verificationScopeCoversFiles(latestVerificationCommand, changedFiles)
    : false;

  return {
    previousFailureSignature,
    currentFailureSignature,
    signatureChanged,
    failureCountDelta,
    changedFilesIntersectImplicated,
    verificationCoversChangedFiles,
    newArtifactCreated,
    seenSignatures,
    regressionDetected,
  };
}

/**
 * Convert an evidence delta into a compact summary string suitable for
 * `training_signals.evidence_delta`.
 */
export function summarizeEvidenceDelta(delta: TurnEvidenceDelta | null): EvidenceDeltaSummary {
  if (!delta) return "unknown";
  if (delta.regressionDetected) return "regressed";
  if (!delta.signatureChanged && delta.currentFailureSignature !== null) return "stalled";
  if (delta.signatureChanged && delta.failureCountDelta < 0) return "improved";
  if (delta.signatureChanged) return "changed";
  if (delta.currentFailureSignature === null && delta.previousFailureSignature !== null) return "improved";
  return "unknown";
}

/**
 * Compute the recovery-streak adjustment from the evidence delta.
 *
 * Returns a signed integer:
 *  -2  real progress (failure count decreased)
 *  -1  some progress (signature changed, new artifact)
 *   0  hold (signature changed but not improving)
 *  +1  no progress (same failure replayed)
 *  +2  regression (previously-resolved failure returned)
 */
export function evidenceDeltaStreakAdjustment(delta: TurnEvidenceDelta | null): number {
  if (!delta) return 0;
  if (delta.regressionDetected) return 2;
  if (!delta.signatureChanged && delta.currentFailureSignature !== null) return 1;
  if (delta.signatureChanged && delta.failureCountDelta < 0) return -2;
  if (delta.newArtifactCreated) return -1;
  if (delta.signatureChanged && delta.failureCountDelta >= 0) return 0;
  return 0;
}
