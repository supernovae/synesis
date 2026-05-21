import {
  MASTER_HARNESS_POLICY_SCHEMA_VERSION,
  MasterHarnessPolicyV1Schema,
  type MasterHarnessPolicyV1,
} from "./types.js";

export const DEFAULT_MASTER_HARNESS_POLICY: MasterHarnessPolicyV1 =
  MasterHarnessPolicyV1Schema.parse({
    schema_version: MASTER_HARNESS_POLICY_SCHEMA_VERSION,
    id: "synesis-master-default",
    mode: "shadow",
    token_budget: {
      ceiling_tokens: 500_000,
      output_reserve_tokens: 10_000,
      soft_ratio: 0.85,
      heavy_ratio: 0.95,
      emergency_ratio: 0.97,
      hard_ratio: 0.99,
    },
    safety: {
      block_dangerous_shell: true,
      enforce_path_sandbox: true,
      block_parent_path_traversal: true,
      block_write_capable_tools: false,
    },
    tracing: {
      emit_harness_decision_event: true,
      include_raw_rules: true,
    },
  });

export function parseMasterHarnessPolicy(value: unknown): MasterHarnessPolicyV1 {
  return MasterHarnessPolicyV1Schema.parse(value);
}
