import crypto from "node:crypto";

export interface ToolAttempt {
  toolName: string;
  args: unknown;
  fsFingerprint: string;
}

export class RepeatGuard {
  private readonly attempts = new Map<string, number>();

  shouldPivot(attempt: ToolAttempt): boolean {
    const key = this.hashAttempt(attempt);
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    return next >= 3;
  }

  static pivotPrompt(): string {
    return "System: You have attempted this 3 times without success. Analyze the root cause and propose a new strategy before next action.";
  }

  private hashAttempt(attempt: ToolAttempt): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify([attempt.toolName, attempt.args, attempt.fsFingerprint]))
      .digest("hex");
  }
}
