import { useState, useMemo } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import { useAuth } from "../auth/useAuth";
import {
  LayoutDashboard,
  Layers,
  Database,
  GitBranch,
  Workflow,
  Plug,
  MessageSquare,
  Activity,
  Settings,
  ChevronDown,
  ChevronRight,
  Hexagon,
  PanelLeftClose,
  PanelLeft,
  ScanSearch,
  Shield,
  ShieldCheck,
  Bot,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";

interface NavChild {
  label: string;
  path: string;
}

interface NavItem {
  label: string;
  icon: LucideIcon;
  path?: string;
  children?: NavChild[];
  minRole?: "readonly" | "user" | "org_admin" | "platform_admin";
}

const navigation: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, path: "/dashboard", minRole: "org_admin" },
  {
    label: "Models & Costs",
    icon: Layers,
    minRole: "org_admin",
    children: [
      { label: "Overview", path: "/models/overview" },
      { label: "Registry", path: "/models" },
      { label: "Providers & API keys", path: "/models/providers" },
      { label: "Effective Serving", path: "/models/serving" },
      { label: "Usage & spend", path: "/models/costs" },
      { label: "Policies", path: "/models/policies" },
      { label: "Prompt Library", path: "/models/prompts" },
      { label: "Effort Routing", path: "/models/effort-routing" },
      { label: "Performance", path: "/models/performance" },
    ],
  },
  {
    label: "Governance",
    icon: Shield,
    minRole: "org_admin",
    children: [
      { label: "Overview", path: "/governance" },
      { label: "Constitutions", path: "/governance/constitutions" },
      { label: "Policies", path: "/governance/policies" },
      { label: "Effective Rules", path: "/governance/effective" },
    ],
  },
  {
    label: "Security",
    icon: ShieldCheck,
    minRole: "org_admin",
    children: [
      { label: "Dashboard", path: "/security" },
      { label: "Events", path: "/security/events" },
      { label: "ACL Groups", path: "/security/acl-groups" },
      { label: "ACL Policies", path: "/security/acl-policies" },
      { label: "Effective Permissions", path: "/security/effective-permissions" },
      { label: "Authorization Policy", path: "/security/authz" },
      { label: "FGA Tuples", path: "/security/authz-tuples" },
      { label: "Auth Debugger", path: "/security/authz-checker" },
    ],
  },
  {
    label: "Yarn Fabric",
    icon: Sparkles,
    minRole: "org_admin",
    children: [
      { label: "Overview", path: "/yarn" },
      { label: "Sessions", path: "/yarn/sessions" },
      { label: "Reducers", path: "/yarn/reducers" },
      { label: "Events", path: "/yarn/events" },
      { label: "Performance", path: "/yarn/performance" },
      { label: "Verification", path: "/yarn/verification" },
      { label: "Language Packs", path: "/yarn/language-packs" },
    ],
  },
  {
    label: "RAG Pipeline",
    icon: Database,
    minRole: "org_admin",
    children: [
      { label: "Corpus", path: "/rag/corpus" },
      { label: "Quality", path: "/rag/quality" },
      { label: "Benchmarks", path: "/rag/benchmarks" },
      { label: "Review Queue", path: "/rag/review" },
      { label: "Ingestion Queue", path: "/rag/ingestion" },
      { label: "Ingestion Sources", path: "/rag/ingestion/sources" },
      { label: "Retrieval Gaps", path: "/rag/retrieval-gaps" },
      { label: "Curator", path: "/rag/curator" },
      { label: "Testing Labs", path: "/rag/testing-labs" },
    ],
  },
  {
    label: "Taxonomy",
    icon: GitBranch,
    minRole: "org_admin",
    children: [
      { label: "Domains", path: "/taxonomy" },
      { label: "Coverage", path: "/taxonomy/coverage" },
    ],
  },
  {
    label: "Pipeline",
    icon: Workflow,
    minRole: "org_admin",
    children: [
      { label: "Graph", path: "/pipeline/graph" },
      { label: "Nodes", path: "/pipeline/nodes" },
      { label: "Critic", path: "/pipeline/critic" },
      { label: "Conflict Groups", path: "/pipeline/conflict-groups" },
    ],
  },
  {
    label: "Tracing",
    icon: ScanSearch,
    minRole: "org_admin",
    children: [
      { label: "Activity Log", path: "/traces" },
    ],
  },
  {
    label: "Integrations",
    icon: Plug,
    minRole: "org_admin",
    children: [
      { label: "MCP Tools", path: "/integrations/mcp" },
      { label: "Web Search", path: "/integrations/search" },
    ],
  },
  {
    label: "Feedback",
    icon: MessageSquare,
    minRole: "org_admin",
    children: [
      { label: "Chat Feedback", path: "/feedback" },
    ],
  },
  {
    label: "Observability",
    icon: Activity,
    minRole: "org_admin",
    children: [
      { label: "Health", path: "/observability/health" },
      { label: "Cache", path: "/observability/cache" },
      { label: "Circuit Breakers", path: "/observability/circuit-breakers" },
      { label: "Errors", path: "/observability/errors" },
    ],
  },
  { label: "Admin Assistant", icon: Bot, path: "/assistant/admin", minRole: "org_admin" },
  { label: "Support Assistant", icon: Bot, path: "/assistant/support", minRole: "user" },
  {
    label: "Account",
    icon: User,
    minRole: "user",
    children: [
      { label: "Home", path: "/account" },
      { label: "Usage", path: "/account/usage" },
      { label: "Organization", path: "/account/organization" },
      { label: "API Tokens", path: "/account/tokens" },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    minRole: "org_admin",
    children: [
      { label: "System Config", path: "/settings" },
      { label: "Infrastructure Costs", path: "/settings/infra-costs" },
      { label: "Audit trail", path: "/settings/audit" },
      { label: "API Explorer", path: "/settings/api-docs" },
    ],
  },
];

function roleRank(role?: string): number {
  if (role === "platform_admin" || role === "admin") return 3;
  if (role === "org_admin") return 2;
  if (role === "user") return 1;
  return 0;
}

function requiredRank(minRole?: NavItem["minRole"]): number {
  if (minRole === "platform_admin") return 3;
  if (minRole === "org_admin") return 2;
  if (minRole === "user") return 1;
  return 0;
}

function isGroupActive(children: NavChild[], pathname: string) {
  return children.some(
    (c) => pathname === c.path || pathname.startsWith(c.path + "/"),
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const userRole = user?.role;
  const allowedNavigation = useMemo(
    () => navigation.filter((item) => roleRank(userRole) >= requiredRank(item.minRole)),
    [userRole],
  );
  /** Explicit user toggles; when absent for a label, expansion follows active route (see `expanded`). */
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>({});

  const autoExpanded = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const item of allowedNavigation) {
      if (item.children && isGroupActive(item.children, pathname)) {
        m[item.label] = true;
      }
    }
    return m;
  }, [pathname, allowedNavigation]);

  const expanded = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const item of allowedNavigation) {
      if (!item.children) continue;
      const label = item.label;
      out[label] =
        label in manualExpanded ? manualExpanded[label] : (autoExpanded[label] ?? false);
    }
    return out;
  }, [allowedNavigation, autoExpanded, manualExpanded]);

  function toggle(label: string) {
    setManualExpanded((prev) => {
      const cur =
        label in prev ? prev[label] : (autoExpanded[label] ?? false);
      return { ...prev, [label]: !cur };
    });
  }

  return (
    <aside
      className={clsx(
        "flex h-screen flex-shrink-0 flex-col bg-sidebar text-white transition-all duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-2 overflow-hidden">
          <Hexagon className="h-6 w-6 flex-shrink-0 text-blue-400" />
          {!collapsed && (
            <span className="text-lg font-semibold tracking-tight">
              Synesis
            </span>
          )}
        </div>
        <button
          onClick={onToggle}
          className="rounded p-1 text-slate-400 hover:bg-sidebar-hover hover:text-white"
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {allowedNavigation.map((item) => {
            const Icon = item.icon;

            if (item.path !== undefined && !item.children) {
              return (
                <li key={item.label}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-sidebar-active text-white"
                          : "text-slate-300 hover:bg-sidebar-hover hover:text-white",
                        collapsed && "justify-center px-2",
                      )
                    }
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    {!collapsed && item.label}
                  </NavLink>
                </li>
              );
            }

            const isOpen = expanded[item.label] ?? false;
            const active = item.children
              ? isGroupActive(item.children, pathname)
              : false;

            if (collapsed) {
              return (
                <li key={item.label}>
                  <div
                    title={item.label}
                    className={clsx(
                      "flex items-center justify-center rounded-md px-2 py-2",
                      active ? "text-white" : "text-slate-400",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                </li>
              );
            }

            return (
              <li key={item.label}>
                <button
                  onClick={() => toggle(item.label)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "text-white"
                      : "text-slate-300 hover:bg-sidebar-hover hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>

                {isOpen && item.children && (
                  <ul className="ml-7 mt-0.5 space-y-0.5 border-l border-white/10 pl-3">
                    {item.children.map((child) => (
                      <li key={child.path}>
                        <NavLink
                          to={child.path}
                          end
                          className={({ isActive }) =>
                            clsx(
                              "block rounded-md px-3 py-1.5 text-sm transition-colors",
                              isActive
                                ? "bg-sidebar-active font-medium text-white"
                                : "text-slate-400 hover:bg-sidebar-hover hover:text-white",
                            )
                          }
                        >
                          {child.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 px-3 py-3">
        {!collapsed && (
          <p className="text-xs text-slate-500">Synesis Admin v0.1.0</p>
        )}
      </div>
    </aside>
  );
}
