/**
 * Detect degenerate model output that is only JSON metadata (e.g. OpenAI-style tags),
 * not user-facing prose. Used to avoid dead-end turns that show only a tag blob.
 */

/** True when trimmed content parses as a single-object JSON with only a string[] `tags` field. */
export function isMetadataTagsOnlyJson(content: string): boolean {
  const s = content.trim();
  if (s.length < 10 || !s.startsWith("{")) return false;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== 1 || keys[0] !== "tags") return false;
    const tags = o.tags;
    if (!Array.isArray(tags) || tags.length === 0) return false;
    return tags.every((x) => typeof x === "string");
  } catch {
    return false;
  }
}
