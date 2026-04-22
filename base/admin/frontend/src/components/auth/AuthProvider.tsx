import { useState, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import axios from "axios";
import type { User, OidcConfig } from "../../types";
import { resolveKeycloakRealmIssuer } from "../../utils/keycloakUrls";
import {
  TOKEN_KEY,
  REFRESH_KEY,
  EXPIRES_KEY,
  USER_KEY,
  clearPersistedAuth,
  refreshAccessToken,
} from "../../utils/oidcSession";
import { AuthContext } from "./authContext";

const POST_LOGOUT_FLAG = "synesis_post_logout";
const OIDC_STATE_KEY = "synesis_oidc_state";
const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";
const OIDC_ISSUER_CACHE_KEY = "synesis_oidc_issuer";
const OIDC_CLIENT_ID_CACHE_KEY = "synesis_oidc_client_id";

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
  /** Breaks self-reference cycle for `scheduleRefresh` inside the refresh callback (react-hooks/immutability). */
  const scheduleRefreshRef = useRef<() => void>(() => {});

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
      const refreshed = await refreshAccessToken({ retries: 2, retryDelayMs: 1_500 });
      if (!refreshed) return;
      setAuth((prev) => ({ ...prev, token: refreshed }));
      scheduleRefreshRef.current();
    };

    if (delay === 0) {
      void doRefresh();
    } else {
      refreshTimerRef.current = setTimeout(() => {
        void doRefresh();
      }, delay);
    }
  }, []);

  useLayoutEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh;
  }, [scheduleRefresh]);

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
      .then(({ data }) => {
        setOidcConfig(data);
        if (data?.enabled && data.issuer && data.client_id) {
          const realmIssuer = resolveKeycloakRealmIssuer(data.issuer);
          if (realmIssuer) {
            sessionStorage.setItem(OIDC_ISSUER_CACHE_KEY, realmIssuer);
          }
          sessionStorage.setItem(OIDC_CLIENT_ID_CACHE_KEY, data.client_id);
        }
      })
      .catch(() => setOidcConfig({ enabled: false }))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    void username;
    void password;
    throw new Error(
      "Local login was removed. Configure Keycloak (SYNESIS_KEYCLOAK_ISSUER_URL) or use a PAT.",
    );
  }, []);

  const loginWithOidc = useCallback(async () => {
    if (!oidcConfig?.enabled || !oidcConfig.client_id)
      return;
    const realmIssuer = resolveKeycloakRealmIssuer(oidcConfig.issuer);
    if (!realmIssuer) return;

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

    window.location.assign(`${realmIssuer}/protocol/openid-connect/auth?${params.toString()}`);
  }, [oidcConfig]);

  const logout = useCallback(() => {
    const issuer =
      resolveKeycloakRealmIssuer(oidcConfig?.issuer) ||
      resolveKeycloakRealmIssuer(sessionStorage.getItem(OIDC_ISSUER_CACHE_KEY) || undefined) ||
      "";
    const clientId =
      oidcConfig?.client_id || sessionStorage.getItem(OIDC_CLIENT_ID_CACHE_KEY) || "";
    const oidcConfigured =
      !loading &&
      (oidcConfig !== null
        ? Boolean(oidcConfig.enabled)
        : Boolean(sessionStorage.getItem(OIDC_ISSUER_CACHE_KEY)));
    const oidcEnabled = Boolean(oidcConfigured && issuer && clientId);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    const idToken = localStorage.getItem("synesis_id_token");
    // Always require manual OIDC re-entry after logout to prevent SSO loops.
    sessionStorage.setItem(POST_LOGOUT_FLAG, "1");
    sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
    clearPersistedAuth();
    setAuth({ user: null, token: null });

    const loginUrl = `${window.location.origin}/login`;
    if (oidcEnabled) {
      const params = new URLSearchParams({
        post_logout_redirect_uri: loginUrl,
      });
      if (idToken) {
        params.set("id_token_hint", idToken);
      } else {
        params.set("client_id", clientId);
      }
      const logoutUrl = `${issuer}/protocol/openid-connect/logout?${params.toString()}`;
      window.location.assign(logoutUrl);
      return;
    }
    window.location.replace(loginUrl);
  }, [oidcConfig, loading]);

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
