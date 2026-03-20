import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  role?: "admin" | "readonly";
}

export default function RequireRole({ children, role }: Props) {
  const { isAuthenticated, user, oidcConfig, loginWithOidc, loading } = useAuth();
  const location = useLocation();
  const redirecting = useRef(false);

  const oidcEnabled = oidcConfig?.enabled ?? false;

  useEffect(() => {
    if (!loading && !isAuthenticated && oidcEnabled && !redirecting.current) {
      redirecting.current = true;
      loginWithOidc();
    }
  }, [loading, isAuthenticated, oidcEnabled, loginWithOidc]);

  if (loading) {
    return null;
  }

  if (!isAuthenticated) {
    if (oidcEnabled) {
      return null;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (role === "admin" && user?.role !== "admin") {
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
