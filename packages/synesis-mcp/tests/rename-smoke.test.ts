import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function readFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("rename smoke — no stale mcp-ts references", () => {
  it("root package.json workspaces references base/synesis-mcp", () => {
    const pkg = JSON.parse(readFile("package.json"));
    expect(pkg.workspaces).toContain("base/synesis-mcp");
    expect(pkg.workspaces).not.toContain("base/mcp-ts");
  });

  it(".gitignore references base/synesis-mcp/dist/", () => {
    const gitignore = readFile(".gitignore");
    expect(gitignore).toContain("base/synesis-mcp/dist/");
    expect(gitignore).not.toContain("base/mcp-ts/dist/");
  });

  it("base/synesis-mcp/ directory exists", () => {
    expect(existsSync(resolve(repoRoot, "base/synesis-mcp/package.json"))).toBe(true);
  });

  it("base/mcp-ts/ directory no longer exists", () => {
    expect(existsSync(resolve(repoRoot, "base/mcp-ts/package.json"))).toBe(false);
  });

  it("hosted package.json has correct name", () => {
    const pkg = JSON.parse(readFile("base/synesis-mcp/package.json"));
    expect(pkg.name).toBe("@synesis/mcp-hosted");
  });

  it("deployment.yaml uses synesis-mcp (not synesis-mcp-ts)", () => {
    const yaml = readFile("base/synesis-mcp/deployment.yaml");
    expect(yaml).toContain("name: synesis-mcp");
    expect(yaml).not.toContain("synesis-mcp-ts");
  });

  it("service.yaml uses synesis-mcp", () => {
    const yaml = readFile("base/synesis-mcp/service.yaml");
    expect(yaml).toContain("name: synesis-mcp");
    expect(yaml).not.toContain("synesis-mcp-ts");
  });

  it("admin deps.py points to synesis-mcp service", () => {
    const deps = readFile("base/admin/app/deps.py");
    expect(deps).toContain("synesis-mcp.synesis-yarn");
    expect(deps).not.toContain("synesis-mcp-ts.synesis-yarn");
  });
});

describe("catalog — removed tools not present", () => {
  it("catalog source does not reference removed tools", () => {
    const catalog = readFile("packages/synesis-mcp-tools/src/catalog.ts");
    expect(catalog).not.toContain('"web_search"');
    expect(catalog).not.toContain('"search_developer_docs"');
    expect(catalog).not.toContain('"synesis_knowledge_search"');
    expect(catalog).not.toContain('"synesis_cve_check"');
    expect(catalog).not.toContain('"synesis_license_check"');
    expect(catalog).not.toContain('"synesis_docs_lookup"');
  });
});
