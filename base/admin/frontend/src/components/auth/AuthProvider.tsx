import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import axios from "axios";
import type { User, AuthResponse } from "../../types";

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAdmin: boolean;
  isAuthenticated: boolean;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState(loadPersistedAuth);

  const login = useCallback(async (username: string, password: string) => {
    const { data } = await axios.post<AuthResponse>("/api/v1/auth/login", {
      username,
      password,
    });
    localStorage.setItem("synesis_token", data.access_token);
    localStorage.setItem("synesis_user", JSON.stringify(data.user));
    setAuth({ user: data.user, token: data.access_token });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("synesis_token");
    localStorage.removeItem("synesis_user");
    setAuth({ user: null, token: null });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: auth.user,
        token: auth.token,
        login,
        logout,
        isAdmin: auth.user?.role === "admin",
        isAuthenticated: !!auth.token,
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
