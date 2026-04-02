import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import axios from "axios";
import type { User, OidcConfig } from "../../types";
import { AuthContext } from "./authContext";

const TOKEN_KEY = "synesis_token";
const REFRESH_KEY = "synesis_refresh_token";
const EXPIRES_KEY = "synesis_token_expires_at";
const USER_KEY = "synesis_user";
/** OIDC id_token — sent as id_token_hint to Keycloak logout so the SSO session ends. */
const ID_TOKEN_KEY = "synesis_id_token";
const POST_LOGOUT_FLAG = "synesis_post_logout";
const OIDC_STATE_KEY = "synesis_oidc_state";

function loadPersistedAuth(): { user: User | null; token: string | null } {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    if (token && raw) {
      return { token, user: JSON.parse(raw) };
    }
  } catch {
    /* corrupted storage */
  }
  return { user: null, token: null };
}

function clearPersistedAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ID_TOKEN_KEY);
}

function persistTokens(
  access: string,
  refresh?: string,
  expiresIn?: number,
  idToken?: string | null,
) {
  localStorage.setItem(TOKEN_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  if (expiresIn) {
    localStorage.setItem(EXPIRES_KEY, String(Date.now() + expiresIn * 1000));
  }
  if (idToken) {
    localStorage.setItem(ID_TOKEN_KEY, idToken);
  }
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState(loadPersistedAuth);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Proactively refresh the access token before it expires.
  // If the token is already nearly expired (< 60s), refresh immediately.
  // Otherwise refresh at 75% of remaining lifetime.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) || "0");
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!expiresAt || !refreshToken) return;

    const remaining = expiresAt - Date.now();
    // If less than 60 seconds remain, refresh now; otherwise at 75% of remaining
    const delay = remaining < 60_000 ? 0 : remaining * 0.75;

    const doRefresh = async () => {
      try {
        const { data } = await axios.post<{
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
          id_token?: string;
        }>("/api/v1/auth/oauth/refresh", {
          refresh_token: localStorage.getItem(REFRESH_KEY),
        });
        persistTokens(
          data.access_token,
          data.refresh_token,
          data.expires_in,
          data.id_token,
        );
        setAuth((prev) => ({ ...prev, token: data.access_token }));
        scheduleRefresh();
      } catch {
        // Retry once after 10 seconds before giving up
        refreshTimerRef.current = setTimeout(async () => {
          try {
            const rt = localStorage.getItem(REFRESH_KEY);
            if (!rt) return;
            const { data } = await axios.post<{
              access_token: string;
              refresh_token?: string;
              expires_in?: number;
              id_token?: string;
            }>("/api/v1/auth/oauth/refresh", { refresh_token: rt });
            persistTokens(
              data.access_token,
              data.refresh_token,
              data.expires_in,
              data.id_token,
            );
            setAuth((prev) => ({ ...prev, token: data.access_token }));
            scheduleRefresh();
          } catch {
            // Give up — user will be redirected on next 401
          }
        }, 10_000);
      }
    };

    if (delay === 0) {
      void doRefresh();
    } else {
      refreshTimerRef.current = setTimeout(doRefresh, delay);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // On mount: start refresh timer if we have a refresh token.
  useEffect(() => {
    if (auth.token && localStorage.getItem(REFRESH_KEY)) {
      scheduleRefresh();
    }
  }, [auth.token, scheduleRefresh]);

  useEffect(() => {
    axios
      .get<OidcConfig>("/api/v1/auth/oidc-config")
      .then(({ data }) => setOidcConfig(data))
      .catch(() => setOidcConfig({ enabled: false }))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (_username: string, _password: string) => {
    throw new Error(
      "Local login was removed. Configure Keycloak (SYNESIS_KEYCLOAK_ISSUER_URL) or use a PAT.",
    );
  }, []);

  const loginWithOidc = useCallback(async () => {
    if (!oidcConfig?.enabled || !oidcConfig.issuer || !oidcConfig.client_id)
      return;

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = crypto.randomUUID();

    sessionStorage.setItem("synesis_pkce_verifier", verifier);
    sessionStorage.setItem(OIDC_STATE_KEY, state);

    const redirectUri = `${window.location.origin}/callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: oidcConfig.client_id,
      redirect_uri: redirectUri,
      scope: oidcConfig.scopes || "openid profile email",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

    window.location.href = `${oidcConfig.issuer}/protocol/openid-connect/auth?${params}`;
  }, [oidcConfig]);

  const logout = useCallback(() => {
    const issuer = oidcConfig?.issuer?.replace(/\/$/, "");
    const clientId = oidcConfig?.client_id;
    const oidcEnabled = oidcConfig?.enabled ?? false;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    const idToken = localStorage.getItem(ID_TOKEN_KEY);
    if (oidcEnabled) {
      sessionStorage.setItem(POST_LOGOUT_FLAG, "1");
    }
    clearPersistedAuth();
    setAuth({ user: null, token: null });

    const loginUrl = `${window.location.origin}/login`;
    if (oidcEnabled && issuer && clientId) {
      const redirectUri = encodeURIComponent(loginUrl);
      let logoutUrl = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${redirectUri}&client_id=${encodeURIComponent(clientId)}`;
      if (idToken) {
        logoutUrl += `&id_token_hint=${encodeURIComponent(idToken)}`;
      }
      window.location.assign(logoutUrl);
      return;
    }
    window.location.replace(loginUrl);
  }, [oidcConfig]);

  return (
    <AuthContext.Provider
      value={{
        user: auth.user,
        token: auth.token,
        login,
        loginWithOidc,
        logout,
        isAdmin:
          auth.user?.role === "admin" ||
          auth.user?.role === "platform_admin" ||
          auth.user?.role === "org_admin",
        isAuthenticated: !!auth.token,
        oidcConfig,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
