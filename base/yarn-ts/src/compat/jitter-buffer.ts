/**
 * Jitter buffer: separates dynamic/ephemeral content from the stable
 * system prefix so the static portion stays cache-stable across requests.
 *
 * "Jitter" = high-churn strings like timestamps, cwd paths, session IDs,
 * branch names, etc.  These are moved to the tail of the final user message
 * so tool definitions + static system instructions form a consistent
 * cacheable prefix.
 */

const JITTER_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,              // ISO timestamps
  /\bcwd[=: ]+\S+/i,                                    // cwd paths
  /\b(session[_-]?id|conversation[_-]?id)[=: ]+\S+/i,  // session IDs
  /\bbranch[=: ]+\S+/i,                                 // git branch refs
  /\bToday.s date:/i,                                   // "Today's date:" lines
];

interface MessageLike {
  role: string;
  content: unknown;
}

export interface JitterSplit {
  stableMessages: MessageLike[];
  jitterBlock: string | null;
}

/**
 * Scan system messages for dynamic lines. Extract them into a jitter block
 * that callers append to the final user message.
 */
export function splitJitter(messages: MessageLike[]): JitterSplit {
  const jitterLines: string[] = [];
  const stableMessages: MessageLike[] = [];

  for (const m of messages) {
    if (m.role !== "system" || typeof m.content !== "string") {
      stableMessages.push(m);
      continue;
    }

    const lines = m.content.split("\n");
    const stable: string[] = [];
    for (const line of lines) {
      if (JITTER_PATTERNS.some((re) => re.test(line))) {
        jitterLines.push(line);
      } else {
        stable.push(line);
      }
    }

    if (stable.length > 0) {
      stableMessages.push({ role: "system", content: stable.join("\n") });
    }
  }

  return {
    stableMessages,
    jitterBlock: jitterLines.length > 0 ? jitterLines.join("\n") : null
  };
}

/**
 * Append jitter content to the final user message in the array.
 * If no user message exists, append a new one.
 */
export function applyJitter(messages: MessageLike[], jitter: string | null): MessageLike[] {
  if (!jitter) return messages;

  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user" && typeof out[i].content === "string") {
      out[i] = { ...out[i], content: `${out[i].content}\n\n<ENVIRONMENT_CONTEXT>\n${jitter}\n</ENVIRONMENT_CONTEXT>` };
      return out;
    }
  }

  out.push({ role: "user", content: `<ENVIRONMENT_CONTEXT>\n${jitter}\n</ENVIRONMENT_CONTEXT>` });
  return out;
}
