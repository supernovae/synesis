import { lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import PageShell from "./components/layout/PageShell";
import RequireRole from "./components/auth/RequireRole";

const Login = lazy(() => import("./pages/Login"));
const OidcCallback = lazy(() => import("./pages/OidcCallback"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const ApiTokens = lazy(() => import("./pages/account/ApiTokens"));
const Organization = lazy(() => import("./pages/account/Organization"));

const ModelRegistry = lazy(() => import("./pages/models/ModelRegistry"));
const CostTracker = lazy(() => import("./pages/models/CostTracker"));
const ModelPerformance = lazy(() => import("./pages/models/ModelPerformance"));

const CorpusOverview = lazy(() => import("./pages/rag/CorpusOverview"));
const QualityDashboard = lazy(() => import("./pages/rag/QualityDashboard"));
const DomainHealth = lazy(() => import("./pages/rag/DomainHealth"));
const Benchmarks = lazy(() => import("./pages/rag/Benchmarks"));
const ReviewQueue = lazy(() => import("./pages/rag/ReviewQueue"));
const IngestionQueue = lazy(() => import("./pages/rag/IngestionQueue"));

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
const KnowledgeGaps = lazy(() => import("./pages/feedback/KnowledgeGaps"));
const CuratorProposals = lazy(() => import("./pages/feedback/CuratorProposals"));

const ServiceHealth = lazy(() => import("./pages/observability/ServiceHealth"));
const CachePerformance = lazy(() => import("./pages/observability/CachePerformance"));
const CircuitBreakers = lazy(() => import("./pages/observability/CircuitBreakers"));
const ErrorLog = lazy(() => import("./pages/observability/ErrorLog"));
const ErrorDetail = lazy(() => import("./pages/observability/ErrorDetail"));
const RetrievalGaps = lazy(() => import("./pages/observability/KnowledgeGaps"));

const AdminAssistant = lazy(() => import("./pages/assistant/AdminAssistant"));
const SystemConfig = lazy(() => import("./pages/settings/SystemConfig"));
const ProviderKeys = lazy(() => import("./pages/settings/ProviderKeys"));
const InfraCosts = lazy(() => import("./pages/settings/InfraCosts"));
const AuditLog = lazy(() => import("./pages/settings/AuditLog"));

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
      { index: true, element: <Dashboard /> },

      { path: "models", element: <ModelRegistry /> },
      { path: "models/costs", element: <CostTracker /> },
      { path: "models/performance", element: <ModelPerformance /> },

      { path: "rag/corpus", element: <CorpusOverview /> },
      { path: "rag/quality", element: <QualityDashboard /> },
      { path: "rag/quality/:key", element: <DomainHealth /> },
      { path: "rag/benchmarks", element: <Benchmarks /> },
      { path: "rag/review", element: <ReviewQueue /> },
      { path: "rag/ingestion", element: <IngestionQueue /> },

      { path: "taxonomy", element: <DomainBrowser /> },
      { path: "taxonomy/coverage", element: <CoverageMap /> },

      { path: "pipeline/graph", element: <GraphVisualization /> },
      { path: "pipeline/nodes", element: <NodePerformance /> },
      { path: "pipeline/critic", element: <CriticAnalytics /> },
      { path: "pipeline/conflict-groups", element: <ConflictGroups /> },

      { path: "traces", element: <TraceList /> },
      { path: "traces/:traceId", element: <TraceDetail /> },

      { path: "integrations/mcp", element: <McpTools /> },
      { path: "integrations/search", element: <WebSearch /> },

      { path: "feedback", element: <FeedbackList /> },
      { path: "feedback/knowledge-gaps", element: <KnowledgeGaps /> },
      { path: "feedback/curator", element: <CuratorProposals /> },

      { path: "observability/health", element: <ServiceHealth /> },
      { path: "observability/cache", element: <CachePerformance /> },
      { path: "observability/circuit-breakers", element: <CircuitBreakers /> },
      { path: "observability/errors", element: <ErrorLog /> },
      { path: "observability/errors/:failureId", element: <ErrorDetail /> },
      { path: "observability/retrieval-gaps", element: <RetrievalGaps /> },

      { path: "account/tokens", element: <ApiTokens /> },
      { path: "account/organization", element: <Organization /> },

      { path: "assistant", element: <AdminAssistant /> },
      { path: "settings", element: <SystemConfig /> },
      { path: "settings/providers", element: <ProviderKeys /> },
      { path: "settings/infra-costs", element: <InfraCosts /> },
      { path: "settings/audit", element: <AuditLog /> },
    ],
  },
]);
