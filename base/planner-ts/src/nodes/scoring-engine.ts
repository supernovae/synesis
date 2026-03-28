/**
 * YAML-driven complexity scorer — split axes: complexity, risk, domain.
 *
 * Ports the Python ScoringEngine from entry_classifier_engine.py with
 * BM25-inspired intent classification, brevity weights, risk veto, and
 * deliverable counting.
 *
 * When the OntologyStore is available (Phase 1 live merge), ScoringEngine
 * receives its config from the merged snapshot. Falls back to embedded
 * defaults when no YAML files are present.
 */

import type { MergedOntologySnapshot } from "../ontology/merge-plugins.js";

type TaskSize = "easy" | "medium" | "hard";

interface WeightEntry {
  weight: number;
  keywords: string[];
}

interface DomainEntry {
  domain: string;
  keywords: string[];
  minHits: number;
}

interface IntentClassEntry {
  keywords: string[];
  inherentlyDocument?: boolean;
  criticBehaviorBlock?: string;
}

export interface PairingRule {
  keywords: string[];
  extra_weight: number;
  axis: "risk" | "complexity";
  domain?: string;
}

export interface ScoringConfig {
  thresholds: {
    easyMax: number;
    mediumMax: number;
    densityThreshold: number;
    densityTax: number;
    riskHigh: number;
    maxEasyMessageLength: number;
  };
  routingThresholds: {
    bypassSupervisorBelow: number;
    planRequiredAbove: number;
    criticRequiredAbove: number;
    trivialBelow: number;
  };
  complexityWeights: Record<string, WeightEntry>;
  riskWeights: Record<string, WeightEntry>;
  domainKeywords: Record<string, DomainEntry>;
  brevityWeights: Record<string, WeightEntry>;
  intentClasses: Record<string, IntentClassEntry>;
  riskVetoTriggers: string[];
  overrides: Record<string, string[]>;
  pairings?: PairingRule[];
}

/** Build a ScoringConfig from MergedOntologySnapshot. */
export function scoringConfigFromSnapshot(snap: MergedOntologySnapshot): ScoringConfig {
  const domainKeywords: Record<string, DomainEntry> = {};
  for (const [k, v] of Object.entries(snap.domainKeywords)) {
    domainKeywords[k] = { domain: v.domain, keywords: v.keywords, minHits: v.minHits ?? 1 };
  }
  return {
    thresholds: snap.thresholds as ScoringConfig["thresholds"],
    routingThresholds: snap.routingThresholds as ScoringConfig["routingThresholds"],
    complexityWeights: snap.complexityWeights,
    riskWeights: snap.riskWeights,
    domainKeywords,
    brevityWeights: snap.brevityWeights,
    intentClasses: snap.intentClasses,
    riskVetoTriggers: snap.riskVetoTriggers,
    overrides: snap.overrides,
    pairings: snap.pairings,
  };
}

export interface ScoringResult {
  taskSize: TaskSize;
  score: number;
  complexityScore: number;
  riskScore: number;
  brevityScore: number;
  difficulty: number;
  explicitDeliverables: number;
  domainHints: string[];
  intentClass: string;
  planSession: boolean;
  classificationHits: string[];
  scoreBreakdown: Record<string, number>;
  activeDomains: string[];
  domainRefCounts: Record<string, number>;
  routingThresholds: {
    bypassSupervisorBelow: number;
    planRequiredAbove: number;
    criticRequiredAbove: number;
  };
}

// BM25 parameters matching Python
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_AVG_DL = 50;

const CODE_INTENTS = new Set([
  "debugging", "review", "code_generation", "data_transform",
  "tool_orchestrated", "migration", "documentation",
]);

const NUMBERED_ITEM_RE = /^\s*\d+[.)]\s/gm;
const DASH_BULLET_RE = /^\s*[-*]\s+\S/gm;
const ACTION_VERB_RE = /^\s*[-*]?\s*(?:state|propose|explain|describe|list|give|show|provide|outline|define|identify|compare|evaluate|recommend|summarize|discuss|design|analyze|assess|justify|prioritize)\b/gim;

function countDeliverables(text: string): number {
  const numbered = (text.match(NUMBERED_ITEM_RE) ?? []).length;
  const dashed = (text.match(DASH_BULLET_RE) ?? []).length;
  const actionVerbs = (text.match(ACTION_VERB_RE) ?? []).length;
  return Math.max(numbered, dashed, actionVerbs);
}

function buildWordPattern(keywords: string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(" + escaped.join("|") + ")\\b", "gi");
}

// ---------------------------------------------------------------------------
// Embedded weights (from intent_weights.yaml core categories)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ScoringConfig = {
  thresholds: {
    easyMax: 4,
    mediumMax: 15,
    densityThreshold: 3,
    densityTax: 10,
    riskHigh: 15,
    maxEasyMessageLength: 200,
  },
  routingThresholds: {
    bypassSupervisorBelow: 0.2,
    planRequiredAbove: 0.7,
    criticRequiredAbove: 0.6,
    trivialBelow: 0.15,
  },
  complexityWeights: {
    create_basic:     { weight: 1, keywords: ["create a script", "create a simple script", "write a script", "create a file", "quick script"] },
    parse_basic:      { weight: 1, keywords: ["parse json", "parse csv", "read file and print"] },
    unit_test_basic:  { weight: 1, keywords: ["add test", "basic test", "test for"] },
    io_basic:         { weight: 1, keywords: ["print", "echo", "log", "hello", "console", "display", "show", "stdout", "output"] },
    logic_basic:      { weight: 2, keywords: ["math", "sum", "count", "calculate", "loop", "sort", "reverse", "basic", "simple", "minimal", "factorial", "fibonacci"] },
    query_basic:      { weight: 2, keywords: ["what is", "how do i", "example of", "syntax for", "quick example"] },
    data_manipulation:{ weight: 5, keywords: ["parse", "json", "csv", "yaml", "xml", "regex", "base64", "convert", "transform", "filter", "reduce", "serialize"] },
    local_persistence:{ weight: 8, keywords: ["file", "directory", "folder", "read file", "write file", "save", "load", "filesystem"] },
    networking:       { weight: 8, keywords: ["http", "request", "api", "rest", "server", "port", "socket", "endpoint", "fetch", "websocket"] },
    os_system:        { weight: 8, keywords: ["process", "thread", "exec", "shell", "env", "systemd", "cron", "service", "daemon", "subprocess"] },
    error_handling:   { weight: 5, keywords: ["try", "catch", "exception", "error handling", "retry", "fallback", "graceful"] },
    testing:          { weight: 5, keywords: ["test", "testing", "unit test", "integration test", "mock", "assert", "coverage"] },
    architecture:     { weight: 12, keywords: ["architecture", "design", "microservice", "distributed", "event driven", "cqrs", "domain driven", "system design"] },
    multi_file:       { weight: 10, keywords: ["multiple files", "refactor", "restructure", "reorganize", "extract", "split into", "merge into"] },
    database:         { weight: 10, keywords: ["database", "sql", "query", "migration", "schema", "index", "transaction", "join", "foreign key"] },
    devops:           { weight: 10, keywords: ["ci/cd", "pipeline", "deploy", "kubernetes", "docker", "container", "helm", "terraform", "monitoring"] },
    security:         { weight: 10, keywords: ["security", "authentication", "authorization", "rbac", "encryption", "tls", "certificate", "oauth", "jwt"] },
    ml_ai:            { weight: 12, keywords: ["model", "training", "embedding", "inference", "transformer", "fine-tune", "neural", "bert", "gpt", "rag"] },
  },
  riskWeights: {
    destructive:   { weight: 20, keywords: ["delete all", "drop table", "wipe", "rm -rf", "destroy", "purge all"] },
    credentials:   { weight: 15, keywords: ["password", "secret", "token", "api key", "credential", "private key"] },
    compliance:    { weight: 15, keywords: ["hipaa", "phi", "pci", "gdpr", "sox", "compliance", "audit trail"] },
    production:    { weight: 10, keywords: ["production", "prod", "live", "customer data", "real users"] },
    infrastructure:{ weight: 10, keywords: ["migration", "rollback", "upgrade cluster", "scale down"] },
  },
  domainKeywords: {
    kubernetes:   { domain: "kubernetes", keywords: ["kubernetes", "k8s", "kubectl", "pod", "deployment", "service mesh", "istio", "helm", "kustomize"], minHits: 1 },
    openshift:    { domain: "openshift", keywords: ["openshift", "okd", "oc", "route", "buildconfig", "deploymentconfig"], minHits: 1 },
    cloud_aws:    { domain: "aws", keywords: ["aws", "ec2", "s3", "lambda", "cloudformation", "iam", "dynamodb", "sqs", "eks"], minHits: 1 },
    cloud_gcp:    { domain: "gcp", keywords: ["gcp", "google cloud", "compute engine", "cloud run", "bigquery", "gke"], minHits: 1 },
    cloud_azure:  { domain: "azure", keywords: ["azure", "arm template", "azure devops", "aks", "cosmos db"], minHits: 1 },
    python:       { domain: "python", keywords: ["python", "pip", "pytest", "django", "flask", "fastapi", "pydantic"], minHits: 1 },
    typescript:   { domain: "typescript", keywords: ["typescript", "ts", "tsx", "node.js", "nodejs", "express", "fastify", "npm"], minHits: 1 },
    react:        { domain: "react", keywords: ["react", "jsx", "next.js", "nextjs", "remix", "react native"], minHits: 1 },
    rust:         { domain: "rust", keywords: ["rust", "cargo", "tokio", "async-std", "wasm"], minHits: 1 },
    go:           { domain: "go", keywords: ["golang", "go", "goroutine", "gin", "echo framework"], minHits: 2 },
  },
  brevityWeights: {
    snippet_cue: { weight: -4, keywords: ["snippet", "code snippet", "show me a snippet"] },
    brevity_cue: { weight: -3, keywords: ["brief", "briefly", "quick", "quickly", "short", "concise", "terse"] },
    minimal_cue: { weight: -3, keywords: ["minimal", "minimal example", "quick example", "just the code", "just show me", "one-liner", "bare minimum"] },
    simple_cue:  { weight: -2, keywords: ["simple", "simple example", "basic example", "straightforward"] },
  },
  intentClasses: {
    conversation: { keywords: ["hi", "hello", "hey", "what can you do", "thanks", "ok", "got it"], inherentlyDocument: true },
    knowledge:    { keywords: ["explain", "what is", "how does", "describe", "overview", "summary", "define", "difference between", "compare"] },
    writing:      { keywords: ["write", "draft", "compose", "essay", "article", "email", "letter", "blog post", "creative"] },
    code:         { keywords: ["code", "implement", "function", "class", "method", "script", "program", "algorithm", "snippet", "build"] },
    debugging:    { keywords: ["fix", "debug", "error", "trace", "why does it fail", "stack trace", "diagnose", "troubleshoot"] },
    review:       { keywords: ["review", "validate", "audit", "check", "assess", "code review", "security audit"] },
    planning:     { keywords: ["plan", "strategy", "design", "architecture", "break down", "decompose", "training plan", "schedule"] },
    data_transform:{ keywords: ["parse", "convert", "transform", "format", "extract", "restructure", "schema", "csv to json", "json to yaml"] },
    tool_orchestrated:{ keywords: ["search and", "find and", "multi-step", "pipeline", "workflow", "chain", "orchestrate"] },
  },
  riskVetoTriggers: [
    "pip install", "pip3 install", "npm install", "yarn add", "pnpm add", "go get",
    "cargo add", "curl |", "wget |", "| bash", "| sh", "chmod +x", "rm -rf", "dd if=",
  ],
  overrides: {
    plan_session: ["[STRICT]", "/plan", "/manual", "/strict", "@plan", "plan first", "break it down"],
  },
};

// ---------------------------------------------------------------------------
// ScoringEngine
// ---------------------------------------------------------------------------

export class ScoringEngine {
  private config: ScoringConfig;
  private complexityPatterns: Map<string, { weight: number; pattern: RegExp }>;
  private riskPatterns: Map<string, { weight: number; pattern: RegExp }>;
  private domainPatterns: Map<string, { domain: string; pattern: RegExp; minHits: number }>;
  private brevityPatterns: Map<string, { weight: number; pattern: RegExp }>;

  constructor(config?: Partial<ScoringConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.complexityPatterns = new Map();
    for (const [cat, entry] of Object.entries(this.config.complexityWeights)) {
      this.complexityPatterns.set(cat, { weight: entry.weight, pattern: buildWordPattern(entry.keywords) });
    }

    this.riskPatterns = new Map();
    for (const [cat, entry] of Object.entries(this.config.riskWeights)) {
      this.riskPatterns.set(cat, { weight: entry.weight, pattern: buildWordPattern(entry.keywords) });
    }

    this.domainPatterns = new Map();
    for (const [cat, entry] of Object.entries(this.config.domainKeywords)) {
      this.domainPatterns.set(cat, { domain: entry.domain, pattern: buildWordPattern(entry.keywords), minHits: entry.minHits });
    }

    this.brevityPatterns = new Map();
    for (const [cat, entry] of Object.entries(this.config.brevityWeights)) {
      this.brevityPatterns.set(cat, { weight: entry.weight, pattern: buildWordPattern(entry.keywords) });
    }
  }

  private checkOverride(text: string, name: string): boolean {
    const triggers = this.config.overrides[name] ?? [];
    const lower = text.toLowerCase();
    return triggers.some((t) => lower.includes(t.toLowerCase()));
  }

  private checkRiskVeto(text: string): boolean {
    const lower = text.slice(0, 800).toLowerCase();
    return this.config.riskVetoTriggers.some((t) => lower.includes(t.toLowerCase()));
  }

  analyze(text: string): ScoringResult {
    const t = (text ?? "").trim().slice(0, 800);
    if (!t) return emptyResult(this.config.routingThresholds);

    if (this.checkOverride(t, "plan_session")) {
      return {
        ...emptyResult(this.config.routingThresholds),
        taskSize: "hard",
        score: 99,
        riskScore: 99,
        difficulty: 1.0,
        intentClass: "planning",
        planSession: true,
        classificationHits: ["plan_session"],
        scoreBreakdown: { plan_session: 99 },
      };
    }

    const lower = t.toLowerCase();
    const hits: string[] = [];
    const breakdown: Record<string, number> = {};
    const activeDomains: string[] = [];
    const domainRefCounts: Record<string, number> = {};
    let hitsByCategory: Record<string, string[]> = {};

    // 1. Complexity
    let complexityScore = 0;
    for (const [cat, { weight, pattern }] of this.complexityPatterns) {
      pattern.lastIndex = 0;
      const matches = lower.match(pattern);
      if (matches) {
        complexityScore += weight;
        hits.push(`${cat}(+${weight})`);
        hitsByCategory[cat] = [...new Set(matches)];
        breakdown[cat] = (breakdown[cat] ?? 0) + weight;
      }
    }

    // 2. Risk
    let riskScore = 0;
    for (const [cat, { weight, pattern }] of this.riskPatterns) {
      pattern.lastIndex = 0;
      const matches = lower.match(pattern);
      if (matches) {
        riskScore += weight;
        hits.push(`${cat}(+${weight})`);
        breakdown[`risk_${cat}`] = (breakdown[`risk_${cat}`] ?? 0) + weight;
      }
    }

    // 3. Domain
    const domainHints: string[] = [];
    for (const [cat, { domain, pattern, minHits }] of this.domainPatterns) {
      pattern.lastIndex = 0;
      const matches = lower.match(pattern) ?? [];
      if (new Set(matches).size >= minHits) {
        domainHints.push(cat);
        if (domain) {
          domainRefCounts[domain] = (domainRefCounts[domain] ?? 0) + 1;
          if (!activeDomains.includes(domain)) activeDomains.push(domain);
        }
        hits.push(`domain:${cat}`);
      }
    }

    // 4. Pairings: keyword co-occurrence rules that boost risk/complexity
    //    and can inject additional active domains (multidimensional signal).
    for (const pair of (this.config.pairings ?? [])) {
      const kwList = pair.keywords;
      if (!kwList || kwList.length === 0) continue;
      const allPresent = kwList.every((kw) => {
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        return re.test(lower);
      });
      if (!allPresent) continue;
      const extra = pair.extra_weight;
      const pairKey = `pairing(${kwList.join("+")})`;
      hits.push(`${pairKey}(+${extra})`);
      breakdown[pairKey] = (breakdown[pairKey] ?? 0) + extra;
      if (pair.axis === "complexity") {
        complexityScore += extra;
      } else {
        riskScore += extra;
      }
      const domain = pair.domain;
      if (domain && domain.trim()) {
        const d = domain.trim();
        domainRefCounts[d] = (domainRefCounts[d] ?? 0) + 1;
        if (!activeDomains.includes(d)) activeDomains.push(d);
      }
    }

    // 5. Density tax
    const heavyCategories = Object.keys(hitsByCategory).filter(
      (c) => this.complexityPatterns.has(c) && (this.complexityPatterns.get(c)!.weight > 2),
    );
    if (heavyCategories.length >= this.config.thresholds.densityThreshold) {
      complexityScore += this.config.thresholds.densityTax;
      hits.push(`density_tax(+${this.config.thresholds.densityTax})`);
      breakdown.density_tax = this.config.thresholds.densityTax;
    }

    // 6. Brevity
    let brevityScore = 0;
    for (const [cat, { weight, pattern }] of this.brevityPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lower)) {
        brevityScore += Math.abs(weight);
        complexityScore = Math.max(0, complexityScore + weight);
        hits.push(`brevity:${cat}(${weight})`);
        breakdown[`brevity_${cat}`] = weight;
      }
    }

    // 7. Deliverable bonus
    const deliverables = countDeliverables(t);
    if (deliverables > 3) {
      const bonus = (deliverables - 3) * 2;
      complexityScore += bonus;
      hits.push(`deliverable_bonus(+${bonus})`);
      breakdown.deliverable_bonus = bonus;
    }

    // 8. Task size
    const th = this.config.thresholds;
    let taskSize: TaskSize;
    if (riskScore >= th.riskHigh) {
      taskSize = "hard";
    } else if (complexityScore <= th.easyMax) {
      if (this.checkRiskVeto(t)) {
        taskSize = "medium";
        hits.push("risk_veto(easy_blocked)");
      } else if (t.length > th.maxEasyMessageLength) {
        taskSize = "medium";
        hits.push(`length_veto(>${th.maxEasyMessageLength})`);
      } else {
        taskSize = "easy";
      }
    } else if (complexityScore <= th.mediumMax) {
      taskSize = "medium";
    } else {
      taskSize = "hard";
    }

    // 9. Intent class (BM25 scoring)
    const docLen = Math.max(1, lower.split(/\s+/).length);
    const intents = this.config.intentClasses;
    const nIntents = Math.max(1, Object.keys(intents).length);

    const kwIntentCount = new Map<string, number>();
    for (const data of Object.values(intents)) {
      const seen = new Set<string>();
      for (const kw of data.keywords) {
        const kwl = kw.toLowerCase();
        if (!seen.has(kwl)) {
          kwIntentCount.set(kwl, (kwIntentCount.get(kwl) ?? 0) + 1);
          seen.add(kwl);
        }
      }
    }

    const lenNorm = 1.0 - BM25_B + BM25_B * (docLen / BM25_AVG_DL);
    const intentScores = new Map<string, number>();

    for (const [name, data] of Object.entries(intents)) {
      let score = 0;
      for (const kw of data.keywords) {
        const kwRe = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        const tf = (lower.match(kwRe) ?? []).length;
        if (tf > 0) {
          const nContaining = kwIntentCount.get(kw.toLowerCase()) ?? 1;
          const idf = Math.log((nIntents - nContaining + 0.5) / (nContaining + 0.5) + 1.0);
          const satTf = (tf * (BM25_K1 + 1.0)) / (tf + BM25_K1 * lenNorm);
          score += idf * satTf;
        }
      }
      if (score > 0) intentScores.set(name, score);
    }

    let intentClass = "general";
    if (intentScores.size > 0) {
      const best = Math.max(...intentScores.values());
      const threshold = best * 0.9;
      const candidates = [...intentScores.entries()]
        .filter(([, s]) => s >= threshold)
        .map(([n]) => n);
      const codeCandidates = candidates.filter((c) => CODE_INTENTS.has(c));
      intentClass = codeCandidates[0] ?? candidates[0] ?? "general";
      hits.push(`intent:${intentClass}(bm25=${intentScores.get(intentClass)?.toFixed(2)})`);
    }

    // 9b. Complexity exemption for non-code intents
    if (!CODE_INTENTS.has(intentClass)) {
      for (const exempt of ["io_basic", "query_basic"]) {
        if (breakdown[exempt]) {
          complexityScore = Math.max(0, complexityScore - breakdown[exempt]);
          hits.push(`complexity_exempt:${exempt}(-${breakdown[exempt]})`);
        }
      }
      if (complexityScore <= th.easyMax) taskSize = "easy";
      else if (complexityScore <= th.mediumMax) taskSize = "medium";
    }

    const difficulty = Math.min(1.0, complexityScore / Math.max(1, th.mediumMax * 2));

    return {
      taskSize,
      score: complexityScore + riskScore,
      complexityScore,
      riskScore,
      brevityScore,
      difficulty,
      explicitDeliverables: deliverables,
      domainHints,
      intentClass,
      planSession: false,
      classificationHits: hits,
      scoreBreakdown: breakdown,
      activeDomains,
      domainRefCounts,
      routingThresholds: {
        bypassSupervisorBelow: this.config.routingThresholds.bypassSupervisorBelow,
        planRequiredAbove: this.config.routingThresholds.planRequiredAbove,
        criticRequiredAbove: this.config.routingThresholds.criticRequiredAbove,
      },
    };
  }
}

function emptyResult(rt: ScoringConfig["routingThresholds"]): ScoringResult {
  return {
    taskSize: "medium",
    score: 0,
    complexityScore: 0,
    riskScore: 0,
    brevityScore: 0,
    difficulty: 0,
    explicitDeliverables: 0,
    domainHints: [],
    intentClass: "code",
    planSession: false,
    classificationHits: [],
    scoreBreakdown: {},
    activeDomains: [],
    domainRefCounts: {},
    routingThresholds: {
      bypassSupervisorBelow: rt.bypassSupervisorBelow,
      planRequiredAbove: rt.planRequiredAbove,
      criticRequiredAbove: rt.criticRequiredAbove,
    },
  };
}

let _engine: ScoringEngine | null = null;

export function getScoringEngine(): ScoringEngine {
  if (!_engine) _engine = new ScoringEngine();
  return _engine;
}

/**
 * Build the scoring engine from an OntologySnapshot.
 * Called once at startup by the entry classifier when live merge is active.
 */
export function initScoringEngineFromSnapshot(snap: MergedOntologySnapshot): ScoringEngine {
  _engine = new ScoringEngine(scoringConfigFromSnapshot(snap));
  return _engine;
}

export function resetScoringEngine(): void {
  _engine = null;
}
