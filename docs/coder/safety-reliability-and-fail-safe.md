# Safety, Reliability, and Fail-Safe

## Reliability Invariants

- never claim success without a validation signal
- prefer deterministic evidence paths before inferential paths
- bound retries, loops, tokens, and execution budgets
- degrade safely when dependencies fail
- preserve explicit abstain behavior when confidence is insufficient
- never edit a file without a non-stub read of its current content (artifact-truth)
- never finalize based on verification that does not cover the changed files (verification relevance)
- track evidence progression per session; flag retries that repeat a previously-seen failure signature as regression

## Fail-Safe Behavior

When uncertainty or risk rises:

1. require additional evidence
2. constrain output format and suggested actions
3. escalate model tier when justified
4. stop unsafe automation and request human confirmation
5. block writes to files with stale or stub-only reads
6. flag false-green verification and require relevant re-verification before completion

## Safety Boundaries

Hard constraints apply to:

- security-sensitive operations
- compliance controls
- runtime integrity and data-protection boundaries

All other constraints remain guiding unless promoted by policy.
