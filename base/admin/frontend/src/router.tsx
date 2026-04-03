import { lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import PageShell from "./components/layout/PageShell";
import RequireRole from "./components/auth/RequireRole";

const Login = lazy(() => import("./pages/Login"));
const OidcCallback = lazy(() => import("./pages/OidcCallback"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SmartLanding = lazy(() => import("./pages/SmartLanding"));
const AccountHome = lazy(() => import("./pages/account/AccountHome"));
const ApiTokens = lazy(() => import("./pages/account/ApiTokens"));
const Organization = lazy(() => import("./pages/account/Organization"));
const AccountUsage = lazy(() => import("./pages/account/Usage"));

const ModelRegistry = lazy(() => import("./pages/models/ModelRegistry"));
const ModelsCostsOverview = lazy(() => import("./pages/models/ModelsCostsOverview"));
const CostTracker = lazy(() => import("./pages/models/CostTracker"));
const ModelPerformance = lazy(() => import("./pages/models/ModelPerformance"));
const ProviderManagement = lazy(() => import("./pages/models/ProviderManagement"));
const ServingManagement = lazy(() => import("./pages/models/ServingManagement"));
const ModelPolicies = lazy(() => import("./pages/models/ModelPolicies"));
const EffortRoutingPreview = lazy(() => import("./pages/models/EffortRoutingPreview"));
const PromptLibrary = lazy(() => import("./pages/models/PromptLibrary"));

const CorpusOverview = lazy(() => import("./pages/rag/CorpusOverview"));
const QualityDashboard = lazy(() => import("./pages/rag/QualityDashboard"));
const DomainHealth = lazy(() => import("./pages/rag/DomainHealth"));
const Benchmarks = lazy(() => import("./pages/rag/Benchmarks"));
const ReviewQueue = lazy(() => import("./pages/rag/ReviewQueue"));
const IngestionQueue = lazy(() => import("./pages/rag/IngestionQueue"));
const IngestionSources = lazy(() => import("./pages/rag/IngestionSources"));
const RetrievalGaps = lazy(() => import("./pages/rag/RetrievalGaps"));
const CuratorProposals = lazy(() => import("./pages/rag/CuratorProposals"));
const TestingLabs = lazy(() => import("./pages/rag/TestingLabs"));

const DomainBrowser = lazy(() => import("./pages/taxonomy/DomainBrowser"));
const CoverageMap = lazy(() => import("./pages/taxonomy/CoverageMap"));

const GraphVisualization = lazy(() => import("./pages/pipeline/GraphVisualization"));
const NodePerformance = lazy(() => import("./pages/pipeline/NodePerformance"));
const CriticAnalytics = lazy(() => import("./pages/pipeline/CriticAnalytics"));
const ConflictGroups = lazy(() => import("./pages/pipeline/ConflictGroups"));

const TraceList = lazy(() => import("./pages/traces/TraceList"));
const TraceDetail = lazy(() => import("./pages/traces/TraceDetail"));

const McpTools = lazy(() => import("./pages/integrations/McpTools"));
const WebSearch = lazy(() => import("./pages/integrations/WebSearch"));

const FeedbackList = lazy(() => import("./pages/feedback/FeedbackList"));

const ServiceHealth = lazy(() => import("./pages/observability/ServiceHealth"));
const CachePerformance = lazy(() => import("./pages/observability/CachePerformance"));
const CircuitBreakers = lazy(() => import("./pages/observability/CircuitBreakers"));
const ErrorLog = lazy(() => import("./pages/observability/ErrorLog"));
const ErrorDetail = lazy(() => import("./pages/observability/ErrorDetail"));

const AdminAssistant = lazy(() => import("./pages/assistant/AdminAssistant"));
const SupportAssistant = lazy(() => import("./pages/assistant/SupportAssistant"));
const SystemConfig = lazy(() => import("./pages/settings/SystemConfig"));
const InfraCosts = lazy(() => import("./pages/settings/InfraCosts"));
const AuditLog = lazy(() => import("./pages/settings/AuditLog"));
const ApiExplorer = lazy(() => import("./pages/settings/ApiExplorer"));

const SecurityDashboard = lazy(() => import("./pages/security/SecurityDashboard"));
const SecurityEvents = lazy(() => import("./pages/security/SecurityEvents"));
const AclGroups = lazy(() => import("./pages/security/AclGroups"));
const AclPolicies = lazy(() => import("./pages/security/AclPolicies"));
const EffectivePermissions = lazy(() => import("./pages/security/EffectivePermissions"));
const AuthzDashboard = lazy(() => import("./pages/security/AuthzDashboard"));
const AuthzTuples = lazy(() => import("./pages/security/AuthzTuples"));
const AuthzChecker = lazy(() => import("./pages/security/AuthzChecker"));

const GovernanceOverview = lazy(() => import("./pages/governance/GovernanceOverview"));
const ConstitutionList = lazy(() => import("./pages/governance/ConstitutionList"));
const ConstitutionDetail = lazy(() => import("./pages/governance/ConstitutionDetail"));
const PolicyList = lazy(() => import("./pages/governance/PolicyList"));
const EffectiveView = lazy(() => import("./pages/governance/EffectiveView"));

const YarnOverview = lazy(() => import("./pages/yarn/YarnOverview"));
const YarnSessions = lazy(() => import("./pages/yarn/YarnSessions"));
const YarnSessionDetail = lazy(() => import("./pages/yarn/YarnSessionDetail"));
const YarnReducers = lazy(() => import("./pages/yarn/YarnReducers"));
const YarnEvents = lazy(() => import("./pages/yarn/YarnEvents"));
const YarnPerformance = lazy(() => import("./pages/yarn/YarnPerformance"));
const YarnVerification = lazy(() => import("./pages/yarn/YarnVerification"));
const LanguagePacks = lazy(() => import("./pages/yarn/LanguagePacks"));

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <Login />,
  },
  {
    path: "/callback",
    element: <OidcCallback />,
  },
  {
    element: (
      <RequireRole>
        <PageShell />
      </RequireRole>
    ),
    children: [
      { index: true, element: <SmartLanding /> },
      { path: "dashboard", element: <Dashboard /> },

      { path: "models", element: <ModelRegistry /> },
      { path: "models/overview", element: <ModelsCostsOverview /> },
      { path: "models/costs", element: <CostTracker /> },
      { path: "models/performance", element: <ModelPerformance /> },
      { path: "models/providers", element: <ProviderManagement /> },
      { path: "models/serving", element: <ServingManagement /> },
      { path: "models/policies", element: <ModelPolicies /> },
      { path: "models/effort-routing", element: <EffortRoutingPreview /> },
      { path: "models/prompts", element: <PromptLibrary /> },

      { path: "rag/corpus", element: <CorpusOverview /> },
      { path: "rag/quality", element: <QualityDashboard /> },
      { path: "rag/quality/:key", element: <DomainHealth /> },
      { path: "rag/benchmarks", element: <Benchmarks /> },
      { path: "rag/review", element: <ReviewQueue /> },
      { path: "rag/ingestion", element: <IngestionQueue /> },
      { path: "rag/ingestion/sources", element: <IngestionSources /> },
      { path: "rag/retrieval-gaps", element: <RetrievalGaps /> },
      { path: "rag/curator", element: <CuratorProposals /> },
      { path: "rag/testing-labs", element: <TestingLabs /> },

      { path: "taxonomy", element: <DomainBrowser /> },
      { path: "taxonomy/coverage", element: <CoverageMap /> },

      { path: "pipeline/graph", element: <GraphVisualization /> },
      { path: "pipeline/nodes", element: <NodePerformance /> },
      { path: "pipeline/critic", element: <CriticAnalytics /> },
      { path: "pipeline/conflict-groups", element: <ConflictGroups /> },

      {
        path: "traces",
        element: (
          <RequireRole role="admin">
            <TraceList />
          </RequireRole>
        ),
      },
      {
        path: "traces/:traceId",
        element: (
          <RequireRole role="admin">
            <TraceDetail />
          </RequireRole>
        ),
      },

      { path: "integrations/mcp", element: <McpTools /> },
      { path: "integrations/search", element: <WebSearch /> },

      { path: "feedback", element: <FeedbackList /> },

      { path: "observability/health", element: <ServiceHealth /> },
      { path: "observability/cache", element: <CachePerformance /> },
      { path: "observability/circuit-breakers", element: <CircuitBreakers /> },
      { path: "observability/errors", element: <ErrorLog /> },
      { path: "observability/errors/:failureId", element: <ErrorDetail /> },

      { path: "security", element: <SecurityDashboard /> },
      { path: "security/events", element: <SecurityEvents /> },
      { path: "security/acl-groups", element: <AclGroups /> },
      { path: "security/acl-policies", element: <AclPolicies /> },
      { path: "security/effective-permissions", element: <EffectivePermissions /> },
      { path: "security/authz", element: <AuthzDashboard /> },
      { path: "security/authz-tuples", element: <AuthzTuples /> },
      { path: "security/authz-checker", element: <AuthzChecker /> },

      { path: "governance", element: <GovernanceOverview /> },
      { path: "governance/constitutions", element: <ConstitutionList /> },
      { path: "governance/constitutions/:constitutionId", element: <ConstitutionDetail /> },
      { path: "governance/policies", element: <PolicyList /> },
      { path: "governance/effective", element: <EffectiveView /> },

      { path: "yarn", element: <YarnOverview /> },
      { path: "yarn/sessions", element: <YarnSessions /> },
      { path: "yarn/sessions/:sessionKey", element: <YarnSessionDetail /> },
      { path: "yarn/reducers", element: <YarnReducers /> },
      { path: "yarn/events", element: <YarnEvents /> },
      { path: "yarn/performance", element: <YarnPerformance /> },
      { path: "yarn/verification", element: <YarnVerification /> },
      { path: "yarn/language-packs", element: <LanguagePacks /> },

      { path: "account", element: <AccountHome /> },
      { path: "account/tokens", element: <ApiTokens /> },
      { path: "account/usage", element: <AccountUsage /> },
      { path: "account/organization", element: <Organization /> },

      {
        path: "assistant/admin",
        element: (
          <RequireRole role="admin">
            <AdminAssistant />
          </RequireRole>
        ),
      },
      { path: "assistant/support", element: <SupportAssistant /> },
      { path: "assistant", element: <Navigate to="/assistant/support" replace /> },
      { path: "settings", element: <SystemConfig /> },
      {
        path: "settings/provider-keys",
        element: <Navigate to="/models/providers#provider-api-keys" replace />,
      },
      { path: "settings/infra-costs", element: <InfraCosts /> },
      { path: "settings/audit", element: <AuditLog /> },
      { path: "settings/api-docs", element: <ApiExplorer /> },
    ],
  },
]);
