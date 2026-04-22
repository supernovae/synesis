import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../components/auth/useAuth";
import { Hexagon, Shield } from "lucide-react";

const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";

export default function Login() {
  const { loginWithOidc, oidcConfig, loading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname: string } })?.from?.pathname ?? "/";

  /** After logout or a failed OIDC flow, require a click so we do not SSO-loop with Keycloak. */
  const [oidcManual, setOidcManual] = useState(() => {
    if (sessionStorage.getItem("synesis_post_logout") === "1") {
      sessionStorage.removeItem("synesis_post_logout");
      sessionStorage.setItem(SUPPRESS_AUTO_KEY, "1");
      return true;
    }
    return sessionStorage.getItem(SUPPRESS_AUTO_KEY) === "1";
  });

  const oidcEnabled = oidcConfig?.enabled ?? false;

  useEffect(() => {
    if (loading || !oidcEnabled || isAuthenticated) {
      return;
    }
    if (sessionStorage.getItem(SUPPRESS_AUTO_KEY) === "1") {
      return;
    }
    loginWithOidc();
  }, [loading, oidcEnabled, isAuthenticated, loginWithOidc]);

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [loading, isAuthenticated, from, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900">
        <div className="flex flex-col items-center gap-4">
          <Hexagon className="h-12 w-12 animate-pulse text-blue-500" />
          <div className="text-slate-400">Loading...</div>
        </div>
      </div>
    );
  }

  if (oidcEnabled && oidcManual) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm rounded-lg bg-white p-8 text-center shadow-xl">
          <Shield className="mx-auto h-10 w-10 text-blue-600" />
          <h1 className="mt-4 text-lg font-semibold text-slate-900">
            Sign in with Keycloak (synesis realm)
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            You are signed out of Synesis Admin. Continue to Keycloak to sign in
            again. (Automatic redirect is skipped after logout so your session does
            not immediately restart.)
          </p>
          <button
            type="button"
            className="mt-6 w-full rounded-md bg-slate-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-900"
            onClick={() => {
              sessionStorage.removeItem(SUPPRESS_AUTO_KEY);
              setOidcManual(false);
              loginWithOidc();
            }}
          >
            Continue to Keycloak sign-in
          </button>
        </div>
      </div>
    );
  }

  if (oidcEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900">
        <div className="flex flex-col items-center gap-4">
          <Hexagon className="h-12 w-12 animate-pulse text-blue-500" />
          <div className="text-slate-400">Redirecting to Keycloak (synesis realm)...</div>
        </div>
      </div>
    );
  }

  return <KeycloakRequired />;
}

function KeycloakRequired() {
  const body: ReactNode = (
    <>
      <p className="mt-2 text-sm text-slate-600">
        Synesis Admin does not use a built-in username/password. Set{" "}
        <code className="rounded bg-slate-100 px-1 text-xs">SYNESIS_KEYCLOAK_ISSUER_URL</code>{" "}
        on the admin API so the UI can use OpenID Connect (Keycloak).
      </p>
      <p className="mt-3 text-sm text-slate-600">
        For scripts, use a <strong>Personal Access Token</strong> (<code className="text-xs">syn-...</code>)
        or a Keycloak access token as{" "}
        <code className="rounded bg-slate-100 px-1 text-xs">Authorization: Bearer</code>.
      </p>
      <p className="mt-3 text-sm text-slate-500">
        Repository doc:{" "}
        <code className="text-xs">docs/admin/KEYCLOAK_BOOTSTRAP.md</code>
      </p>
    </>
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-xl">
        <Hexagon className="mx-auto h-10 w-10 text-blue-600" />
        <h1 className="mt-4 text-center text-lg font-semibold text-slate-900">
          Keycloak required
        </h1>
        {body}
      </div>
    </div>
  );
}
