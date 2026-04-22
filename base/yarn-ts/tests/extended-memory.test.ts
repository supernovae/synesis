import { describe, expect, it } from "vitest";
import {
  extractGoSymbols,
  extractTypeScriptSymbols,
  extractPythonSymbols,
  extractSymbols,
  detectLanguage,
} from "../src/memory/extractors.js";
import {
  buildStructuralIndex,
  renderStructuralMap,
} from "../src/memory/structural-index.js";
import {
  generateFileSummary,
  generateDirectorySummary,
} from "../src/memory/summary-store.js";
import {
  shouldChunkEval,
  extractRequirements,
  createEvalPlan,
  advancePhase,
  addFinding,
  generateEvalPhaseContext,
  formatEvalProgress,
} from "../src/memory/chunked-eval.js";
import { parseGoDocOutput, renderGoDocMap } from "../src/memory/go-doc-index.js";
import {
  MemoryGovernorTracker,
  evaluateMemoryRules,
  createEmptyMemorySignals,
} from "../src/memory/governor-integration.js";
import {
  generateExtendedMemoryContext,
} from "../src/memory/context-injector.js";
import type { FeatureFinding } from "../src/memory/types.js";

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

describe("extractors", () => {
  describe("detectLanguage", () => {
    it("detects Go files", () => expect(detectLanguage("cmd/main.go")).toBe("go"));
    it("detects TypeScript files", () => expect(detectLanguage("src/index.ts")).toBe("typescript"));
    it("detects TSX files", () => expect(detectLanguage("App.tsx")).toBe("typescript"));
    it("detects Python files", () => expect(detectLanguage("app.py")).toBe("python"));
    it("detects JavaScript files", () => expect(detectLanguage("util.js")).toBe("javascript"));
    it("detects Rust files", () => expect(detectLanguage("main.rs")).toBe("rust"));
    it("detects Java files", () => expect(detectLanguage("App.java")).toBe("java"));
    it("detects C files", () => expect(detectLanguage("main.c")).toBe("c"));
    it("detects C++ files", () => expect(detectLanguage("main.cpp")).toBe("cpp"));
    it("detects Markdown files", () => expect(detectLanguage("README.md")).toBe("markdown"));
    it("returns unknown for unrecognized", () => expect(detectLanguage("data.csv")).toBe("unknown"));
  });

  describe("extractGoSymbols", () => {
    const goCode = `package main

import (
	"fmt"
	"os"
)

type Config struct {
	Name string
	Port int
}

type Runner interface {
	Run() error
}

func NewConfig(name string) *Config {
	return &Config{Name: name}
}

func (c *Config) Validate() error {
	return nil
}

var DefaultPort = 8080
`;

    it("extracts exported functions", () => {
      const { symbols } = extractGoSymbols(goCode, "main.go");
      const funcs = symbols.filter((s) => s.kind === "function");
      expect(funcs.length).toBe(1);
      expect(funcs[0].name).toBe("NewConfig");
      expect(funcs[0].exported).toBe(true);
    });

    it("extracts methods with receivers", () => {
      const { symbols } = extractGoSymbols(goCode, "main.go");
      const methods = symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBe(1);
      expect(methods[0].name).toBe("Config.Validate");
    });

    it("extracts types and interfaces", () => {
      const { symbols } = extractGoSymbols(goCode, "main.go");
      const types = symbols.filter((s) => s.kind === "type" || s.kind === "interface");
      expect(types.length).toBe(2);
      expect(types.map((t) => t.name).sort()).toEqual(["Config", "Runner"]);
    });

    it("extracts imports", () => {
      const { imports } = extractGoSymbols(goCode, "main.go");
      expect(imports).toContain("fmt");
      expect(imports).toContain("os");
    });
  });

  describe("extractTypeScriptSymbols", () => {
    const tsCode = `import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";

export interface SessionRecord {
  key: string;
  version: number;
}

export class SessionStore {
  constructor(private readonly redis: Redis) {}

  async load(key: string): Promise<SessionRecord | null> {
    return null;
  }

  async save(record: SessionRecord): Promise<boolean> {
    return true;
  }
}

export function createStore(config: AppConfig): SessionStore {
  return new SessionStore(config as unknown as Redis);
}

export const DEFAULT_TTL = 3600;
`;

    it("extracts exported functions", () => {
      const { symbols } = extractTypeScriptSymbols(tsCode, "store.ts");
      const funcs = symbols.filter((s) => s.kind === "function");
      expect(funcs.length).toBe(1);
      expect(funcs[0].name).toBe("createStore");
    });

    it("extracts exported classes", () => {
      const { symbols } = extractTypeScriptSymbols(tsCode, "store.ts");
      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe("SessionStore");
    });

    it("extracts interfaces", () => {
      const { symbols } = extractTypeScriptSymbols(tsCode, "store.ts");
      const interfaces = symbols.filter((s) => s.kind === "interface");
      expect(interfaces.length).toBe(1);
      expect(interfaces[0].name).toBe("SessionRecord");
    });

    it("extracts methods on classes", () => {
      const { symbols } = extractTypeScriptSymbols(tsCode, "store.ts");
      const methods = symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBeGreaterThanOrEqual(2);
      expect(methods.map((m) => m.name)).toContain("SessionStore.load");
      expect(methods.map((m) => m.name)).toContain("SessionStore.save");
    });

    it("extracts exported consts", () => {
      const { symbols } = extractTypeScriptSymbols(tsCode, "store.ts");
      const consts = symbols.filter((s) => s.kind === "const");
      expect(consts.length).toBe(1);
      expect(consts[0].name).toBe("DEFAULT_TTL");
    });

    it("extracts imports", () => {
      const { imports } = extractTypeScriptSymbols(tsCode, "store.ts");
      expect(imports).toContain("ioredis");
      expect(imports).toContain("../config.js");
    });
  });

  describe("extractPythonSymbols", () => {
    const pyCode = `from fastapi import FastAPI
import os

class Config:
    def __init__(self, name: str):
        self.name = name

    def validate(self) -> bool:
        return True

def create_app(config: Config) -> FastAPI:
    return FastAPI()

def _internal_helper():
    pass
`;

    it("extracts classes", () => {
      const { symbols } = extractPythonSymbols(pyCode, "app.py");
      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe("Config");
    });

    it("extracts public functions", () => {
      const { symbols } = extractPythonSymbols(pyCode, "app.py");
      const funcs = symbols.filter((s) => s.kind === "function" && s.exported);
      expect(funcs.length).toBe(1);
      expect(funcs[0].name).toBe("create_app");
    });

    it("marks private functions as not exported", () => {
      const { symbols } = extractPythonSymbols(pyCode, "app.py");
      const privFuncs = symbols.filter((s) => s.kind === "function" && !s.exported);
      expect(privFuncs.length).toBe(1);
      expect(privFuncs[0].name).toBe("_internal_helper");
    });

    it("extracts methods on classes", () => {
      const { symbols } = extractPythonSymbols(pyCode, "app.py");
      const methods = symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBe(2);
      expect(methods.map((m) => m.name)).toContain("Config.__init__");
      expect(methods.map((m) => m.name)).toContain("Config.validate");
    });

    it("extracts imports", () => {
      const { imports } = extractPythonSymbols(pyCode, "app.py");
      expect(imports).toContain("fastapi");
      expect(imports).toContain("os");
    });
  });
});

// ---------------------------------------------------------------------------
// Structural Index
// ---------------------------------------------------------------------------

describe("structural index", () => {
  const files = [
    {
      path: "cmd/main.go",
      content: `package main

import "github.com/example/pkg/config"

func main() {
  c := config.NewConfig()
  c.Run()
}
`,
    },
    {
      path: "pkg/config/config.go",
      content: `package config

type Config struct {
  Port int
}

func NewConfig() *Config {
  return &Config{Port: 8080}
}

func (c *Config) Run() error {
  return nil
}
`,
    },
  ];

  it("builds an index with file entries", () => {
    const index = buildStructuralIndex("/project", files, "go");
    expect(index.files.length).toBe(2);
    expect(index.language).toBe("go");
    expect(index.projectRoot).toBe("/project");
  });

  it("computes cross-file symbol references", () => {
    const index = buildStructuralIndex("/project", files, "go");
    expect(index.symbolRefs["NewConfig"]).toBeGreaterThanOrEqual(1);
  });

  it("generates a content hash", () => {
    const index = buildStructuralIndex("/project", files, "go");
    expect(index.contentHash).toBeTruthy();
    expect(typeof index.contentHash).toBe("string");
  });

  describe("renderStructuralMap", () => {
    it("renders within token budget", () => {
      const index = buildStructuralIndex("/project", files, "go");
      const map = renderStructuralMap(index, { tokenBudget: 200 });
      expect(map).toContain("<STRUCTURAL_INDEX>");
      expect(map).toContain("</STRUCTURAL_INDEX>");
      expect(map.length).toBeLessThanOrEqual(200 * 4 + 100);
    });

    it("includes exported symbols", () => {
      const index = buildStructuralIndex("/project", files, "go");
      const map = renderStructuralMap(index, { tokenBudget: 500 });
      expect(map).toContain("NewConfig");
      expect(map).toContain("Config");
    });

    it("prioritizes files with recent activity", () => {
      const index = buildStructuralIndex("/project", files, "go");
      const map = renderStructuralMap(index, { tokenBudget: 500, recentFiles: ["pkg/config/config.go"] });
      expect(map).toContain("pkg/config/config.go");
    });
  });
});

// ---------------------------------------------------------------------------
// File Summary
// ---------------------------------------------------------------------------

describe("summary generation", () => {
  it("generates a compact file summary", () => {
    const content = `package main

func NewServer(port int) *Server { return nil }
func (s *Server) Start() error { return nil }

type Server struct { Port int }
`;
    const summary = generateFileSummary("server.go", content, 100);
    expect(summary).toContain("server.go");
    expect(summary).toContain("Exports:");
    expect(summary.length).toBeLessThanOrEqual(400);
  });

  it("generates a directory summary from children", () => {
    const children = [
      { path: "pkg/server.go", level: "file" as const, summary: "", contentHash: "a", language: "go", symbolCount: 5, lineCount: 100, updatedAt: 0 },
      { path: "pkg/config.go", level: "file" as const, summary: "", contentHash: "b", language: "go", symbolCount: 3, lineCount: 50, updatedAt: 0 },
    ];
    const summary = generateDirectorySummary("pkg", children);
    expect(summary).toContain("pkg/");
    expect(summary).toContain("2 files");
    expect(summary).toContain("150L");
  });
});

// ---------------------------------------------------------------------------
// Chunked Eval
// ---------------------------------------------------------------------------

describe("chunked eval", () => {
  describe("shouldChunkEval", () => {
    it("triggers on numbered feature lists with 5+ items", () => {
      const prompt = `Please validate:
1. User authentication
2. Role-based access control
3. Session management
4. Password hashing
5. Token refresh
6. Logout functionality`;
      expect(shouldChunkEval(prompt)).toBe(true);
    });

    it("does not trigger on short prompts", () => {
      expect(shouldChunkEval("Fix the login bug")).toBe(false);
    });

    it("triggers on validate keyword with 3+ features", () => {
      const prompt = `Validate that these features are implemented:
- User login
- Profile editing
- Email notifications`;
      expect(shouldChunkEval(prompt, 3)).toBe(true);
    });
  });

  describe("extractRequirements", () => {
    it("extracts numbered items", () => {
      const text = `1. Add user auth\n2. Build profile page\n3. Create API endpoints`;
      const reqs = extractRequirements(text);
      expect(reqs.length).toBe(3);
      expect(reqs[0].description).toContain("user auth");
    });

    it("extracts bullet items", () => {
      const text = `- Implement caching layer\n- Add rate limiting\n- Build health checks`;
      const reqs = extractRequirements(text);
      expect(reqs.length).toBe(3);
    });

    it("deduplicates identical items", () => {
      const text = `1. Add auth\n2. Add auth\n3. Build API`;
      const reqs = extractRequirements(text);
      expect(reqs.length).toBe(2);
    });
  });

  describe("eval plan lifecycle", () => {
    it("advances through phases", () => {
      const reqs = [
        { id: "r1", description: "Feature A" },
        { id: "r2", description: "Feature B" },
      ];
      let plan = createEvalPlan(reqs);
      expect(plan.currentPhase).toBe("index");

      plan = advancePhase(plan);
      expect(plan.currentPhase).toBe("map_features");
      expect(plan.currentFeatureIndex).toBe(0);

      plan = advancePhase(plan);
      expect(plan.currentFeatureIndex).toBe(1);

      plan = advancePhase(plan);
      expect(plan.currentPhase).toBe("synthesize");
    });

    it("accumulates findings", () => {
      const reqs = [{ id: "r1", description: "Feature A" }];
      let plan = createEvalPlan(reqs);
      const finding: FeatureFinding = {
        featureId: "r1",
        status: "implemented",
        evidence: "Found in server.go",
        relevantFiles: ["server.go"],
        confidence: 0.9,
      };
      plan = addFinding(plan, finding);
      expect(plan.findings.length).toBe(1);
      expect(plan.findings[0].status).toBe("implemented");
    });
  });

  describe("generateEvalPhaseContext", () => {
    it("generates index phase context", () => {
      const plan = createEvalPlan([{ id: "r1", description: "Auth" }]);
      const ctx = generateEvalPhaseContext(plan, "<STRUCTURAL_INDEX>map</STRUCTURAL_INDEX>");
      expect(ctx).toContain("CHUNKED_EVAL");
      expect(ctx).toContain("INDEX");
      expect(ctx).toContain("Auth");
    });

    it("generates synthesize phase context with findings", () => {
      let plan = createEvalPlan([{ id: "r1", description: "Auth" }]);
      plan = addFinding(plan, { featureId: "r1", status: "implemented", evidence: "Found", relevantFiles: [], confidence: 0.9 });
      plan = { ...plan, currentPhase: "synthesize" };
      const ctx = generateEvalPhaseContext(plan, null);
      expect(ctx).toContain("synthesize");
      expect(ctx).toContain("implemented");
    });
  });

  describe("formatEvalProgress", () => {
    it("shows progress counts", () => {
      let plan = createEvalPlan([
        { id: "r1", description: "A" },
        { id: "r2", description: "B" },
      ]);
      plan = addFinding(plan, { featureId: "r1", status: "implemented", evidence: "", relevantFiles: [], confidence: 1 });
      const progress = formatEvalProgress(plan);
      expect(progress).toContain("1/2");
      expect(progress).toContain("Implemented: 1");
    });
  });
});

// ---------------------------------------------------------------------------
// Go Doc Index
// ---------------------------------------------------------------------------

describe("go doc index", () => {
  const goDocOutput = `package config // import "github.com/example/pkg/config"

func NewConfig(name string) *Config
func (c *Config) Validate() error
type Config struct {
	Name string
	Port int
}

package server // import "github.com/example/pkg/server"

func NewServer(cfg *config.Config) *Server
func (s *Server) Start() error
type Server struct{}
`;

  it("parses go doc output into structural index", () => {
    const index = parseGoDocOutput(goDocOutput, "/project");
    expect(index.files.length).toBe(2);
    expect(index.language).toBe("go");
  });

  it("extracts functions from go doc output", () => {
    const index = parseGoDocOutput(goDocOutput, "/project");
    const allSymbols = index.files.flatMap((f) => f.symbols);
    expect(allSymbols.some((s) => s.name === "NewConfig")).toBe(true);
    expect(allSymbols.some((s) => s.name === "NewServer")).toBe(true);
  });

  it("extracts types from go doc output", () => {
    const index = parseGoDocOutput(goDocOutput, "/project");
    const allSymbols = index.files.flatMap((f) => f.symbols);
    expect(allSymbols.some((s) => s.name === "Config" && s.kind === "type")).toBe(true);
    expect(allSymbols.some((s) => s.name === "Server" && s.kind === "type")).toBe(true);
  });

  it("renders within token budget", () => {
    const map = renderGoDocMap(goDocOutput, 200);
    expect(map).toContain("<GO_DOC_INDEX>");
    expect(map).toContain("</GO_DOC_INDEX>");
    expect(map.length).toBeLessThanOrEqual(200 * 4 + 50);
  });
});

// ---------------------------------------------------------------------------
// Governor Integration
// ---------------------------------------------------------------------------

describe("memory governor", () => {
  describe("MemoryGovernorTracker", () => {
    it("tracks file reads and reread-with-summary", () => {
      const tracker = new MemoryGovernorTracker();
      tracker.trackFileRead("a.go");
      tracker.trackSummaryGenerated("a.go");
      tracker.trackFileRead("a.go");
      const signals = tracker.getSignals();
      expect(signals.rereadWithSummaryAvailable).toBe(1);
    });

    it("tracks broad discovery when index available", () => {
      const tracker = new MemoryGovernorTracker();
      tracker.setIndexAvailable(true);
      tracker.trackBroadDiscovery();
      tracker.trackBroadDiscovery();
      const signals = tracker.getSignals();
      expect(signals.broadDiscoveryWithoutIndex).toBe(2);
    });

    it("does not count broad discovery when no index", () => {
      const tracker = new MemoryGovernorTracker();
      tracker.trackBroadDiscovery();
      expect(tracker.getSignals().broadDiscoveryWithoutIndex).toBe(0);
    });

    it("resets all counters", () => {
      const tracker = new MemoryGovernorTracker();
      tracker.setIndexAvailable(true);
      tracker.trackBroadDiscovery();
      tracker.trackFileRead("a.go");
      tracker.reset();
      const signals = tracker.getSignals();
      expect(signals.broadDiscoveryWithoutIndex).toBe(0);
      expect(signals.structuralIndexAvailable).toBe(false);
    });
  });

  describe("evaluateMemoryRules", () => {
    it("fires reread_with_summary when threshold met", () => {
      const signals = { ...createEmptyMemorySignals(), rereadWithSummaryAvailable: 3 };
      const rules = evaluateMemoryRules(signals);
      expect(rules.some((r) => r.rule === "reread_with_summary" && r.fired)).toBe(true);
    });

    it("fires discovery_without_index when threshold met", () => {
      const signals = { ...createEmptyMemorySignals(), broadDiscoveryWithoutIndex: 6 };
      const rules = evaluateMemoryRules(signals);
      expect(rules.some((r) => r.rule === "discovery_without_index" && r.fired)).toBe(true);
    });

    it("fires findings_not_stored when threshold met", () => {
      const signals = { ...createEmptyMemorySignals(), findingsNotStored: 4 };
      const rules = evaluateMemoryRules(signals);
      expect(rules.some((r) => r.rule === "findings_not_stored" && r.fired)).toBe(true);
    });

    it("returns empty when all signals below threshold", () => {
      const rules = evaluateMemoryRules(createEmptyMemorySignals());
      expect(rules.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Context Injector
// ---------------------------------------------------------------------------

describe("context injector", () => {
  function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED: true,
      SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET: 500,
      SYNESIS_YARN_GO_DOC_REPOMAP_ENABLED: true,
      SYNESIS_YARN_MEMORY_TOOLS_ENABLED: true,
      SYNESIS_YARN_CHUNKED_EVAL_ENABLED: false,
      ...overrides,
    } as never;
  }

  it("injects structural index when available", () => {
    const index = buildStructuralIndex("/project", [
      { path: "main.go", content: "package main\nfunc Main() {}" },
    ], "go");
    const result = generateExtendedMemoryContext(makeConfig(), {
      structuralIndex: index,
      structuralMapFromIncremental: false,
      goDocOutput: null,
      evalPlan: null,
      recentFiles: [],
      projectLanguage: "go",
      memorySignals: createEmptyMemorySignals(),
    });
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks[0]).toContain("STRUCTURAL_INDEX");
  });

  it("falls back to go doc when no structural index", () => {
    const result = generateExtendedMemoryContext(makeConfig(), {
      structuralIndex: null,
      structuralMapFromIncremental: false,
      goDocOutput: "package main // import \"example\"\nfunc Main()",
      evalPlan: null,
      recentFiles: [],
      projectLanguage: "go",
      memorySignals: createEmptyMemorySignals(),
    });
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks[0]).toContain("GO_DOC_INDEX");
  });

  it("includes memory hint when findings exist", () => {
    const signals = { ...createEmptyMemorySignals(), findingsStoreSize: 5 };
    const result = generateExtendedMemoryContext(makeConfig(), {
      structuralIndex: null,
      structuralMapFromIncremental: false,
      goDocOutput: null,
      evalPlan: null,
      recentFiles: [],
      projectLanguage: "typescript",
      memorySignals: signals,
    });
    expect(result.blocks.some((b) => b.includes("MEMORY_HINT"))).toBe(true);
  });

  it("skips batch structural and go-doc when incremental map already in frame", () => {
    const index = buildStructuralIndex("/project", [
      { path: "main.go", content: "package main\nfunc Main() {}" },
    ], "go");
    const result = generateExtendedMemoryContext(makeConfig(), {
      structuralIndex: index,
      structuralMapFromIncremental: true,
      goDocOutput: "package main\nfunc X() {}",
      evalPlan: null,
      recentFiles: [],
      projectLanguage: "go",
      memorySignals: createEmptyMemorySignals(),
    });
    expect(result.blocks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// New language extractors
// ---------------------------------------------------------------------------

describe("Rust extractor", () => {
  it("extracts pub functions and structs", () => {
    const rust = `use std::collections::HashMap;

pub struct Config {
    name: String,
}

pub fn new_config(name: &str) -> Config {
    Config { name: name.to_string() }
}

fn private_helper() {}

pub trait Validator {
    fn validate(&self) -> bool;
}`;
    const { symbols, imports } = extractSymbols(rust, "src/config.rs", "rust");
    expect(symbols.length).toBeGreaterThanOrEqual(3);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Config");
    expect(names).toContain("new_config");
    expect(names).toContain("Validator");
    expect(symbols.find((s) => s.name === "new_config")?.exported).toBe(true);
    expect(symbols.find((s) => s.name === "private_helper")?.exported).toBe(false);
    expect(imports).toContain("std::collections::HashMap");
  });
});

describe("Java extractor", () => {
  it("extracts classes and public methods", () => {
    const java = `import java.util.List;

public class UserService {
    public List<User> findAll() {
        return db.query();
    }

    private void doInternal() {}
}`;
    const { symbols, imports } = extractSymbols(java, "UserService.java", "java");
    expect(symbols.some((s) => s.name === "UserService")).toBe(true);
    expect(symbols.some((s) => s.name === "UserService.findAll")).toBe(true);
    expect(imports).toContain("java.util.List");
  });
});

describe("C extractor", () => {
  it("extracts functions and structs from header", () => {
    const header = `#include <stdio.h>
#include "config.h"

typedef struct AppConfig {
    int port;
    char* host;
} AppConfig;

int app_init(AppConfig* cfg);
static void internal_setup(void);`;
    const { symbols, imports } = extractSymbols(header, "app.h", "c");
    expect(symbols.some((s) => s.name === "AppConfig")).toBe(true);
    expect(symbols.some((s) => s.name === "app_init")).toBe(true);
    expect(imports).toContain("stdio.h");
    expect(imports).toContain("config.h");
  });
});

// ---------------------------------------------------------------------------
// IncrementalStructuralIndex
// ---------------------------------------------------------------------------

import { IncrementalStructuralIndex } from "../src/memory/incremental-index.js";

describe("IncrementalStructuralIndex", () => {
  it("builds index from sequential file reads", () => {
    const idx = new IncrementalStructuralIndex();
    const goFile = `package main

func NewServer(port int) *Server {
    return &Server{port: port}
}

type Server struct {
    port int
}`;
    const tsFile = `export function createApp(): App {
  return new App();
}

export class App {
  start() {}
}`;
    expect(idx.ingestFileRead("cmd/main.go", goFile)).toBe(true);
    expect(idx.ingestFileRead("src/app.ts", tsFile)).toBe(true);

    const stats = idx.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.symbolCount).toBeGreaterThanOrEqual(3);
  });

  it("skips duplicate reads with same hash", () => {
    const idx = new IncrementalStructuralIndex();
    const content = `export function hello(): string { return "hi"; }`;
    expect(idx.ingestFileRead("src/hello.ts", content, "abc123")).toBe(true);
    expect(idx.ingestFileRead("src/hello.ts", content, "abc123")).toBe(false);
  });

  it("renders a compact repo map", () => {
    const idx = new IncrementalStructuralIndex();
    idx.ingestFileRead("src/config.ts", `export interface Config { port: number; }\nexport function loadConfig(): Config { return { port: 3000 }; }`);
    idx.ingestFileRead("src/server.ts", `import { Config } from "./config";\nexport function startServer(config: Config) {}`);
    const map = idx.renderMap(1000);
    expect(map).not.toBeNull();
    expect(map).toContain("STRUCTURAL_INDEX");
    expect(map).toContain("src/config.ts");
    expect(map).toContain("loadConfig");
  });

  it("generates file summaries on ingest", () => {
    const idx = new IncrementalStructuralIndex();
    idx.ingestFileRead("src/auth.ts", `export class AuthService {\n  async login(user: string) {}\n  async logout() {}\n}`);
    const summary = idx.getFileSummary("src/auth.ts");
    expect(summary).not.toBeNull();
    expect(summary).toContain("auth.ts");
    expect(summary).toContain("AuthService");
  });

  it("renders summary block within budget", () => {
    const idx = new IncrementalStructuralIndex();
    idx.ingestFileRead("a.ts", `export function a(): void {}`);
    idx.ingestFileRead("b.ts", `export function b(): void {}`);
    const block = idx.renderSummaryBlock(200);
    expect(block).not.toBeNull();
    expect(block).toContain("FILE_SUMMARIES");
  });

  it("resets cleanly", () => {
    const idx = new IncrementalStructuralIndex();
    idx.ingestFileRead("x.ts", `export function resetMe(): string {\n  return "clean";\n}`);
    expect(idx.getStats().fileCount).toBe(1);
    idx.reset();
    expect(idx.getStats().fileCount).toBe(0);
    expect(idx.renderMap(1000)).toBeNull();
  });

  it("skips files with unknown languages", () => {
    const idx = new IncrementalStructuralIndex();
    expect(idx.ingestFileRead("data.csv", "a,b,c\n1,2,3")).toBe(false);
    expect(idx.getStats().fileCount).toBe(0);
  });

  it("skips very short content", () => {
    const idx = new IncrementalStructuralIndex();
    expect(idx.ingestFileRead("x.ts", "// tiny")).toBe(false);
  });
});
