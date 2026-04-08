import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const SUPPRESS_AUTO_KEY = "synesis_oidc_suppress_auto";

interface Props {
  children: ReactNode;
  role?: "admin" | "readonly";
}

export default function RequireRole({ children, role }: Props) {
  const { isAuthenticated, user, oidcConfig, loginWithOidc, loading } = useAuth();
  const location = useLocation();
  const redirecting = useRef(false);

  const oidcEnabled = oidcConfig?.enabled ?? false;
  const suppressAutoOidc = sessionStorage.getItem(SUPPRESS_AUTO_KEY) === "1";

  useEffect(() => {
    if (
      !loading &&
      !isAuthenticated &&
      oidcEnabled &&
      !suppressAutoOidc &&
      !redirecting.current
    ) {
      redirecting.current = true;
      const current = location.pathname + location.search;
      if (current && current !== "/login" && current !== "/callback") {
        sessionStorage.setItem("synesis_return_to", current);
      }
      loginWithOidc();
    }
  }, [loading, isAuthenticated, oidcEnabled, suppressAutoOidc, loginWithOidc, location]);

  if (loading) {
    return null;
  }

  if (!isAuthenticated) {
    if (oidcEnabled) {
      if (suppressAutoOidc) {
        return <Navigate to="/login" state={{ from: location }} replace />;
      }
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-900">
          <p className="text-slate-400">Redirecting to sign-in…</p>
        </div>
      );
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (
    role === "admin" &&
    user?.role !== "admin" &&
    user?.role !== "platform_admin" &&
    user?.role !== "org_admin"
  ) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900">
            Access Denied
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            This page requires admin privileges.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
