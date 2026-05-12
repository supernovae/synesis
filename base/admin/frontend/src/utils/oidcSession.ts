import axios from "axios";
import type { User } from "../types";

export const TOKEN_KEY = "synesis_token";
export const REFRESH_KEY = "synesis_refresh_token";
export const EXPIRES_KEY = "synesis_token_expires_at";
export const USER_KEY = "synesis_user";
export const ID_TOKEN_KEY = "synesis_id_token";
export const CSRF_COOKIE_KEY = "synesis_admin_csrf";
export const CSRF_HEADER_KEY = "X-Synesis-CSRF";

interface SessionResponse {
  status: "ok";
  user: User;
}

interface RefreshOptions {
  retries?: number;
  retryDelayMs?: number;
}

let refreshInFlight: Promise<User | null> | null = null;

function shouldRetryRefresh(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status == null) return true;
  return status >= 500 || status === 429;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function getCookie(name: string): string {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) {
      return decodeURIComponent(item.slice(prefix.length));
    }
  }
  return "";
}

export function clearPersistedAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ID_TOKEN_KEY);
}

export function persistUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function refreshSession(options: RefreshOptions = {}): Promise<User | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const retries = Math.max(0, options.retries ?? 1);
  const retryDelayMs = Math.max(250, options.retryDelayMs ?? 1_000);

  refreshInFlight = (async () => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const { data } = await axios.post<SessionResponse>(
          "/api/v1/auth/oauth/refresh",
          undefined,
          { headers: { [CSRF_HEADER_KEY]: getCookie(CSRF_COOKIE_KEY) }, withCredentials: true },
        );
        if (!data?.user) return null;
        persistUser(data.user);
        return data.user;
      } catch (error) {
        const canRetry = attempt < retries && shouldRetryRefresh(error);
        if (!canRetry) break;
        await wait(retryDelayMs * (attempt + 1));
      }
    }
    return null;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}
