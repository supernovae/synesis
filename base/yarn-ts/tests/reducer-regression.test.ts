import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReducerFamily } from "../src/reduction/classifier.js";
import { ReducerRegistry, registeredFamilies } from "../src/reduction/registry.js";
import type { ReducerFamily } from "../src/reduction/types.js";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", "reducers", `${name}.txt`), "utf8");
}

function liveFixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests", "fixtures", "live", `${name}-large.txt`), "utf8");
}

const ALL_FAMILIES = registeredFamilies();

const registry = new ReducerRegistry({
  enabled: true,
  disabledFamilies: new Set<string>(),
  minConfidence: 0.6
});

const TOOL_HINTS: Record<string, { toolName: string; command: string }> = {
  // Original 25
  pytest:              { toolName: "pytest", command: "pytest" },
  tsc:                 { toolName: "tsc", command: "tsc --noEmit" },
  lint:                { toolName: "ruff", command: "ruff check" },
  git:                 { toolName: "bash", command: "git status" },
  search:              { toolName: "rg", command: "rg run" },
  "npm-install":       { toolName: "bash", command: "npm install" },
  "docker-build":      { toolName: "bash", command: "docker build ." },
  cargo:               { toolName: "bash", command: "cargo build" },
  make:                { toolName: "bash", command: "make" },
  "stack-trace":       { toolName: "bash", command: "python app.py" },
  jest:                { toolName: "bash", command: "npx jest" },
  "go-build":          { toolName: "bash", command: "go build ./..." },
  "pip-install":       { toolName: "bash", command: "pip install -r requirements.txt" },
  "ls-tree":           { toolName: "bash", command: "tree ." },
  "curl-http":         { toolName: "curl", command: "curl -v https://example.com" },
  kubectl:             { toolName: "bash", command: "kubectl get pods" },
  terraform:           { toolName: "bash", command: "terraform plan" },
  "sql-result":        { toolName: "bash", command: "psql -c 'SELECT * FROM users'" },
  mypy:                { toolName: "bash", command: "mypy src/" },
  "java-build":        { toolName: "bash", command: "mvn package" },
  ansible:             { toolName: "bash", command: "ansible-playbook site.yml" },
  helm:                { toolName: "bash", command: "helm install my-release chart/" },
  "network-diag":      { toolName: "bash", command: "ping -c 4 google.com" },
  "strace-perf":       { toolName: "bash", command: "strace -c ls" },
  "log-stream":        { toolName: "bash", command: "journalctl -u myapp --no-pager" },
  // Batch 3: container/infra + VCS
  "git-diff":          { toolName: "bash", command: "git diff HEAD~1" },
  podman:              { toolName: "bash", command: "podman ps -a" },
  oc:                  { toolName: "bash", command: "oc describe pod planner-xxx" },
  "docker-compose":    { toolName: "bash", command: "docker compose logs" },
  coverage:            { toolName: "bash", command: "npx c8 report" },
  // Batch 4: cloud CLIs + audit
  "aws-cli":           { toolName: "bash", command: "aws ec2 describe-instances" },
  gcloud:              { toolName: "bash", command: "gcloud compute instances list" },
  "az-cli":            { toolName: "bash", command: "az vm list" },
  "npm-audit":         { toolName: "bash", command: "npm audit" },
  webpack:             { toolName: "bash", command: "npx webpack" },
  // Batch 5: JS build + package managers
  vite:                { toolName: "bash", command: "vite build" },
  esbuild:             { toolName: "bash", command: "npx esbuild" },
  "yarn-install":      { toolName: "bash", command: "yarn install" },
  pnpm:                { toolName: "bash", command: "pnpm install" },
  "apt-pkg":           { toolName: "bash", command: "apt-get install -y nginx" },
  // Batch 6: test runners
  mocha:               { toolName: "bash", command: "npx mocha" },
  rspec:               { toolName: "bash", command: "rspec" },
  phpunit:             { toolName: "bash", command: "vendor/bin/phpunit" },
  "python-unittest":   { toolName: "bash", command: "python -m unittest discover" },
  dotnet:              { toolName: "bash", command: "dotnet build" },
  // Batch 7: linters
  pylint:              { toolName: "bash", command: "pylint src/" },
  shellcheck:          { toolName: "bash", command: "shellcheck script.sh" },
  clippy:              { toolName: "bash", command: "cargo clippy" },
  rubocop:             { toolName: "bash", command: "rubocop" },
  cppcheck:            { toolName: "bash", command: "cppcheck src/" },
  // Batch 8: remaining
  gradle:              { toolName: "bash", command: "gradle build" },
  "swift-build":       { toolName: "bash", command: "swift build" },
  cmake:               { toolName: "bash", command: "cmake .." },
  composer:            { toolName: "bash", command: "composer install" },
  "git-log":           { toolName: "bash", command: "git log --oneline -20" },
};

describe("Classifier: all families by toolName/command hint", () => {
  for (const family of ALL_FAMILIES) {
    const hint = TOOL_HINTS[family];
    if (!hint) continue;
    it(`classifies ${family} via tool hints`, () => {
      const result = classifyReducerFamily(hint.toolName, hint.command, fixture(family));
      expect(result).toBe(family);
    });
  }
});

describe("ReducerRegistry: all families produce non-null output", () => {
  for (const family of ALL_FAMILIES) {
    const hint = TOOL_HINTS[family];
    if (!hint) continue;
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

describe("Classifier: raw-content-only fallback (toolName=bash, no command)", () => {
  const PHASE2_FAMILIES: string[] = [
    // Original families with Phase 2 rules
    "docker-build", "go-build", "terraform", "network-diag",
    "npm-install", "cargo", "make", "stack-trace", "jest",
    "pip-install", "kubectl", "java-build", "ansible", "helm",
    "strace-perf", "log-stream",
    // Batch 3
    "git-diff", "docker-compose", "coverage",
    // Batch 4-8 (families with distinctive raw patterns)
    "webpack", "npm-audit", "mocha",
    "gradle", "cmake",
  ];
  for (const family of PHASE2_FAMILIES) {
    it(`classifies ${family} from raw content alone (live fixture)`, () => {
      const raw = liveFixture(family);
      const result = classifyReducerFamily("bash", undefined, raw);
      expect(result).toBe(family);
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
      if (!hint) continue;
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

describe("Enrichment integration: validator reducers produce enrichedItems", () => {
  const ENRICHABLE_FAMILIES: ReducerFamily[] = [
    "pytest", "tsc", "lint", "mypy", "pylint", "cargo", "clippy",
    "jest", "go-build", "shellcheck", "rubocop", "cppcheck"
  ];

  // terraform fixture is plan-only (no errors), so enrichedItems is empty — tested separately
  for (const family of ENRICHABLE_FAMILIES) {
    const hint = TOOL_HINTS[family];
    if (!hint) continue;
    it(`${family} reducer populates enrichedItems`, () => {
      const out = registry.reduce({
        raw: fixture(family),
        context: { toolName: hint.toolName, command: hint.command, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
      });
      expect(out).not.toBeNull();
      expect(out!.enrichedItems).toBeDefined();
      expect(out!.enrichedItems!.length).toBeGreaterThan(0);
    });
  }

  it("terraform reducer returns enrichedItems (empty for plan-only fixture)", () => {
    const hint = TOOL_HINTS["terraform"];
    const out = registry.reduce({
      raw: fixture("terraform"),
      context: { toolName: hint.toolName, command: hint.command, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
    });
    expect(out).not.toBeNull();
    expect(out!.enrichedItems).toBeDefined();
    expect(Array.isArray(out!.enrichedItems)).toBe(true);
  });
});

describe("Enrichment integration: bypassEligible is boolean", () => {
  const ENRICHABLE_FAMILIES: ReducerFamily[] = [
    "pytest", "tsc", "lint", "mypy", "pylint", "cargo", "clippy",
    "terraform", "jest", "go-build", "shellcheck", "rubocop", "cppcheck"
  ];

  for (const family of ENRICHABLE_FAMILIES) {
    const hint = TOOL_HINTS[family];
    if (!hint) continue;
    it(`${family} reducer has bypassEligible defined`, () => {
      const out = registry.reduce({
        raw: fixture(family),
        context: { toolName: hint.toolName, command: hint.command, profile: "balanced", maxChars: 12000, minConfidence: 0.6 }
      });
      expect(out).not.toBeNull();
      expect(typeof out!.bypassEligible).toBe("boolean");
    });
  }
});
