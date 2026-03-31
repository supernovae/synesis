# Safety, Reliability, and Fail-Safe

## Reliability Invariants

- never claim success without a validation signal
- prefer deterministic evidence paths before inferential paths
- bound retries, loops, tokens, and execution budgets
- degrade safely when dependencies fail
- preserve explicit abstain behavior when confidence is insufficient

## Fail-Safe Behavior

When uncertainty or risk rises:

1. require additional evidence
2. constrain output format and suggested actions
3. escalate model tier when justified
4. stop unsafe automation and request human confirmation

## Safety Boundaries

Hard constraints apply to:

- security-sensitive operations
- compliance controls
- runtime integrity and data-protection boundaries

All other constraints remain guiding unless promoted by policy.
