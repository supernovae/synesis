import { useCallback, useEffect, useState, type ReactNode } from "react";
import client from "../../api/client";
import type { OidcConfig, User } from "../../types";
import { resolveKeycloakRealmIssuer } from "../../utils/keycloakUrls";
import {
  CSRF_COOKIE_KEY,
  CSRF_HEADER_KEY,
  clearPersistedAuth,
  getCookie,
  persistUser,
  USER_KEY,
} from "../../utils/oidcSession";
import { AuthContext } from "./authContext";

const POST_LOGOUT_FLAG = "synesis_post_logout";
const OIDC_STATE_KEY = "synesis_oidc_state";
const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";
const OIDC_ISSUER_CACHE_KEY = "synesis_oidc_issuer";
const OIDC_CLIENT_ID_CACHE_KEY = "synesis_oidc_client_id";

function loadPersistedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
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
  const [user, setUser] = useState<User | null>(loadPersistedUser);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadAuth() {
      try {
        const [{ data: config }, { data: currentUser }] = await Promise.all([
          client.get<OidcConfig>("/auth/oidc-config"),
          client.get<User>("/auth/me"),
        ]);
        if (cancelled) return;
        setOidcConfig(config);
        if (config?.enabled && config.issuer && config.client_id) {
          const realmIssuer = resolveKeycloakRealmIssuer(config.issuer);
          if (realmIssuer) sessionStorage.setItem(OIDC_ISSUER_CACHE_KEY, realmIssuer);
          sessionStorage.setItem(OIDC_CLIENT_ID_CACHE_KEY, config.client_id);
        }
        setUser(currentUser);
        persistUser(currentUser);
      } catch {
        if (!cancelled) {
          clearPersistedAuth();
          setUser(null);
          try {
            const { data } = await client.get<OidcConfig>("/auth/oidc-config");
            if (!cancelled) setOidcConfig(data);
          } catch {
            if (!cancelled) setOidcConfig({ enabled: false });
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    void username;
    void password;
    throw new Error("Local login was removed. Configure Keycloak (SYNESIS_KEYCLOAK_ISSUER_URL) or use a PAT.");
  }, []);

  const loginWithOidc = useCallback(async () => {
    if (!oidcConfig?.enabled || !oidcConfig.client_id) return;
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
    const clientId = oidcConfig?.client_id || sessionStorage.getItem(OIDC_CLIENT_ID_CACHE_KEY) || "";
    const oidcConfigured =
      !loading &&
      (oidcConfig !== null ? Boolean(oidcConfig.enabled) : Boolean(sessionStorage.getItem(OIDC_ISSUER_CACHE_KEY)));
    const oidcEnabled = Boolean(oidcConfigured && issuer && clientId);

    sessionStorage.setItem(POST_LOGOUT_FLAG, "1");
    sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
    const headers = new Headers({ "Content-Type": "application/json" });
    const csrf = getCookie(CSRF_COOKIE_KEY);
    if (csrf) headers.set(CSRF_HEADER_KEY, csrf);
    void fetch("/api/v1/auth/logout", { method: "POST", headers, body: "{}", credentials: "include" })
      .catch(() => undefined);
    clearPersistedAuth();
    setUser(null);

    const loginUrl = `${window.location.origin}/login`;
    if (oidcEnabled) {
      const params = new URLSearchParams({
        post_logout_redirect_uri: loginUrl,
        client_id: clientId,
      });
      window.location.assign(`${issuer}/protocol/openid-connect/logout?${params.toString()}`);
      return;
    }
    window.location.replace(loginUrl);
  }, [oidcConfig, loading]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token: null,
        login,
        loginWithOidc,
        logout,
        isAdmin: user?.role === "admin" || user?.role === "platform_admin" || user?.role === "org_admin",
        isAuthenticated: !!user,
        oidcConfig,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
