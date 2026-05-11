type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null };

export interface OptimizationStats {
  reducedCount: number;
  reducedCharsTotal: number;
  rawCharsTotal: number;
}

export interface OptimizationResult {
  messages: ChatMessage[];
  stats: OptimizationStats;
}

function reduceOversizedContent(content: string, maxChars: number): { content: string; reduced: boolean; rawChars: number; reducedChars: number } {
  const rawChars = content.length;
  if (rawChars <= maxChars) {
    return { content, reduced: false, rawChars, reducedChars: rawChars };
  }

  const head = content.slice(0, Math.floor(maxChars * 0.45));
  const tail = content.slice(-Math.floor(maxChars * 0.35));
  const reduced = [
    head,
    "",
    `<TOOL_RESULT_SUMMARY raw_chars="${rawChars}" reduced_chars="${head.length + tail.length}">`,
    "middle payload omitted for token efficiency; retrieve raw artifact from upstream system if needed",
    "</TOOL_RESULT_SUMMARY>",
    "",
    tail
  ].join("\n");

  return { content: reduced, reduced: true, rawChars, reducedChars: reduced.length };
}

/**
 * Deterministic admission optimization inspired by yarn-ts:
 * - keep system messages at front
 * - preserve chronological conversation order so downstream prompt composers can
 *   reliably treat the final user message as the current task
 * - cap historical message count
 * - reduce oversized payloads before model admission
 */
export function optimizeContext(
  input: ChatMessage[],
  options: { maxCharsPerMessage: number; recentMessageLimit: number }
): OptimizationResult {
  const stats: OptimizationStats = { reducedCount: 0, reducedCharsTotal: 0, rawCharsTotal: 0 };

  const normalized = input.map((message) => {
    const content = message.content ?? "";
    const reduced = reduceOversizedContent(content, options.maxCharsPerMessage);
    stats.rawCharsTotal += reduced.rawChars;
    stats.reducedCharsTotal += reduced.reducedChars;
    if (reduced.reduced) stats.reducedCount += 1;
    return { ...message, content: reduced.content };
  });

  const system = normalized.filter((message) => message.role === "system");
  const nonSystem = normalized.filter((message) => message.role !== "system");
  const recent = nonSystem.slice(-options.recentMessageLimit);

  const ordered = [...system, ...recent];
  return { messages: ordered, stats };
}
