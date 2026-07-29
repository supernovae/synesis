import { useLocation, Link } from "react-router";
import { useAuth } from "../auth/useAuth";
import { LogOut, Shield, Eye, Moon, Sun, Key, Building2, Menu } from "lucide-react";
import { useState, useEffect } from "react";

const breadcrumbLabels: Record<string, string> = {
  "": "Dashboard",
  models: "Models & Pricing",
  overview: "Overview",
  costs: "Usage Pricing",
  performance: "Performance",
  providers: "Providers",
  policies: "Model Policies",
  rag: "RAG Pipeline",
  corpus: "Corpus",
  quality: "Quality",
  benchmarks: "Benchmarks",
  review: "Review Queue",
  ingestion: "Ingestion Queue",
  sources: "Ingestion Sources",
  "content-packs": "Content Packs",
  "retrieval-gaps": "Retrieval Gaps",
  curator: "Curator",
  "testing-labs": "Testing Labs",
  taxonomy: "Taxonomy",
  coverage: "Coverage",
  pipeline: "Chat pipeline",
  graph: "Graph",
  nodes: "Nodes",
  critic: "Critic",
  "conflict-groups": "Conflict Groups",
  traces: "Activity Log",
  integrations: "Integrations",
  mcp: "MCP Tools",
  search: "Web Search",
  feedback: "Chat Feedback",
  observability: "Observability",
  health: "Health",
  cache: "Cache",
  "circuit-breakers": "Circuit Breakers",
  errors: "Errors",
  governance: "Governance",
  constitutions: "Constitutions",
  effective: "Effective Rules",
  yarn: "Coder",
  sessions: "Sessions",
  events: "Events",
  verification: "Verification",
  "transition-calibration": "Transition Calibration",
  "language-packs": "Language Packs",
  authz: "Authorization Policy",
  "authz-tuples": "FGA Tuples",
  "authz-checker": "Auth Debugger",
  settings: "Settings",
  "capability-matrix": "Capability Matrix",
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
  if (prevSeg === "constitutions" && isLikelyIdSegment(seg)) return "Constitution detail";
  return breadcrumbLabels[seg] || seg;
}

interface TopBarProps {
  onMobileMenuToggle: () => void;
}

export default function TopBar({ onMobileMenuToggle }: TopBarProps) {
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
    <header className="flex h-14 items-center justify-between border-b border-line bg-surface-card px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onMobileMenuToggle}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary md:hidden"
          aria-label="Toggle navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        <nav className="scrollbar-none flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
          <Link
            to="/"
            className="shrink-0 text-fg-tertiary hover:text-fg-primary"
          >
            Home
          </Link>
          {crumbs.map((c) => (
            <span key={c.path} className="flex shrink-0 items-center gap-1">
              <span className="text-fg-tertiary">/</span>
              <Link
                to={c.path}
                className="text-fg-secondary hover:text-fg-primary"
              >
                {c.label}
              </Link>
            </span>
          ))}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        <button
          onClick={() => setDark((d) => !d)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary"
          title={dark ? "Light mode" : "Dark mode"}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {user && (
          <div className="flex items-center gap-1 md:gap-2">
            {user.role === "admin" || user.role === "platform_admin" || user.role === "org_admin" ? (
              <Shield className="hidden h-4 w-4 text-blue-500 md:block" />
            ) : (
              <Eye className="hidden h-4 w-4 text-fg-tertiary md:block" />
            )}
            <Link
              to="/account"
              className="hidden text-sm font-medium text-fg-primary hover:text-accent md:block"
            >
              {user.username}
            </Link>
            {user.org_name && (
              <Link
                to="/account/organization"
                className="hidden items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50 md:flex"
              >
                <Building2 className="h-3 w-3" />
                {user.org_name}
              </Link>
            )}
            <span className="hidden rounded-full bg-surface-hover px-2 py-0.5 text-xs font-medium text-fg-secondary md:inline">
              {user.role}
            </span>
            <Link
              to="/account/tokens"
              className="hidden min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary md:inline-flex"
              title="API Tokens"
            >
              <Key className="h-4 w-4" />
            </Link>
          </div>
        )}
        <button
          onClick={logout}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
