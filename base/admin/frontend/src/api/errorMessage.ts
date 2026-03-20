import axios from "axios";

/** Best-effort message from FastAPI / axios error bodies. */
export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err) && err.response?.data) {
    const data = err.response.data as { detail?: unknown };
    const d = data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length && typeof d[0] === "object" && d[0] && "msg" in d[0]) {
      return String((d[0] as { msg: string }).msg);
    }
  }
  if (err instanceof Error) return err.message;
  return "Request failed";
}
