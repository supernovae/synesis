import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import axios from "axios";
import type { User, AuthResponse, OidcConfig } from "../../types";

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  loginWithOidc: () => void;
  logout: () => void;
  isAdmin: boolean;
  isAuthenticated: boolean;
  oidcConfig: OidcConfig | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "synesis_token";
const REFRESH_KEY = "synesis_refresh_token";
const EXPIRES_KEY = "synesis_token_expires_at";
const USER_KEY = "synesis_user";

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
}

function persistTokens(access: string, refresh?: string, expiresIn?: number) {
  localStorage.setItem(TOKEN_KEY, access);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  if (expiresIn) {
    localStorage.setItem(EXPIRES_KEY, String(Date.now() + expiresIn * 1000));
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

  // Schedule a silent refresh at 75% of token lifetime.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) || "0");
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!expiresAt || !refreshToken) return;

    const remaining = expiresAt - Date.now();
    // Refresh at 75% of remaining lifetime, minimum 30 seconds.
    const delay = Math.max(remaining * 0.75, 30_000);

    refreshTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await axios.post("/api/v1/auth/oauth/refresh", {
          refresh_token: localStorage.getItem(REFRESH_KEY),
        });
        persistTokens(data.access_token, data.refresh_token, data.expires_in);
        setAuth((prev) => ({ ...prev, token: data.access_token }));
        scheduleRefresh();
      } catch {
        // Refresh failed — user will be redirected on next 401.
      }
    }, delay);
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

  const login = useCallback(async (username: string, password: string) => {
    const { data } = await axios.post<AuthResponse>("/api/v1/auth/login", {
      username,
      password,
    });
    persistTokens(data.access_token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setAuth({ user: data.user, token: data.access_token });
  }, []);

  const loginWithOidc = useCallback(async () => {
    if (!oidcConfig?.enabled || !oidcConfig.issuer || !oidcConfig.client_id)
      return;

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);

    sessionStorage.setItem("synesis_pkce_verifier", verifier);

    const redirectUri = `${window.location.origin}/callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: oidcConfig.client_id,
      redirect_uri: redirectUri,
      scope: oidcConfig.scopes || "openid profile email",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: crypto.randomUUID(),
    });

    window.location.href = `${oidcConfig.issuer}/protocol/openid-connect/auth?${params}`;
  }, [oidcConfig]);

  const logout = useCallback(() => {
    const issuer = oidcConfig?.issuer;
    const clientId = oidcConfig?.client_id;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    clearPersistedAuth();
    setAuth({ user: null, token: null });

    if (issuer && clientId) {
      const redirectUri = encodeURIComponent(window.location.origin + "/login");
      window.location.href = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${redirectUri}&client_id=${clientId}`;
    }
  }, [oidcConfig]);

  return (
    <AuthContext.Provider
      value={{
        user: auth.user,
        token: auth.token,
        login,
        loginWithOidc,
        logout,
        isAdmin: auth.user?.role === "admin",
        isAuthenticated: !!auth.token,
        oidcConfig,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
