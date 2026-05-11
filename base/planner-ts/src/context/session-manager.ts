import {
  MemorySessionStore,
  type ChatMessage,
  type SessionData,
  type SessionStore
} from "./session-store.js";
import { buildDomainProfile, type DomainProfile } from "../nodes/domain-profile.js";

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

// ── Frame-aware structured compaction ──────────────────────────────

interface TopicThread {
  topic: string;
  status: "active" | "resolved";
  firstTurn: number;
  lastTurn: number;
}

interface SessionCheckpoint {
  domains: DomainProfile;
  topics: TopicThread[];
  userFacts: string[];
  conversationArc: string;
  turnCount: number;
}

const FACT_RE = /\b(i(?:'m| am)|my|we use|our|i prefer|i need|i want|i have|using|running)\b/i;
const ARC_PATTERNS: Array<{ arc: string; re: RegExp }> = [
  { arc: "tutoring", re: /\b(quiz|study|vocabulary|practice|exercise|learn|teach|test me|drill)\b/i },
  { arc: "debugging", re: /\b(error|bug|fail|crash|broken|fix|debug|stack\s*trace|exception)\b/i },
  { arc: "coding", re: /\b(code|snippet|function|implement|refactor|class|component)\b/i },
  { arc: "exploration", re: /\b(explore|ideas|creative|brainstorm|what if|possibilities|compare)\b/i },
  { arc: "analysis", re: /\b(analyze|review|evaluate|assess|audit|performance|benchmark)\b/i },
];

function extractUserFacts(userMessages: string[]): string[] {
  const facts: string[] = [];
  for (const msg of userMessages) {
    for (const sentence of msg.split(/[.!?\n]+/)) {
      const trimmed = sentence.trim();
      if (trimmed.length < 8 || trimmed.length > 200) continue;
      if (FACT_RE.test(trimmed)) {
        facts.push(trimmed);
      }
    }
  }
  const unique = [...new Set(facts)];
  return unique.slice(-12);
}

function detectConversationArc(allText: string): string {
  for (const { arc, re } of ARC_PATTERNS) {
    if (re.test(allText)) return arc;
  }
  return "general";
}

function extractTopics(history: ChatMessage[]): TopicThread[] {
  const windowSize = 4;
  const topics: TopicThread[] = [];
  let prevDomainKey = "";

  for (let i = 0; i < history.length; i += windowSize) {
    const window = history.slice(i, i + windowSize);
    const windowText = window.map((m) => m.content).join(" ");
    const profile = buildDomainProfile(windowText);
    const topDomain = profile.domains[0]?.key ?? "general";

    if (topDomain !== prevDomainKey) {
      if (topics.length > 0) {
        const prev = topics[topics.length - 1];
        prev.lastTurn = i - 1;
        prev.status = "resolved";
      }
      topics.push({
        topic: topDomain,
        status: "active",
        firstTurn: i,
        lastTurn: history.length - 1,
      });
      prevDomainKey = topDomain;
    } else if (topics.length > 0) {
      topics[topics.length - 1].lastTurn = Math.min(i + windowSize - 1, history.length - 1);
    }
  }

  return topics;
}

function buildStructuredCheckpoint(history: ChatMessage[]): SessionCheckpoint {
  const userTexts = history.filter((m) => m.role === "user").map((m) => m.content);
  const allText = history.map((m) => m.content).join(" ");

  const domains = buildDomainProfile(allText);
  const topics = extractTopics(history);
  const userFacts = extractUserFacts(userTexts);
  const conversationArc = detectConversationArc(allText);

  return {
    domains,
    topics,
    userFacts,
    conversationArc,
    turnCount: history.length,
  };
}

function renderCheckpoint(checkpoint: SessionCheckpoint, recentHistory: ChatMessage[]): string {
  const parts: string[] = ["<SESSION_STATE>"];

  parts.push(`Conversation arc: ${checkpoint.conversationArc} (${checkpoint.turnCount} turns)`);

  const domainDesc = checkpoint.domains.domains
    .slice(0, 4)
    .map((d) => `${d.key}(${(d.weight * 100).toFixed(0)}%)`)
    .join(", ");
  parts.push(`Active domains: ${domainDesc} [coherence: ${checkpoint.domains.frameCoherence}]`);

  if (checkpoint.topics.length > 0) {
    const topicLines = checkpoint.topics.map(
      (t) => `  - ${t.topic} [${t.status}] (turns ${t.firstTurn}-${t.lastTurn})`,
    );
    parts.push("Topic threads:");
    parts.push(...topicLines);
  }

  if (checkpoint.userFacts.length > 0) {
    parts.push("User stated facts/preferences:");
    for (const fact of checkpoint.userFacts) {
      parts.push(`  - ${fact}`);
    }
  }

  if (recentHistory.length > 0) {
    parts.push("Recent exchanges:");
    for (const m of recentHistory.slice(-6)) {
      parts.push(`  [${m.role}]: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }

  parts.push("</SESSION_STATE>");
  return parts.join("\n");
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
      checkpointIncludeRecentExchanges?: boolean;
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

  private summarize(history: ChatMessage[], recentTail: ChatMessage[]): string {
    const checkpoint = buildStructuredCheckpoint(history);
    return renderCheckpoint(
      checkpoint,
      this.opts.checkpointIncludeRecentExchanges ? recentTail : [],
    );
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
    await this.store.mutate(key, this.opts.ttlMs, (current) => {
      const session: SessionData = current ?? {
        key,
        lastSeenAt: this.now(),
        history: [],
      };
      if (userContent.trim()) session.history.push({ role: "user", content: userContent });
      const cleanedAssistant = sanitizeAssistantContent(assistantContent);
      if (cleanedAssistant.trim()) session.history.push({ role: "assistant", content: cleanedAssistant });
      if (session.history.length > this.opts.maxHistory) {
        session.history = session.history.slice(-this.opts.maxHistory);
      }

      if (session.history.length >= this.opts.checkpointEveryMessages) {
        const recentTail = session.history.slice(-Math.floor(this.opts.checkpointEveryMessages / 2));
        session.checkpointBlock = this.summarize(session.history, recentTail);
        session.history = recentTail;
      }
      session.lastSeenAt = this.now();
      return session;
    });
  }

  async setPendingClarification(
    key: string,
    clarification: { question: string; options: string[]; assumptions: string[]; originalTaskDescription?: string },
  ): Promise<void> {
    if (!this.opts.enabled) return;
    await this.store.mutate(key, this.opts.ttlMs, (current) => {
      const session: SessionData = current ?? {
        key,
        lastSeenAt: this.now(),
        history: [],
      };
      session.pendingClarification = clarification;
      session.lastSeenAt = this.now();
      return session;
    });
  }

  /** Read pending clarification without mutating session (peek before merge validation). */
  async getPendingClarification(
    key: string,
  ): Promise<{ question: string; options: string[]; assumptions: string[]; originalTaskDescription?: string } | undefined> {
    if (!this.opts.enabled) return undefined;
    const session = await this.store.get(key);
    return session?.pendingClarification;
  }

  /** Remove pending clarification after a validated merge (or explicit discard). */
  async clearPendingClarification(key: string): Promise<void> {
    if (!this.opts.enabled) return;
    const existing = await this.store.get(key);
    if (!existing?.pendingClarification) return;
    await this.store.mutate(key, this.opts.ttlMs, (current) => {
      const session: SessionData = current ?? existing;
      delete session.pendingClarification;
      session.lastSeenAt = this.now();
      return session;
    });
  }

  /**
   * Atomically take and clear pending clarification (e.g. tests or rare call sites).
   * Prefer getPendingClarification + clearPendingClarification after validation.
   */
  async consumePendingClarification(
    key: string,
  ): Promise<{ question: string; options: string[]; assumptions: string[]; originalTaskDescription?: string } | undefined> {
    const pending = await this.getPendingClarification(key);
    if (!pending) return undefined;
    await this.clearPendingClarification(key);
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
