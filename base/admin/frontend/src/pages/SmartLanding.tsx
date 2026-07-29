import { lazy, Suspense } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../components/auth/useAuth";

const OPS_ROLES = new Set(["admin", "platform_admin", "org_admin"]);
const LazyDashboard = lazy(() => import("./Dashboard"));

export default function SmartLanding() {
  const { user } = useAuth();
  if (user && OPS_ROLES.has(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }
  if (user) {
    return <Navigate to="/account" replace />;
  }
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-gray-100" />}>
      <LazyDashboard />
    </Suspense>
  );
}
