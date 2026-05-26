import type { RequestDiagnostic } from "./request-diagnostics.js";
import {
  normalizeProviderUsage,
  type NormalizedProviderUsage,
  type NormalizeProviderUsageOptions,
} from "./usage-normalization.js";

export function createDiagnosticPusher(
  diagnosticRegistry: { push(diagnostic: RequestDiagnostic): void },
): (diagnostic: RequestDiagnostic) => void {
  return (diagnostic) => {
    diagnosticRegistry.push(diagnostic);
  };
}

export function createProviderUsageReader(
  options: NormalizeProviderUsageOptions,
): (input: unknown) => NormalizedProviderUsage {
  return (input) => normalizeProviderUsage(input, options);
}
