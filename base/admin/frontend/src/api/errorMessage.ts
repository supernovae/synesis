/** Best-effort message from FastAPI error bodies. */
export function apiErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data;
  if (data) {
    const d = data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length && typeof d[0] === "object" && d[0] && "msg" in d[0]) {
      return String((d[0] as { msg: string }).msg);
    }
  }
  if (err instanceof Error) return err.message;
  return "Request failed";
}
