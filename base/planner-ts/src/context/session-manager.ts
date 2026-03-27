type Role = "system" | "user" | "assistant" | "tool";
type ChatMessage = { role: Role; content: string };

interface SessionRecord {
  key: string;
  lastSeenAt: number;
  history: ChatMessage[];
  checkpointBlock?: string;
}

function sanitizeAssistantContent(content: string): string {
  let out = content;
  // Drop synthetic planner progress lines from memory checkpoints.
  out = out.replace(/^\s*\[planner\].*$/gim, "");
  // If scaffolding leaked, keep only the final answer section for memory.
  const hasPlan = /(^|\n)\s*(?:#+\s*)?Plan:?(\s|$)/i.test(out);
  const hasEvidence = /(^|\n)\s*(?:#+\s*)?Evidence:?(\s|$)/i.test(out);
  const hasAnswer = /(^|\n)\s*(?:#+\s*)?Answer:?(\s|$)/i.test(out);
  if (hasPlan && hasEvidence && hasAnswer) {
    const match = out.match(/(?:^|\n)\s*(?:#+\s*)?Answer:?\s*([\s\S]*)$/i);
    if (match?.[1]) out = match[1];
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export interface SessionTelemetry {
  activeSessions: number;
  checkpointedSessions: number;
  totalHistoryEntries: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly opts: {
      enabled: boolean;
      maxHistory: number;
      checkpointEveryMessages: number;
      ttlMs: number;
    }
  ) {}

  private now(): number {
    return Date.now();
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const [key, value] of this.sessions.entries()) {
      if (value.lastSeenAt < cutoff) this.sessions.delete(key);
    }
  }

  private summarize(history: ChatMessage[]): string {
    const tail = history.slice(-20);
    const lines = tail.map((m) => `[${m.role}] ${m.content.replace(/\s+/g, " ").slice(0, 240)}`);
    return [
      "<SESSION_STATE>",
      "Recent conversation trajectory summary:",
      ...lines,
      "</SESSION_STATE>"
    ].join("\n");
  }

  private ensureSession(key: string): SessionRecord {
    this.pruneExpired();
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastSeenAt = this.now();
      return existing;
    }
    const created: SessionRecord = {
      key,
      lastSeenAt: this.now(),
      history: []
    };
    this.sessions.set(key, created);
    return created;
  }

  enrichIncomingMessages(
    key: string,
    incoming: ChatMessage[]
  ): ChatMessage[] {
    if (!this.opts.enabled) return incoming;
    const session = this.ensureSession(key);
    if (!session.checkpointBlock) return incoming;
    return [{ role: "system", content: session.checkpointBlock }, ...incoming];
  }

  recordTurn(key: string, userContent: string, assistantContent: string): void {
    if (!this.opts.enabled) return;
    const session = this.ensureSession(key);
    if (userContent.trim()) session.history.push({ role: "user", content: userContent });
    const cleanedAssistant = sanitizeAssistantContent(assistantContent);
    if (cleanedAssistant.trim()) session.history.push({ role: "assistant", content: cleanedAssistant });
    if (session.history.length > this.opts.maxHistory) {
      session.history = session.history.slice(-this.opts.maxHistory);
    }

    if (session.history.length >= this.opts.checkpointEveryMessages) {
      session.checkpointBlock = this.summarize(session.history);
      session.history = session.history.slice(-Math.floor(this.opts.checkpointEveryMessages / 2));
    }
    session.lastSeenAt = this.now();
  }

  telemetry(): SessionTelemetry {
    this.pruneExpired();
    let checkpointed = 0;
    let entries = 0;
    for (const record of this.sessions.values()) {
      entries += record.history.length;
      if (record.checkpointBlock) checkpointed += 1;
    }
    return {
      activeSessions: this.sessions.size,
      checkpointedSessions: checkpointed,
      totalHistoryEntries: entries
    };
  }
}
