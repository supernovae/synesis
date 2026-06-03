/** Quote a shell argument for generated diagnostic commands. */
export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** One-line JSON on stderr + exit 2. Output is parseable by agents. */
export function buildStructuredErrorBashCommand(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return `printf '%s\\n' ${shellEscape(json)} >&2; exit 2`;
}

/** User-safe stderr message + exit 2 for client-visible tool failures. */
export function buildUserSafeErrorBashCommand(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return `printf '%s\\n' ${shellEscape(compact)} >&2; exit 2`;
}
