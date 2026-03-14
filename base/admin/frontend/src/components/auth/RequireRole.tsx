import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  role?: "admin" | "readonly";
}

export default function RequireRole({ children, role }: Props) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
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
