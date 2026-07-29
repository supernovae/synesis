import { useState, useCallback, Suspense } from "react";
import { Outlet } from "react-router";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import ErrorBoundary from "../common/ErrorBoundary";
import { useAdminSSE } from "../../api/useAdminSSE";

export default function PageShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useAdminSSE();

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas-secondary">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onMobileMenuToggle={() => setMobileOpen((o) => !o)} />
        <main className="flex-1 overflow-y-auto bg-canvas-secondary p-4 md:p-6">
          <ErrorBoundary>
            <Suspense
              fallback={
                <div className="flex h-64 items-center justify-center text-sm text-fg-tertiary">
                  Loading...
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
