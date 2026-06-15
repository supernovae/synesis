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

interface HttpError extends Error {
  response?: { status: number };
}

function httpError(response: Response): HttpError {
  const error = new Error(response.statusText || "Request failed") as HttpError;
  error.response = { status: response.status };
  return error;
}

function shouldRetryRefresh(error: unknown): boolean {
  const status = (error as HttpError | null)?.response?.status;
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
        const headers = new Headers();
        const csrf = getCookie(CSRF_COOKIE_KEY);
        if (csrf) headers.set(CSRF_HEADER_KEY, csrf);
        const response = await fetch("/api/v1/auth/oauth/refresh", {
          method: "POST",
          headers,
          credentials: "include",
        });
        if (!response.ok) throw httpError(response);
        const data = await response.json() as SessionResponse;
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
