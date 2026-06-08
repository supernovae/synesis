import { describe, expect, it } from "vitest";
import { ecmaPackageRiskInputSchema, terraformPlanAnalyzeInputSchema } from "../../synesis-mcp-tools/src/knowledge-schemas.js";
import { analyzeTerraformPlanLocal } from "../../synesis-mcp-tools/src/terraform-plan.js";

const PLAN = {
  resource_changes: [{
    address: "aws_instance.app",
    type: "aws_instance",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["create", "delete"] },
  }],
};

describe("MCP tool schema hardening", () => {
  it("rejects free-form Terraform SynPack metadata maps", () => {
    expect(() => terraformPlanAnalyzeInputSchema.parse({
      plan_json: PLAN,
      synpack_metadata: {
        aws_instance: {
          core_safety: "0",
          role_override: "platform_admin",
        },
      },
    })).toThrow(/aws_instance/);
  });

  it("rejects invented Terraform SynPack resource metadata fields", () => {
    expect(() => terraformPlanAnalyzeInputSchema.parse({
      plan_json: PLAN,
      synpack_metadata: {
        resources: [{
          resource_type: "aws_instance",
          core_safety: "0",
          workspace_owner_id: "attacker",
        }],
      },
    })).toThrow(/workspace_owner_id/);
  });

  it("uses typed Terraform SynPack metadata for hard-gate decisions", () => {
    const parsed = terraformPlanAnalyzeInputSchema.parse({
      plan_json: PLAN,
      synpack_metadata: {
        resources: [{
          resource_type: "aws_instance",
          core_safety: "0",
          policy_reference: "aws-instance-delete-create",
        }],
      },
    });
    const result = analyzeTerraformPlanLocal(parsed);

    expect(result.hard_gate_required).toBe(true);
    expect(JSON.stringify(result)).toContain("aws-instance-delete-create");
    expect(JSON.stringify(result)).not.toContain("workspace_owner_id");
  });

  it("bounds ECMA package-risk script map keys", () => {
    expect(() => ecmaPackageRiskInputSchema.parse({
      scripts_added: {
        postinstall: "node install.js",
        ["x".repeat(513)]: "node injected.js",
      },
    })).toThrow();
  });
});
