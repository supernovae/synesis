export const CAPABILITY_LOCK = Object.freeze({
  antiOscillation: true,
  routerGovernedEvidence: true,
  structuredRepairDeterministicFirst: true,
  decisionLedgerAppendOnly: true,
  critiqueLifecycleMonotonic: true,
  securityBoundaryStrict: true,
  clientNeutralPolicy: true
});

export type CapabilityLockKey = keyof typeof CAPABILITY_LOCK;

export function assertCapabilityLock(): void {
  const disabled = Object.entries(CAPABILITY_LOCK)
    .filter(([, enabled]) => enabled !== true)
    .map(([name]) => name);
  if (disabled.length > 0) {
    throw new Error(`Capability lock violation: ${disabled.join(", ")}`);
  }
}
