import { useState, Suspense } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import ErrorBoundary from "../common/ErrorBoundary";
import { useAdminSSE } from "../../api/useAdminSSE";

export default function PageShell() {
  const [collapsed, setCollapsed] = useState(false);
  useAdminSSE();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-6 dark:bg-gray-950">
          <ErrorBoundary>
            <Suspense
              fallback={
                <div className="flex h-64 items-center justify-center text-sm text-gray-400">
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
