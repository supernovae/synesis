import { useLocation, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { LogOut, Shield, Eye, Moon, Sun, Key, Building2 } from "lucide-react";
import { useState, useEffect } from "react";

const breadcrumbLabels: Record<string, string> = {
  "": "Dashboard",
  models: "Models & Costs",
  overview: "Overview",
  costs: "Usage & spend",
  reconcile: "Reconciliation",
  performance: "Performance",
  providers: "Providers",
  serving: "Effective Serving",
  policies: "Model Policies",
  rag: "RAG Pipeline",
  corpus: "Corpus",
  quality: "Quality",
  benchmarks: "Benchmarks",
  review: "Review Queue",
  ingestion: "Ingestion Queue",
  sources: "Ingestion Sources",
  "retrieval-gaps": "Retrieval Gaps",
  curator: "Curator",
  "testing-labs": "Testing Labs",
  taxonomy: "Taxonomy",
  coverage: "Coverage",
  pipeline: "Pipeline",
  graph: "Graph",
  nodes: "Nodes",
  critic: "Critic",
  "conflict-groups": "Conflict Groups",
  traces: "Activity Log",
  integrations: "Integrations",
  mcp: "MCP Tools",
  search: "Web Search",
  feedback: "Feedback",
  observability: "Observability",
  health: "Health",
  cache: "Cache",
  "circuit-breakers": "Circuit Breakers",
  errors: "Errors",
  yarn: "Yarn Fabric",
  sessions: "Sessions",
  events: "Events",
  verification: "Verification",
  authz: "Authorization Policy",
  "authz-tuples": "FGA Tuples",
  "authz-checker": "Auth Debugger",
  settings: "Settings",
  "infra-costs": "Infrastructure Costs",
  audit: "Audit trail",
  assistant: "Assistant",
  account: "Account",
  tokens: "API Tokens",
  organization: "Organization",
};

function isLikelyIdSegment(seg: string): boolean {
  return seg.length >= 20 && /^[a-f0-9-]+$/i.test(seg);
}

function breadcrumbSegmentLabel(seg: string, prevSeg: string | undefined): string {
  if (prevSeg === "traces" && isLikelyIdSegment(seg)) return "Trace detail";
  if (prevSeg === "errors" && isLikelyIdSegment(seg)) return "Failure detail";
  if (prevSeg === "quality" && seg.length > 0 && !breadcrumbLabels[seg]) return "Domain";
  if (prevSeg === "sessions" && seg.length > 0) return "Session detail";
  return breadcrumbLabels[seg] || seg;
}

export default function TopBar() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [dark, setDark] = useState(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.classList.contains("dark");
    }
    return false;
  });

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    localStorage.setItem("synesis_dark", dark ? "1" : "0");
  }, [dark]);

  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    label: breadcrumbSegmentLabel(seg, i > 0 ? segments[i - 1] : undefined),
    path: "/" + segments.slice(0, i + 1).join("/"),
  }));

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6 dark:border-gray-700 dark:bg-gray-900">
      <nav className="flex items-center gap-1 text-sm">
        <Link
          to="/"
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Home
        </Link>
        {crumbs.map((c) => (
          <span key={c.path} className="flex items-center gap-1">
            <span className="text-gray-300 dark:text-gray-600">/</span>
            <Link
              to={c.path}
              className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            >
              {c.label}
            </Link>
          </span>
        ))}
      </nav>

      <div className="flex items-center gap-3">
        <button
          onClick={() => setDark((d) => !d)}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          title={dark ? "Light mode" : "Dark mode"}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {user && (
          <div className="flex items-center gap-2">
            {user.role === "admin" || user.role === "platform_admin" || user.role === "org_admin" ? (
              <Shield className="h-4 w-4 text-blue-500" />
            ) : (
              <Eye className="h-4 w-4 text-gray-400" />
            )}
            <Link
              to="/account"
              className="text-sm font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            >
              {user.username}
            </Link>
            {user.org_name && (
              <Link
                to="/account/organization"
                className="flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
              >
                <Building2 className="h-3 w-3" />
                {user.org_name}
              </Link>
            )}
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {user.role}
            </span>
            <Link
              to="/account/tokens"
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
              title="API Tokens"
            >
              <Key className="h-4 w-4" />
            </Link>
          </div>
        )}
        <button
          onClick={logout}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
