import {
  MemorySessionStore,
  type ChatMessage,
  type SessionData,
  type SessionStore
} from "./session-store.js";

function sanitizeAssistantContent(content: string): string {
  let out = content;
  out = out.replace(/^\s*\[planner\].*$/gim, "");
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
  storeBackend: "memory" | "redis";
}

export class SessionManager {
  private readonly store: SessionStore;

  constructor(
    private readonly opts: {
      enabled: boolean;
      maxHistory: number;
      checkpointEveryMessages: number;
      ttlMs: number;
      store?: SessionStore;
    }
  ) {
    this.store = opts.store ?? new MemorySessionStore();
  }

  get storeBackend(): "memory" | "redis" {
    return this.store.backend;
  }

  private now(): number {
    return Date.now();
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

  private async ensureSession(key: string): Promise<SessionData> {
    await this.store.pruneExpired(this.opts.ttlMs);
    const existing = await this.store.get(key);
    if (existing) {
      existing.lastSeenAt = this.now();
      return existing;
    }
    const created: SessionData = {
      key,
      lastSeenAt: this.now(),
      history: []
    };
    return created;
  }

  async enrichIncomingMessages(
    key: string,
    incoming: ChatMessage[]
  ): Promise<ChatMessage[]> {
    if (!this.opts.enabled) return incoming;
    const session = await this.ensureSession(key);
    if (!session.checkpointBlock) return incoming;
    return [{ role: "system", content: session.checkpointBlock }, ...incoming];
  }

  async recordTurn(key: string, userContent: string, assistantContent: string): Promise<void> {
    if (!this.opts.enabled) return;
    const session = await this.ensureSession(key);
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
    await this.store.set(key, session, this.opts.ttlMs);
  }

  async setPendingClarification(
    key: string,
    clarification: { question: string; options: string[]; assumptions: string[] },
  ): Promise<void> {
    if (!this.opts.enabled) return;
    const session = await this.ensureSession(key);
    session.pendingClarification = clarification;
    session.lastSeenAt = this.now();
    await this.store.set(key, session, this.opts.ttlMs);
  }

  async consumePendingClarification(
    key: string,
  ): Promise<{ question: string; options: string[]; assumptions: string[] } | undefined> {
    if (!this.opts.enabled) return undefined;
    const session = await this.ensureSession(key);
    const pending = session.pendingClarification;
    if (pending) {
      session.pendingClarification = undefined;
      session.lastSeenAt = this.now();
      await this.store.set(key, session, this.opts.ttlMs);
    }
    return pending;
  }

  async purge(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async telemetry(): Promise<SessionTelemetry> {
    await this.store.pruneExpired(this.opts.ttlMs);
    const allKeys = await this.store.keys();
    let checkpointed = 0;
    let entries = 0;
    for (const k of allKeys) {
      const record = await this.store.get(k);
      if (!record) continue;
      entries += record.history.length;
      if (record.checkpointBlock) checkpointed += 1;
    }
    return {
      activeSessions: allKeys.length,
      checkpointedSessions: checkpointed,
      totalHistoryEntries: entries,
      storeBackend: this.store.backend
    };
  }
}
