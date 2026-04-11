# Migration Map From Milestones

## Milestone to Feature Mapping

- **M1 + M2 + M8** -> Deterministic Diagnostic Pipeline
- **M3** -> Working Frame and Project Constraints Engine
- **M4** -> Constraint Policy Engine
- **M5** -> Adaptive Tier Orchestrator
- **M6 + M9 + safety components from M11** -> Reliability, Telemetry, and Live Verification
- **M7** -> Client/Adapter Compatibility Layer
- **M10 + intentional recall theory from WIP M11** -> Intentional Recall and Constrained Composition

## Source Documents

All milestone markdown now lives in **`docs/development/`** (see [development README](../development/README.md#milestone-program-m1m11)):

- [VALIDATION_NORMALIZATION_M1.md](../development/VALIDATION_NORMALIZATION_M1.md)
- [TOOL_RESULT_REDUCTION_M2.md](../development/TOOL_RESULT_REDUCTION_M2.md)
- [WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md](../development/WORKING_FRAME_AND_PROJECT_MANIFEST_M3.md)
- [DETERMINISTIC_POLICY_ENGINE_M4.md](../development/DETERMINISTIC_POLICY_ENGINE_M4.md)
- [PHASE_MODEL_ORCHESTRATOR_M5.md](../development/PHASE_MODEL_ORCHESTRATOR_M5.md)
- [SESSION_INTELLIGENCE_DASHBOARD_M6.md](../development/SESSION_INTELLIGENCE_DASHBOARD_M6.md)
- [CLIENT_ADAPTER_PACKS_M7.md](../development/CLIENT_ADAPTER_PACKS_M7.md)
- [REDUCER_REGISTRY_M8.md](../development/REDUCER_REGISTRY_M8.md)
- [LIVE_VERIFICATION_M9.md](../development/LIVE_VERIFICATION_M9.md)
- [CONTEXT_OPTIMIZATION_M10.md](../development/CONTEXT_OPTIMIZATION_M10.md)
- [SAFETY_HARDENING_M11.md](../development/SAFETY_HARDENING_M11.md)

## Migration Strategy

1. Keep milestone docs as historical references under `docs/development/`.
2. Treat `docs/coder` as the canonical forward-looking architecture.
3. Add backlinks from milestone docs to the new feature docs over time.
4. Deprecate milestone-first navigation after consumers are moved.
