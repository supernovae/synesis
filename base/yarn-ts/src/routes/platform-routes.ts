import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerClaudeCompatRoutes } from "./claude-compat-routes.js";
import { registerDiagnosticsRoutes } from "./diagnostics-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerModelRoutes } from "./model-routes.js";
import { registerPreferenceRoutes } from "./preference-routes.js";
import { registerResponsesRoutes } from "./responses-routes.js";
import { registerTelemetryRoutes } from "./telemetry-routes.js";
import type { PlatformRouteDependencies } from "./platform-route-support.js";

export type { PlatformRouteDependencies } from "./platform-route-support.js";

export function registerPlatformRoutes(deps: PlatformRouteDependencies): void {
  registerHealthRoutes(deps);
  registerTelemetryRoutes(deps);
  registerDiagnosticsRoutes(deps);
  registerModelRoutes(deps);
  registerResponsesRoutes(deps);
  registerClaudeCompatRoutes(deps);
  registerPreferenceRoutes(deps);
  registerArtifactRoutes(deps);
}
