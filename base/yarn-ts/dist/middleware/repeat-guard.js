import crypto from "node:crypto";
export class RepeatGuard {
    attempts = new Map();
    shouldPivot(attempt) {
        const key = this.hashAttempt(attempt);
        const next = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, next);
        return next >= 3;
    }
    static pivotPrompt() {
        return "System: You have attempted this 3 times without success. Analyze the root cause and propose a new strategy before next action.";
    }
    hashAttempt(attempt) {
        return crypto
            .createHash("sha256")
            .update(JSON.stringify([attempt.toolName, attempt.args, attempt.fsFingerprint]))
            .digest("hex");
    }
}
