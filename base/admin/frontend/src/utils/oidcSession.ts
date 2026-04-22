import axios from "axios";
import { resolveAccessTokenExpiresAtMs } from "./jwtExpiry";

export const TOKEN_KEY = "synesis_token";
export const REFRESH_KEY = "synesis_refresh_token";
export const EXPIRES_KEY = "synesis_token_expires_at";
export const USER_KEY = "synesis_user";
export const ID_TOKEN_KEY = "synesis_id_token";

interface OidcRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

interface RefreshOptions {
  retries?: number;
  retryDelayMs?: number;
}

let refreshInFlight: Promise<string | null> | null = null;

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

export function clearPersistedAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ID_TOKEN_KEY);
}

export function persistTokens(
  access: string,
  refresh?: string,
  expiresIn?: number,
  idToken?: string | null,
): void {
  localStorage.setItem(TOKEN_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  const expiresAt = resolveAccessTokenExpiresAtMs(access, expiresIn);
  if (expiresAt) {
    localStorage.setItem(EXPIRES_KEY, String(expiresAt));
  }
  if (idToken) {
    localStorage.setItem(ID_TOKEN_KEY, idToken);
  }
}

export async function refreshAccessToken(options: RefreshOptions = {}): Promise<string | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const retries = Math.max(0, options.retries ?? 1);
  const retryDelayMs = Math.max(250, options.retryDelayMs ?? 1_000);

  refreshInFlight = (async () => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (!refreshToken) return null;

      try {
        const { data } = await axios.post<OidcRefreshResponse>("/api/v1/auth/oauth/refresh", {
          refresh_token: refreshToken,
        });
        if (!data?.access_token) return null;

        persistTokens(data.access_token, data.refresh_token, data.expires_in, data.id_token);
        return data.access_token;
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
