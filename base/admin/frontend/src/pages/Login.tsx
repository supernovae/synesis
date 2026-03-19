import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../components/auth/AuthProvider";
import { Hexagon, Shield } from "lucide-react";

export default function Login() {
  const { login, loginWithOidc, oidcConfig, loading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const oidcEnabled = oidcConfig?.enabled ?? false;

  useEffect(() => {
    if (!loading && oidcEnabled && !isAuthenticated) {
      loginWithOidc();
    }
  }, [loading, oidcEnabled, isAuthenticated, loginWithOidc]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch {
      setError("Invalid credentials");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || oidcEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900">
        <div className="flex flex-col items-center gap-4">
          <Hexagon className="h-12 w-12 animate-pulse text-blue-500" />
          <div className="text-slate-400">
            {oidcEnabled ? "Redirecting to Keycloak..." : "Loading..."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Hexagon className="mx-auto h-12 w-12 text-blue-500" />
          <h1 className="mt-4 text-2xl font-bold text-white">Synesis Admin</h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to your account
          </p>
        </div>

        <div className="space-y-4 rounded-lg bg-white p-6 shadow-xl">
          {error && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
