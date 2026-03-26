import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReducerFamily } from "../src/reduction/classifier.js";
import { ReducerRegistry } from "../src/reduction/registry.js";
import type { ReducerFamily } from "../src/reduction/types.js";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", "reducers", `${name}.txt`), "utf8");
}

const ALL_FAMILIES: Array<Exclude<ReducerFamily, "generic">> = [
  "pytest", "tsc", "lint", "git", "search",
  "npm-install", "docker-build", "cargo", "make", "stack-trace",
  "jest", "go-build", "pip-install", "ls-tree", "curl-http",
  "kubectl", "terraform", "sql-result", "mypy", "java-build",
  "ansible", "helm", "network-diag", "strace-perf", "log-stream"
];

const registry = new ReducerRegistry({
  enabled: true,
  enabledFamilies: new Set(ALL_FAMILIES as ReducerFamily[]),
  minConfidence: 0.6
});

const TOOL_HINTS: Record<string, { toolName: string; command: string }> = {
  pytest:          { toolName: "pytest", command: "pytest" },
  tsc:             { toolName: "tsc", command: "tsc --noEmit" },
  lint:            { toolName: "ruff", command: "ruff check" },
  git:             { toolName: "bash", command: "git status" },
  search:          { toolName: "rg", command: "rg run" },
  "npm-install":   { toolName: "bash", command: "npm install" },
  "docker-build":  { toolName: "bash", command: "docker build ." },
  cargo:           { toolName: "bash", command: "cargo build" },
  make:            { toolName: "bash", command: "make" },
  "stack-trace":   { toolName: "bash", command: "python app.py" },
  jest:            { toolName: "bash", command: "npx jest" },
  "go-build":      { toolName: "bash", command: "go build ./..." },
  "pip-install":   { toolName: "bash", command: "pip install -r requirements.txt" },
  "ls-tree":       { toolName: "bash", command: "tree ." },
  "curl-http":     { toolName: "curl", command: "curl -v https://example.com" },
  kubectl:         { toolName: "bash", command: "kubectl get pods" },
  terraform:       { toolName: "bash", command: "terraform plan" },
  "sql-result":    { toolName: "bash", command: "psql -c 'SELECT * FROM users'" },
  mypy:            { toolName: "bash", command: "mypy src/" },
  "java-build":    { toolName: "bash", command: "mvn package" },
  ansible:         { toolName: "bash", command: "ansible-playbook site.yml" },
  helm:            { toolName: "bash", command: "helm install my-release chart/" },
  "network-diag":  { toolName: "bash", command: "ping -c 4 google.com" },
  "strace-perf":   { toolName: "bash", command: "strace -c ls" },
  "log-stream":    { toolName: "bash", command: "journalctl -u myapp --no-pager" },
};

describe("Classifier: all families by toolName/command hint", () => {
  for (const family of ALL_FAMILIES) {
    const hint = TOOL_HINTS[family];
    it(`classifies ${family} via tool hints`, () => {
      const result = classifyReducerFamily(hint.toolName, hint.command, fixture(family));
      expect(result).toBe(family);
    });
  }
});

describe("ReducerRegistry: all families produce non-null output", () => {
  for (const family of ALL_FAMILIES) {
    const hint = TOOL_HINTS[family];
    it(`reduces ${family} fixture`, () => {
      const out = registry.reduce({
        raw: fixture(family),
        context: { toolName: hint.toolName, command: hint.command, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
      });
      expect(out).not.toBeNull();
      expect(out!.summary).toContain(`family="${family}"`);
      expect(out!.confidence).toBeGreaterThanOrEqual(0.6);
    });
  }
});

describe("Reducer output quality", () => {
  it("pytest extracts failures", () => {
    const out = registry.reduce({ raw: fixture("pytest"), context: { toolName: "pytest", command: "pytest", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.actionableCount).toBeGreaterThan(0);
  });

  it("npm-install extracts warnings or packages", () => {
    const out = registry.reduce({ raw: fixture("npm-install"), context: { toolName: "bash", command: "npm install", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toMatch(/added|warn|error/i);
  });

  it("docker-build extracts steps", () => {
    const out = registry.reduce({ raw: fixture("docker-build"), context: { toolName: "bash", command: "docker build .", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("steps=");
  });

  it("cargo extracts errors", () => {
    const out = registry.reduce({ raw: fixture("cargo"), context: { toolName: "bash", command: "cargo build", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.actionableCount).toBeGreaterThan(0);
  });

  it("stack-trace extracts error and frames", () => {
    const out = registry.reduce({ raw: fixture("stack-trace"), context: { toolName: "bash", command: "python app.py", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("frames=");
  });

  it("jest extracts failures", () => {
    const out = registry.reduce({ raw: fixture("jest"), context: { toolName: "bash", command: "npx jest", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("failures=");
  });

  it("mypy extracts errors", () => {
    const out = registry.reduce({ raw: fixture("mypy"), context: { toolName: "bash", command: "mypy src/", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("errors=");
  });

  it("kubectl extracts resources", () => {
    const out = registry.reduce({ raw: fixture("kubectl"), context: { toolName: "bash", command: "kubectl get pods", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("resources=");
  });

  it("terraform extracts changes", () => {
    const out = registry.reduce({ raw: fixture("terraform"), context: { toolName: "bash", command: "terraform plan", profile: "balanced", maxChars: 12000, minConfidence: 0.6 } });
    expect(out!.summary).toContain("changes=");
  });

  it("reduction is shorter than input for non-trivial outputs (>500 chars)", () => {
    for (const family of ALL_FAMILIES) {
      const hint = TOOL_HINTS[family];
      const raw = fixture(family);
      if (raw.length < 500) continue;
      const out = registry.reduce({
        raw,
        context: { toolName: hint.toolName, command: hint.command, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
      });
      if (out) {
        expect(out.summary.length).toBeLessThan(raw.length);
      }
    }
  });
});
