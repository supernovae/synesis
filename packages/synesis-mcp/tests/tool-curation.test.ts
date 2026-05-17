import { describe, it, expect } from "vitest";
import type { SynesisMcpAuth, SynesisMcpDeps } from "@synesis/mcp-tools";
import { registerSynesisMcpTools } from "@synesis/mcp-tools";

const CORE_TOOLS = [
  "synesis_search",
  "synesis_resolve_pack",
  "synesis_context_bundle",
  "synesis_web_search",
  "synesis_code_search",
  "synesis_docs_search",
  "synesis_patch_integrity",
];

const EXTENDED_TOOLS = [
  "synesis_config_search",
  "synesis_classify",
  "synesis_plan",
  "synesis_critique",
  "synesis_terraform_plan_analyze",
  "synesis_ecma_environment_check",
  "synesis_ecma_package_risk_analyze",
];

const REMOVED_TOOLS = [
  "web_search",
  "search_developer_docs",
  "synesis_knowledge_search",
  "synesis_cve_check",
  "synesis_license_check",
  "synesis_docs_lookup",
];

function collectRegisteredTools(options?: { allTools?: boolean }): string[] {
  const registered: string[] = [];
  const mockServer = {
    registerTool(name: string) {
      registered.push(name);
    },
  };
  const auth: SynesisMcpAuth = {
    bearerToken: "test",
    userId: "test",
    orgId: "",
    tenantIds: [],
  };
  const deps: SynesisMcpDeps = { plannerBaseUrl: "http://localhost:8080" };
  registerSynesisMcpTools(mockServer, auth, deps, options);
  return registered;
}

describe("tool curation — default registration", () => {
  const tools = collectRegisteredTools();

  it("registers all core tools", () => {
    for (const name of CORE_TOOLS) {
      expect(tools, `core tool ${name} should be registered`).toContain(name);
    }
  });

  it("does not register extended tools by default", () => {
    for (const name of EXTENDED_TOOLS) {
      expect(tools, `extended tool ${name} should NOT be registered by default`).not.toContain(name);
    }
  });

  it("does not register removed tools", () => {
    for (const name of REMOVED_TOOLS) {
      expect(tools, `removed tool ${name} should never be registered`).not.toContain(name);
    }
  });

  it("registers exactly the core set", () => {
    expect(tools.sort()).toEqual([...CORE_TOOLS].sort());
  });
});

describe("tool curation — allTools registration", () => {
  const tools = collectRegisteredTools({ allTools: true });

  it("registers core tools", () => {
    for (const name of CORE_TOOLS) {
      expect(tools).toContain(name);
    }
  });

  it("registers extended tools", () => {
    for (const name of EXTENDED_TOOLS) {
      expect(tools, `extended tool ${name} should be registered with allTools`).toContain(name);
    }
  });

  it("still does not register removed tools", () => {
    for (const name of REMOVED_TOOLS) {
      expect(tools, `removed tool ${name} should never be registered`).not.toContain(name);
    }
  });

  it("registers exactly core + extended set", () => {
    expect(tools.sort()).toEqual([...CORE_TOOLS, ...EXTENDED_TOOLS].sort());
  });
});
