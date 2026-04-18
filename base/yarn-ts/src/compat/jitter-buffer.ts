/**
 * Jitter buffer: separates dynamic/ephemeral content from the stable
 * system prefix so the static portion stays cache-stable across requests.
 *
 * "Jitter" = high-churn strings like timestamps, cwd paths, session IDs,
 * branch names, PIDs, ephemeral ports, temp paths, etc.  These are moved to
 * the tail of the final user message so tool definitions + static system
 * instructions form a consistent cacheable prefix.
 *
 * Processes both system AND user messages, and handles both string content
 * and array content blocks (multimodal messages).
 */

const JITTER_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,               // ISO timestamps
  /\bcwd[=: ]+\S+/i,                                     // cwd paths
  /\b(session[_-]?id|conversation[_-]?id)[=: ]+\S+/i,   // session IDs
  /\bbranch[=: ]+\S+/i,                                  // git branch refs
  /\bToday.s date:/i,                                    // "Today's date:" lines
  /\bpid[=: ]+\d+/i,                                     // process IDs
  /\b(port|PORT)[=: ]+\d{4,5}\b/,                        // ephemeral ports
  /\/tmp\/[a-zA-Z0-9_.-]{6,}/,                           // temp paths
  /\b[0-9a-f]{12,64}\b(?=.*(?:container|image|sha|digest))/i, // container/image hashes
  /\bOS Version:.+/i,                                    // "OS Version: ..." lines
  /\bShell:.+/i,                                         // "Shell: ..." lines
];

interface MessageLike {
  role: string;
  content: unknown;
}

/** Content block in a multimodal message (Anthropic/OpenAI array format). */
interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface JitterSplit {
  stableMessages: MessageLike[];
  jitterBlock: string | null;
  extractedLineCount: number;
}

function isTextBlock(b: unknown): b is TextBlock {
  return b != null && typeof b === "object" && (b as TextBlock).type === "text" && typeof (b as TextBlock).text === "string";
}

function splitLinesForJitter(text: string, jitterLines: string[]): { stable: string; extracted: number } {
  const lines = text.split("\n");
  const stable: string[] = [];
  let extracted = 0;
  for (const line of lines) {
    if (JITTER_PATTERNS.some((re) => re.test(line))) {
      jitterLines.push(line);
      extracted += 1;
    } else {
      stable.push(line);
    }
  }
  return { stable: stable.join("\n"), extracted };
}

/**
 * Scan system and user messages for dynamic lines. Extract them into a jitter
 * block that callers append to the final user message.
 *
 * Eligible roles: system, user (not assistant or tool — those carry model output
 * or tool results that should not be rewritten here).
 */
export function splitJitter(messages: MessageLike[]): JitterSplit {
  const jitterLines: string[] = [];
  const stableMessages: MessageLike[] = [];
  const ELIGIBLE_ROLES = new Set(["system", "user"]);

  for (const m of messages) {
    if (!ELIGIBLE_ROLES.has(m.role)) {
      stableMessages.push(m);
      continue;
    }

    // String content
    if (typeof m.content === "string") {
      const { stable, extracted } = splitLinesForJitter(m.content, jitterLines);
      if (extracted > 0) {
        if (stable.trim().length > 0) {
          stableMessages.push({ ...m, content: stable });
        }
      } else {
        stableMessages.push(m);
      }
      continue;
    }

    // Array content blocks (multimodal)
    if (Array.isArray(m.content)) {
      let anyExtracted = false;
      const newBlocks: unknown[] = [];
      for (const block of m.content as unknown[]) {
        if (isTextBlock(block)) {
          const { stable, extracted } = splitLinesForJitter(block.text, jitterLines);
          if (extracted > 0) {
            anyExtracted = true;
            if (stable.trim().length > 0) {
              newBlocks.push({ ...block, text: stable });
            }
          } else {
            newBlocks.push(block);
          }
        } else {
          newBlocks.push(block);
        }
      }
      if (anyExtracted) {
        if (newBlocks.length > 0) {
          stableMessages.push({ ...m, content: newBlocks });
        }
      } else {
        stableMessages.push(m);
      }
      continue;
    }

    stableMessages.push(m);
  }

  return {
    stableMessages,
    jitterBlock: jitterLines.length > 0 ? jitterLines.join("\n") : null,
    extractedLineCount: jitterLines.length,
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
