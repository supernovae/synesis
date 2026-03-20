import { createContext } from "react";
import type { User, OidcConfig } from "../../types";

export interface AuthContextType {
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

export const AuthContext = createContext<AuthContextType | null>(null);
