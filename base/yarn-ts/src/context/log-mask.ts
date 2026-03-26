export function maskVerboseLog(content: string, keepHead = 10, keepTail = 10): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= keepHead + keepTail + 1) {
    return content;
  }
  const hidden = lines.length - keepHead - keepTail;
  const head = lines.slice(0, keepHead).join("\n");
  const tail = lines.slice(-keepTail).join("\n");
  return `${head}\n[... ${hidden} lines of log suppressed. Call read_full_log if needed ...]\n${tail}`;
}
