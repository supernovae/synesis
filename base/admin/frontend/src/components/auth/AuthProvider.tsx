import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
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

function loadPersistedAuth(): { user: User | null; token: string | null } {
  try {
    const token = localStorage.getItem("synesis_token");
    const raw = localStorage.getItem("synesis_user");
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
    localStorage.setItem("synesis_token", data.access_token);
    localStorage.setItem("synesis_user", JSON.stringify(data.user));
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
    localStorage.removeItem("synesis_token");
    localStorage.removeItem("synesis_user");
    setAuth({ user: null, token: null });

    if (issuer) {
      const redirectUri = encodeURIComponent(window.location.origin + "/login");
      window.location.href = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${redirectUri}&client_id=${oidcConfig?.client_id}`;
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
