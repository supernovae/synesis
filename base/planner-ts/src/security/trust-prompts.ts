/**
 * Re-export from @synesis/context-trust shared package.
 * Planner-specific callers continue to import from this path.
 */
import { SANDWICH_REMINDER as _SANDWICH_REMINDER } from "@synesis/context-trust";

export {
  TRUST_POLICY,
  TRUST_POLICY_COMPACT,
  SANDWICH_REMINDER,
  HIGH_STAKES_FLOOR,
  authorityDatamark,
} from "@synesis/context-trust";

/**
 * Legacy XML-style wrappers — retained for planner evidence formatting.
 * New code should prefer TrustPacketV1 JSON envelopes from the shared package.
 */
export function wrapUntrusted(text: string): string {
  return `<context trust="untrusted">\n${text}\n</context>`;
}

export function wrapEvidenceWithSandwich(evidenceBody: string): string {
  return `${wrapUntrusted(evidenceBody)}\n${_SANDWICH_REMINDER}`;
}
