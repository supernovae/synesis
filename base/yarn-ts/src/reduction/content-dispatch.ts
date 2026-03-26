/**
 * Content-Type Dispatch
 *
 * Pre-filters tool output by detecting content type before the family classifier runs.
 * Routes content to specialized handling paths:
 * - json-array → JSON compactor
 * - json-object → key summary
 * - log-stream → dedup + head/tail
 * - text → pass to family classifier (default)
 */

export type DetectedContentType =
  | "json-array"
  | "json-object"
  | "log-stream"
  | "text";

export interface ContentDispatchStats {
  dispatched: number;
  byType: Record<DetectedContentType, number>;
}

const LOG_TIMESTAMP_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/m;
const LOG_LEVEL_RE = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE|CRITICAL)\b/i;

export function detectContentType(raw: string): DetectedContentType {
  const trimmed = raw.trimStart();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length >= 3) return "json-array";
    } catch { /* not valid JSON array */ }
  }

  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return "json-object";
    } catch { /* not valid JSON object */ }
  }

  const lines = raw.split("\n");
  if (lines.length >= 5) {
    let logLineCount = 0;
    const sampleSize = Math.min(lines.length, 20);
    for (let i = 0; i < sampleSize; i++) {
      if (LOG_TIMESTAMP_RE.test(lines[i]) || LOG_LEVEL_RE.test(lines[i])) {
        logLineCount++;
      }
    }
    if (logLineCount / sampleSize >= 0.4) return "log-stream";
  }

  return "text";
}

/**
 * Compress a log stream by deduplicating repeated patterns and keeping
 * head + tail lines. Preserves error/warning lines in full.
 */
export function compressLogStream(raw: string, maxLines = 40): string {
  const lines = raw.split("\n");
  if (lines.length <= maxLines) return raw;

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    if (/\b(ERROR|FATAL|CRITICAL|EXCEPTION)\b/i.test(line)) {
      errors.push(line);
    } else if (/\b(WARN(?:ING)?)\b/i.test(line)) {
      if (warnings.length < 5) warnings.push(line);
    }
  }

  const headCount = Math.min(10, Math.floor(maxLines * 0.25));
  const tailCount = Math.min(10, Math.floor(maxLines * 0.25));
  const head = lines.slice(0, headCount);
  const tail = lines.slice(-tailCount);

  const parts = [
    `<LOG_STREAM lines="${lines.length}" shown="${headCount + tailCount + errors.length + warnings.length}">`,
    ...head,
    `... ${lines.length - headCount - tailCount} lines omitted ...`
  ];

  if (errors.length > 0) {
    parts.push(`[${errors.length} error lines:]`);
    parts.push(...errors.slice(0, 10));
  }
  if (warnings.length > 0) {
    parts.push(`[${warnings.length} warning lines:]`);
    parts.push(...warnings);
  }

  parts.push(...tail);
  parts.push("</LOG_STREAM>");
  return parts.join("\n");
}

/**
 * Summarize a JSON object by keeping top-level keys and truncating deep values.
 */
export function summarizeJsonObject(raw: string, maxChars = 2000): string {
  if (raw.length <= maxChars) return raw;

  try {
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    const summary: Record<string, unknown> = {};

    for (const key of keys) {
      const val = obj[key];
      if (typeof val === "string" && val.length > 200) {
        summary[key] = val.slice(0, 200) + "...";
      } else if (Array.isArray(val) && val.length > 5) {
        summary[key] = `[Array(${val.length})]`;
      } else if (typeof val === "object" && val !== null) {
        const nested = JSON.stringify(val);
        summary[key] = nested.length > 200 ? `{Object(${Object.keys(val).length} keys)}` : val;
      } else {
        summary[key] = val;
      }
    }

    return `<JSON_SUMMARY keys="${keys.length}" original_chars="${raw.length}">\n${JSON.stringify(summary, null, 2)}\n</JSON_SUMMARY>`;
  } catch {
    return raw.slice(0, maxChars) + "...";
  }
}

export class ContentDispatchService {
  private stats: ContentDispatchStats = {
    dispatched: 0,
    byType: { "json-array": 0, "json-object": 0, "log-stream": 0, text: 0 }
  };

  dispatch(raw: string): { type: DetectedContentType; transformed: string | null } {
    const type = detectContentType(raw);
    this.stats.dispatched++;
    this.stats.byType[type]++;

    switch (type) {
      case "log-stream":
        return { type, transformed: compressLogStream(raw) };
      case "json-object":
        return { type, transformed: raw.length > 2000 ? summarizeJsonObject(raw) : null };
      case "json-array":
      case "text":
        return { type, transformed: null };
    }
  }

  getStats(): ContentDispatchStats {
    return { ...this.stats, byType: { ...this.stats.byType } };
  }
}
