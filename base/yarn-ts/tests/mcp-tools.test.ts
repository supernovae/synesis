import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpToolRegistry, McpToolNotFoundError, type McpToolDefinition } from "../src/mcp/tool-registry.js";
import { classifyProjectTool } from "../src/mcp/handlers/classify-project.js";
import { inspectRepoTool } from "../src/mcp/handlers/inspect-repo.js";
import { scaffoldTool } from "../src/mcp/handlers/scaffold.js";
import { compareManifestTool } from "../src/mcp/handlers/compare-manifest.js";
import {
  delegateTaskTool,
  formatCodeTool,
  gitAddGuardedTool,
  gitCommitGuardedTool,
  gitDiffTool,
  getRuntimeContextTool,
  gitBranchInfoTool,
  gitFileStateTool,
  gitRevParseTool,
  gitStatusTool,
  listDirTool,
  repoApplyPatchTool,
  repoFindSymbolTool,
  repoGitDiffTool,
  repoListChangedFilesTool,
  repoReadRangeTool,
  repoRunLintTool,
  repoRunTestsTool,
  repoSearchTool,
  repoWriteDecisionRecordTool,
  readFileTool,
  runLintTool,
  writeFileTool,
  strReplaceTool,
  searchCodeTool,
  runBuildTool,
  runTestTool,
  runInSandboxTool,
  takeScreenshotTool,
} from "../src/mcp/handlers/coding-tools.js";
import {
  storeObservationTool,
  recallFindingsTool,
} from "../src/mcp/handlers/memory-tools.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const LOCAL_MCP_TOOLS: McpToolDefinition[] = [
  classifyProjectTool,
  inspectRepoTool,
  scaffoldTool,
  compareManifestTool,
  getRuntimeContextTool,
  listDirTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
  searchCodeTool,
  runTestTool,
  runBuildTool,
  runLintTool,
  formatCodeTool,
  gitStatusTool,
  gitDiffTool,
  gitRevParseTool,
  gitBranchInfoTool,
  gitFileStateTool,
  gitAddGuardedTool,
  gitCommitGuardedTool,
  runInSandboxTool,
  takeScreenshotTool,
  delegateTaskTool,
  repoSearchTool,
  repoReadRangeTool,
  repoFindSymbolTool,
  repoApplyPatchTool,
  repoRunTestsTool,
  repoRunLintTool,
  repoGitDiffTool,
  repoListChangedFilesTool,
  repoWriteDecisionRecordTool,
  storeObservationTool,
  recallFindingsTool,
];

const CATALOG_JSON_SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "propertyNames",
  "properties",
  "required",
  "type",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedSchema(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertClosedSchema(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(schema)) return;

  expect(Object.keys(schema).length, `${path} must not expose an empty schema descriptor`).toBeGreaterThan(0);
  for (const key of Object.keys(schema)) {
    expect(CATALOG_JSON_SCHEMA_KEYS.has(key), `${path} should not expose unknown schema key ${key}`).toBe(true);
  }

  const hasBoundedMapSchema = isRecord(schema.propertyNames) && isRecord(schema.additionalProperties);
  if ((schema.type === "object" || isRecord(schema.properties)) && !hasBoundedMapSchema) {
    expect(schema.additionalProperties, `${path} must reject undeclared fields`).toBe(false);
  }

  for (const key of ["items", "allOf", "anyOf", "oneOf", "propertyNames", "additionalProperties"] as const) {
    assertClosedSchema(schema[key], `${path}.${key}`);
  }

  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      assertClosedSchema(propertySchema, `${path}.properties.${propertyName}`);
    }
  }
  if (isRecord(schema.$defs)) {
    for (const [definitionName, definitionSchema] of Object.entries(schema.$defs)) {
      assertClosedSchema(definitionSchema, `${path}.$defs.${definitionName}`);
    }
  }
}

describe("McpToolRegistry", () => {
  it("registers and lists tools", () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);
    registry.register(inspectRepoTool);
    registry.register(getRuntimeContextTool);
    registry.register(listDirTool);

    const catalog = registry.getCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(4);
    expect(catalog.map((t) => t.name)).toContain("synesis_classify_project");
    expect(catalog.map((t) => t.name)).toContain("synesis_inspect_repo");
    expect(catalog.map((t) => t.name)).toContain("get_runtime_context");
    expect(catalog.map((t) => t.name)).toContain("list_dir");
  });

  it("calls a registered tool", async () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);

    const result = await registry.call("synesis_classify_project", {
      task: "Create a Go CLI with cobra",
    });
    expect(result).toHaveProperty("classification");
    expect(result).toHaveProperty("complexity");
  });

  it("throws McpToolNotFoundError for unknown tool", async () => {
    const registry = new McpToolRegistry();
    await expect(registry.call("nonexistent", {})).rejects.toThrow(McpToolNotFoundError);
  });

  it("validates input against schema", async () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);

    await expect(
      registry.call("synesis_classify_project", { task: "" })
    ).rejects.toThrow();
  });

  it("publishes closed JSON schemas for strict tool inputs", () => {
    const registry = new McpToolRegistry();
    for (const tool of LOCAL_MCP_TOOLS) registry.register(tool);

    const catalog = registry.getCatalog();
    const classify = catalog.find((tool) => tool.name === "synesis_classify_project");
    const listDir = catalog.find((tool) => tool.name === "list_dir");

    expect(classify?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(listDir?.inputSchema).toMatchObject({ additionalProperties: false });
    for (const tool of catalog) {
      assertClosedSchema(tool.inputSchema, tool.name);
    }
  });

  it("rejects unsupported tool schemas during catalog generation", () => {
    const registry = new McpToolRegistry();
    registry.register({
      name: "unsafe_freeform",
      description: "invalid test tool",
      inputSchema: z.object({
        payload: z.unknown(),
      }).strict(),
      handler: () => ({}),
    });

    expect(() => registry.getCatalog()).toThrow(/unsupported_mcp_catalog_(schema_key|empty_schema)|Unrepresentable/);
  });

  it("rejects unknown attributes before invoking strict MCP handlers", async () => {
    const registry = new McpToolRegistry();
    registry.register(classifyProjectTool);
    registry.register(listDirTool);

    await expect(
      registry.call("synesis_classify_project", {
        task: "Create a Go CLI",
        caller_role: "admin",
      }),
    ).rejects.toThrow(/caller_role/);

    await expect(
      registry.call("list_dir", {
        projectRoot: "/tmp/repo",
        caller_user_id: "u-admin",
      }),
    ).rejects.toThrow(/caller_user_id/);
  });
});

describe("coding tools", () => {
  it("rejects undeclared runner presets and sandbox languages at schema validation", () => {
    expect(() => runTestTool.inputSchema.parse({
      projectRoot: "/tmp/repo",
      preset: "shell_command",
    })).toThrow(/Invalid option/);

    expect(() => runInSandboxTool.inputSchema.parse({
      projectRoot: "/tmp/repo",
      filePath: "script.ps1",
      language: "powershell",
    })).toThrow(/Invalid option/);
  });

  it("rejects invented decision-record fields", () => {
    expect(() => repoWriteDecisionRecordTool.inputSchema.parse({
      projectRoot: "/tmp/repo",
      decisionRecord: {
        question: "Which path?",
        options: [
          { id: "safe_minimal", description: "Minimal reversible diff." },
          { id: "broader_refactor", description: "Broader change." },
        ],
        evidencePerOption: {
          safe_minimal: ["smaller diff"],
          broader_refactor: ["long-term simplification"],
        },
        riskPerOption: {
          safe_minimal: "low",
          broader_refactor: "medium",
        },
        recommendation: "safe_minimal",
        confidence: 0.8,
        requiresUserChoice: true,
        role_override: "platform_admin",
      },
    })).toThrow(/role_override/);
  });

  it("performs read/write/apply patch flow in temp root", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-tools-"));
    const rel = "src/app.txt";

    const write = await writeFileTool.handler({
      projectRoot: root,
      filePath: rel,
      content: "hello world",
      createDirs: true,
    });
    expect(write.written).toBe(true);

    const read = await readFileTool.handler({
      projectRoot: root,
      filePath: rel,
      maxBytes: 1000,
    });
    expect(read.content).toContain("hello world");

    const multiline = Array.from({ length: 30 }, (_, i) => `N${String(i + 1).padStart(2, "0")}`).join("\n");
    writeFileSync(path.join(root, "lines.txt"), multiline, "utf8");
    const windowed = await readFileTool.handler({
      projectRoot: root,
      filePath: "lines.txt",
      startLine: 5,
      maxBytes: 10_000,
    });
    expect(windowed.content).toContain("N05");
    expect(windowed.content).not.toContain("N01");
    expect(windowed.lineRange).toEqual({ startLine: 5, endLine: 30 });

    const patched = await strReplaceTool.handler({
      projectRoot: root,
      filePath: rel,
      oldString: "world",
      newString: "synesis",
    });
    expect(patched.replaced).toBe(true);
    expect(patched.ok).toBe(true);
    expect(patched.reason).toBe("applied");
    expect(patched.suggestedNextActions).toEqual([]);

    writeFileSync(path.join(root, "dupe.txt"), "x=1\nx=1\n", "utf8");
    const patchDupe = await strReplaceTool.handler({
      projectRoot: root,
      filePath: "dupe.txt",
      oldString: "x=1",
      newString: "x=2",
    });
    expect(patchDupe.replaced).toBe(false);
    expect(patchDupe.ok).toBe(false);
    expect(patchDupe.reason).toBe("multiple_matches");
    expect(patchDupe.suggestedNextActions.length).toBeGreaterThan(0);

    const patchMiss = await strReplaceTool.handler({
      projectRoot: root,
      filePath: rel,
      oldString: "does-not-exist",
      newString: "x",
    });
    expect(patchMiss.replaced).toBe(false);
    expect(patchMiss.ok).toBe(false);
    expect(["not_found", "context_mismatch"]).toContain(patchMiss.reason);
    expect(patchMiss.suggestedNextActions.length).toBeGreaterThan(0);
  });

  it("rejects non-canonical project roots at the coding tool schema boundary", () => {
    expect(() => readFileTool.inputSchema.parse({
      projectRoot: "/tmp/synesis\nrole=admin",
      filePath: "README.md",
      maxBytes: 1000,
    })).toThrow(/Project root must be a canonical absolute non-root path/);

    expect(() => readFileTool.inputSchema.parse({
      projectRoot: "/",
      filePath: "README.md",
      maxBytes: 1000,
    })).toThrow(/Project root must be a canonical absolute non-root path/);

    expect(() => readFileTool.inputSchema.parse({
      projectRoot: "/tmp/synesis/../synesis",
      filePath: "README.md",
      maxBytes: 1000,
    })).toThrow(/Project root must be a canonical absolute non-root path/);
  });

  it("accepts canonical project roots at the coding tool schema boundary", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-root-schema-"));
    const parsed = readFileTool.inputSchema.parse({
      projectRoot: root,
      filePath: "README.md",
      maxBytes: 1000,
    });
    expect(parsed.projectRoot).toBe(root);
  });

  it("searches code with rg", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-rg-"));
    writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    const out = await searchCodeTool.handler({
      projectRoot: root,
      pattern: "package main",
      dir: ".",
      headLimit: 10,
    });
    expect([0, 1]).toContain(out.exitCode);
    if (out.exitCode === 0) {
      expect(out.matches.length).toBeGreaterThan(0);
    }
  });

  it("returns metadata-first list_dir payload", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-list-"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const out = await listDirTool.handler({
      projectRoot: root,
      dir: ".",
      maxDepth: 1,
      includeHidden: false,
    });
    expect(out.entries.length).toBeGreaterThan(0);
    expect(out.entriesMeta.length).toBeGreaterThan(0);
    expect(out.entriesMeta[0]).toHaveProperty("path");
    expect(out.entriesMeta[0]).toHaveProperty("size");
    expect(out.entriesMeta[0]).toHaveProperty("mtimeMs");
    expect(typeof out.nextAction).toBe("string");
  });

  it("returns deterministic no-result guidance for search_code", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-search-empty-"));
    writeFileSync(path.join(root, "main.go"), "package main\n", "utf8");
    const out = await searchCodeTool.handler({
      projectRoot: root,
      pattern: "symbol_that_does_not_exist",
      dir: ".",
      headLimit: 10,
    });
    expect(out.matches).toHaveLength(0);
    expect(out.noResultsGuidance?.length ?? 0).toBeGreaterThan(0);
  });

  it("run_build returns summary and errorLines on failure", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-buildfail-"));
    writeFileSync(path.join(root, "bad.py"), "def broken(\n", "utf8");
    const out = await runBuildTool.handler({
      projectRoot: root,
      preset: "python",
    });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("failed");
    expect(out.exitCode).not.toBe(0);
    expect(Array.isArray(out.errorLines)).toBe(true);
    expect(Array.isArray(out.errors)).toBe(true);
    expect(Array.isArray(out.nextActions)).toBe(true);
    expect(out.nextActions.length).toBeGreaterThan(0);
    expect(out.terminalSignals).toBeDefined();
    expect(typeof out.terminalSignals.classification).toBe("string");
  });

  it("reports read-only git introspection for repo roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synesis-yarn-git-"));
    execFileSync("git", ["init"], { cwd: root });
    writeFileSync(path.join(root, "app.ts"), "export const ok = true;\n", "utf8");
    execFileSync("git", ["add", "--", "app.ts"], { cwd: root });

    const rev = await gitRevParseTool.handler({ projectRoot: root });
    expect(rev.isGitRepo).toBe(true);
    expect(rev.topLevel).toBeTruthy();
    expect(typeof rev.detachedHead).toBe("boolean");

    const branch = await gitBranchInfoTool.handler({ projectRoot: root });
    expect(branch.isGitRepo).toBe(true);
    expect(branch.branch).toBeTruthy();
    expect(branch.dirty).toBe(true);

    const fileState = await gitFileStateTool.handler({ projectRoot: root, filePath: "app.ts" });
    expect(fileState.isGitRepo).toBe(true);
    expect(fileState.statusCode).toBe("A ");
    expect(fileState.staged).toBe(true);
  });
});

describe("memory MCP tool schemas", () => {
  it("rejects unknown attributes and undeclared scopes", () => {
    expect(() => storeObservationTool.inputSchema.parse({
      topic: "auth",
      finding: "Session middleware validates PATs.",
      scope: "tenant",
    })).toThrow(/Invalid option/);

    expect(() => storeObservationTool.inputSchema.parse({
      topic: "auth",
      finding: "Session middleware validates PATs.",
      run_as_admin: true,
    })).toThrow(/run_as_admin/);

    expect(() => recallFindingsTool.inputSchema.parse({
      scope: "all",
      user_id: "u-admin",
    })).toThrow(/user_id/);
  });
});

describe("classifyProjectTool handler", () => {
  it("classifies a Go CLI task", () => {
    const result = classifyProjectTool.handler({
      task: "Build a Go CLI with subcommands and flags",
    });
    expect(result.classification.projectKind).toBe("go_cli");
    expect(result.complexity.complexity).not.toBe("large");
  });

  it("classifies with fileCount", () => {
    const result = classifyProjectTool.handler({
      task: "Add some handlers",
      fileCount: 12,
    });
    expect(result.complexity.complexity).toBe("medium");
  });
});

describe("inspectRepoTool handler", () => {
  it("scans file paths into a manifest", () => {
    const result = inspectRepoTool.handler({
      filePaths: ["go.mod", "cmd/svc/main.go", "internal/http/routes.go"],
    });
    expect(result.languages).toContain("go");
    expect(result.source).toBe("observed");
  });
});

describe("scaffoldTool handler", () => {
  it("returns template for known kind", () => {
    const result = scaffoldTool.handler({ projectKind: "go_cli" });
    expect(result.found).toBe(true);
    expect(result.template).toBeDefined();
    expect(result.template!.kind).toBe("go_cli");
  });

  it("returns not found for unknown kind", () => {
    const result = scaffoldTool.handler({ projectKind: "unknown" });
    expect(result.found).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("substitutes project name in file paths", () => {
    const result = scaffoldTool.handler({ projectKind: "go_cli", projectName: "mytool" });
    expect(result.found).toBe(true);
    const paths = result.template!.manifest.expectedFiles.map((f) => f.path);
    expect(paths).toContain("cmd/mytool/main.go");
    expect(result.template!.manifest.projectName).toBe("mytool");
  });
});

describe("compareManifestTool handler", () => {
  it("compares two manifests with critique", () => {
    const target = {
      detectedKind: "go_cli" as const,
      expectedFiles: [
        { path: "go.mod", required: true, purpose: "Go module" },
        { path: "README.md", required: true, purpose: "Docs" },
      ],
    };
    const observed = {
      detectedKind: "go_cli" as const,
      expectedFiles: [{ path: "go.mod", required: false, purpose: "", status: "present" as const }],
    };

    const result = compareManifestTool.handler({
      target,
      observed,
      includeStructuralCritique: true,
    });
    expect(result.comparison.missingFiles.length).toBeGreaterThan(0);
    expect(result.critique).toBeDefined();
    expect(result.critique!.passed).toBe(false);
  });
});
