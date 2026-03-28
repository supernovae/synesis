/**
 * Ontology merge — ports Python plugin_weight_loader.py.
 *
 * Loads core intent_weights.yaml + all enabled plugins/weights/*.yaml,
 * merges complexity_weights, risk_weights, domain_keywords, intent_classes,
 * pairings, overrides, thresholds, risk_veto_triggers, and vertical_prompts
 * into a single MergedOntologySnapshot.
 *
 * Merge runs at startup + optional periodic refresh — not per request.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeightEntry {
  weight: number;
  keywords: string[];
  domain?: string;
  min_hits?: number;
  minHits?: number;
}

export interface DomainEntry {
  domain: string;
  keywords: string[];
  min_hits?: number;
  minHits?: number;
}

export interface IntentClassEntry {
  keywords: string[];
  inherentlyDocument?: boolean;
  criticBehaviorBlock?: string;
}

export interface PairingEntry {
  keywords: string[];
  extra_weight: number;
  axis: "risk" | "complexity";
  domain?: string;
}

export interface VerticalPrompt {
  name: string;
  active_domain_refs?: string[];
  platform_context_aliases?: string[];
  worker_persona_block?: string;
  planner_decomposition_rules?: string;
  critic_mode?: string;
  critic_tiers?: Record<string, string>;
  compliance_signals?: Record<string, string>;
  compliance_trigger_keywords?: Record<string, string[]>;
}

export interface MergedOntologySnapshot {
  complexityWeights: Record<string, WeightEntry>;
  riskWeights: Record<string, WeightEntry>;
  domainKeywords: Record<string, DomainEntry>;
  intentClasses: Record<string, IntentClassEntry>;
  pairings: PairingEntry[];
  overrides: Record<string, string[]>;
  thresholds: Record<string, unknown>;
  routingThresholds: Record<string, number>;
  brevityWeights: Record<string, WeightEntry>;
  riskVetoTriggers: string[];
  verticalPrompts: Record<string, VerticalPrompt>;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function loadYaml(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractOntology(raw: Record<string, unknown>): Record<string, unknown> {
  const ont = raw.ontology;
  if (ont && typeof ont === "object" && !Array.isArray(ont) && "v3" in (ont as Record<string, unknown>)) {
    const v3 = (ont as Record<string, unknown>).v3;
    return (v3 && typeof v3 === "object" ? v3 : raw) as Record<string, unknown>;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Merge primitives (match Python semantics exactly)
// ---------------------------------------------------------------------------

function mergeWeights(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...overlay };
}

function mergeOverrides(
  base: Record<string, string[]>,
  overlay: Record<string, string[]>,
): Record<string, string[]> {
  const result = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (Array.isArray(v)) {
      result[k] = [...(result[k] ?? []), ...v];
    }
  }
  return result;
}

function mergeThresholds(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v != null) result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Normalizers: YAML snake_case → TS camelCase where needed
// ---------------------------------------------------------------------------

function normalizeDomainKeywords(
  raw: Record<string, unknown>,
): Record<string, DomainEntry> {
  const out: Record<string, DomainEntry> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const entry = val as Record<string, unknown>;
    out[key] = {
      domain: String(entry.domain ?? key),
      keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
      minHits: Number(entry.min_hits ?? entry.minHits ?? 1),
    };
  }
  return out;
}

function normalizeWeights(raw: Record<string, unknown>): Record<string, WeightEntry> {
  const out: Record<string, WeightEntry> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const entry = val as Record<string, unknown>;
    out[key] = {
      weight: Number(entry.weight ?? 0),
      keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
    };
  }
  return out;
}

function normalizeIntentClasses(raw: Record<string, unknown>): Record<string, IntentClassEntry> {
  const out: Record<string, IntentClassEntry> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const entry = val as Record<string, unknown>;
    out[key] = {
      keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
      inherentlyDocument: Boolean(entry.inherently_document ?? entry.inherentlyDocument),
      criticBehaviorBlock: entry.critic_behavior_block
        ? String(entry.critic_behavior_block)
        : undefined,
    };
  }
  return out;
}

function normalizePairings(raw: unknown): PairingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => p && typeof p === "object")
    .map((p) => ({
      keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
      extra_weight: Number(p.extra_weight ?? 0),
      axis: (p.axis === "complexity" ? "complexity" : "risk") as "risk" | "complexity",
      domain: typeof p.domain === "string" ? p.domain.trim() : undefined,
    }));
}

function normalizeOverrides(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? v.map(String) : [];
  }
  return out;
}

function normalizeVerticalPrompt(raw: unknown): VerticalPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const vp = raw as Record<string, unknown>;
  const name = String(vp.name ?? "");
  if (!name) return null;
  return {
    name,
    active_domain_refs: Array.isArray(vp.active_domain_refs)
      ? vp.active_domain_refs.map(String)
      : [],
    platform_context_aliases: Array.isArray(vp.platform_context_aliases)
      ? vp.platform_context_aliases.map(String)
      : [],
    worker_persona_block: vp.worker_persona_block ? String(vp.worker_persona_block).trim() : undefined,
    planner_decomposition_rules: vp.planner_decomposition_rules
      ? String(vp.planner_decomposition_rules).trim()
      : undefined,
    critic_mode: vp.critic_mode ? String(vp.critic_mode).trim() : undefined,
    critic_tiers: vp.critic_tiers && typeof vp.critic_tiers === "object"
      ? Object.fromEntries(
          Object.entries(vp.critic_tiers as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "").trim()]),
        )
      : undefined,
    compliance_signals: vp.compliance_signals && typeof vp.compliance_signals === "object"
      ? Object.fromEntries(
          Object.entries(vp.compliance_signals as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
        )
      : undefined,
    compliance_trigger_keywords: vp.compliance_trigger_keywords && typeof vp.compliance_trigger_keywords === "object"
      ? Object.fromEntries(
          Object.entries(vp.compliance_trigger_keywords as Record<string, unknown>).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.map(String) : [],
          ]),
        )
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Core merge: loadConfigWithPlugins
// ---------------------------------------------------------------------------

export function loadConfigWithPlugins(
  corePath?: string,
  pluginDir?: string,
): MergedOntologySnapshot {
  const effectiveCorePath = corePath
    ?? process.env.SYNESIS_ENTRY_CLASSIFIER_WEIGHTS
    ?? "";

  const resolvedCore = resolveCorePath(effectiveCorePath);
  const resolvedPluginDir = resolvePluginDir(pluginDir);

  const raw = resolvedCore ? loadYaml(resolvedCore) : {};
  const merged = extractOntology(raw);

  let complexityWeights = merged.complexity_weights ?? {};
  let riskWeights = merged.risk_weights ?? {};
  let domainKeywords = merged.domain_keywords ?? {};
  let intentClasses = merged.intent_classes ?? {};
  let pairings = Array.isArray(merged.pairings) ? [...merged.pairings] : [];
  let overrides = merged.overrides ?? {};
  let thresholds = merged.thresholds ?? {};
  const routingThresholds = (merged.routing_thresholds ?? {}) as Record<string, unknown>;
  const brevityWeights = merged.brevity_weights ?? {};
  let riskVetoTriggers = Array.isArray(merged.risk_veto_triggers)
    ? [...merged.risk_veto_triggers]
    : [];
  const verticalPrompts: Record<string, VerticalPrompt> = {};

  // Plugin enable filter
  const compose = (merged.compose ?? {}) as Record<string, unknown>;
  let enabled: string[] | null = Array.isArray(compose.enabled_plugins)
    ? compose.enabled_plugins.map(String)
    : null;
  if (enabled === null) {
    const envPlugins = process.env.SYNESIS_ENTRY_CLASSIFIER_PLUGINS;
    enabled = envPlugins ? envPlugins.split(",").map((s) => s.trim()) : null;
  }

  if (resolvedPluginDir && existsSync(resolvedPluginDir)) {
    const files = readdirSync(resolvedPluginDir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();

    for (const file of files) {
      if (file.includes("intent_weights") || file.includes("entry_classifier_weights")) continue;
      const stem = basename(file, ".yaml");
      if (enabled !== null && !enabled.includes(stem)) continue;

      const plugRaw = loadYaml(join(resolvedPluginDir, file));
      if (!plugRaw || Object.keys(plugRaw).length === 0) continue;
      const plug = extractOntology(plugRaw);

      if (plug.complexity_weights && typeof plug.complexity_weights === "object") {
        complexityWeights = mergeWeights(complexityWeights as Record<string, unknown>, plug.complexity_weights as Record<string, unknown>);
      }
      if (plug.risk_weights && typeof plug.risk_weights === "object") {
        riskWeights = mergeWeights(riskWeights as Record<string, unknown>, plug.risk_weights as Record<string, unknown>);
      }
      if (plug.domain_keywords && typeof plug.domain_keywords === "object") {
        domainKeywords = mergeWeights(domainKeywords as Record<string, unknown>, plug.domain_keywords as Record<string, unknown>);
      }
      if (Array.isArray(plug.pairings)) {
        pairings = [...pairings, ...plug.pairings];
      }
      if (plug.overrides && typeof plug.overrides === "object") {
        overrides = mergeOverrides(
          overrides as Record<string, string[]>,
          plug.overrides as Record<string, string[]>,
        );
      }
      if (plug.thresholds && typeof plug.thresholds === "object") {
        thresholds = mergeThresholds(
          thresholds as Record<string, unknown>,
          plug.thresholds as Record<string, unknown>,
        );
      }
      if (Array.isArray(plug.risk_veto_triggers)) {
        riskVetoTriggers = [...riskVetoTriggers, ...plug.risk_veto_triggers.map(String)];
      }
      if (plug.intent_classes && typeof plug.intent_classes === "object") {
        intentClasses = mergeWeights(intentClasses as Record<string, unknown>, plug.intent_classes as Record<string, unknown>);
      }
      if (plug.vertical_prompt) {
        const vp = normalizeVerticalPrompt(plug.vertical_prompt);
        if (vp) verticalPrompts[vp.name] = vp;
      }
    }
  }

  const th = thresholds as Record<string, unknown>;
  const rt = routingThresholds as Record<string, unknown>;

  return {
    complexityWeights: normalizeWeights(complexityWeights as Record<string, unknown>),
    riskWeights: normalizeWeights(riskWeights as Record<string, unknown>),
    domainKeywords: normalizeDomainKeywords(domainKeywords as Record<string, unknown>),
    intentClasses: normalizeIntentClasses(intentClasses as Record<string, unknown>),
    pairings: normalizePairings(pairings),
    overrides: normalizeOverrides(overrides),
    thresholds: {
      easyMax: Number(th.easy_max ?? 4),
      mediumMax: Number(th.medium_max ?? 15),
      densityThreshold: Number(th.density_threshold ?? 3),
      densityTax: Number(th.density_tax ?? 10),
      riskHigh: Number(th.risk_high ?? 15),
      maxEasyMessageLength: Number(th.max_easy_message_length ?? 200),
    },
    routingThresholds: {
      bypassSupervisorBelow: Number(rt.bypass_supervisor_below ?? 0.2),
      planRequiredAbove: Number(rt.plan_required_above ?? 0.7),
      criticRequiredAbove: Number(rt.critic_required_above ?? 0.6),
      trivialBelow: Number(rt.trivial_below ?? 0.15),
    },
    brevityWeights: normalizeWeights(brevityWeights as Record<string, unknown>),
    riskVetoTriggers: riskVetoTriggers.map(String),
    verticalPrompts,
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveCorePath(input: string): string | null {
  if (input && existsSync(input)) return input;
  // Look relative to planner content (shipped in image)
  const candidates = [
    resolve(process.cwd(), "base/planner/intent_weights.yaml"),
    resolve(process.cwd(), "intent_weights.yaml"),
    resolve(__dirname, "../../intent_weights.yaml"),
    resolve(__dirname, "../../../intent_weights.yaml"),
    resolve(__dirname, "../../../../base/planner/intent_weights.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolvePluginDir(input?: string): string | null {
  const dir = input ?? process.env.SYNESIS_PLANNER_TS_PLUGIN_WEIGHTS_DIR ?? "";
  if (dir && existsSync(dir)) return dir;
  const candidates = [
    resolve(process.cwd(), "base/planner/plugins/weights"),
    resolve(process.cwd(), "plugins/weights"),
    resolve(__dirname, "../../plugins/weights"),
    resolve(__dirname, "../../../plugins/weights"),
    resolve(__dirname, "../../../../base/planner/plugins/weights"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OntologyStore singleton
// ---------------------------------------------------------------------------

let _snapshot: MergedOntologySnapshot | null = null;
let _lastRefresh = 0;
const DEFAULT_REFRESH_S = 300;

export function getOntologySnapshot(): MergedOntologySnapshot {
  const refreshS = Number(process.env.SYNESIS_ONTOLOGY_REFRESH_S ?? DEFAULT_REFRESH_S);
  const now = Date.now() / 1000;
  if (_snapshot && (now - _lastRefresh) < refreshS) return _snapshot;
  _snapshot = loadConfigWithPlugins();
  _lastRefresh = now;
  return _snapshot;
}

export function refreshOntology(): MergedOntologySnapshot {
  _snapshot = loadConfigWithPlugins();
  _lastRefresh = Date.now() / 1000;
  return _snapshot;
}

/** Reset for testing. */
export function resetOntologyStore(): void {
  _snapshot = null;
  _lastRefresh = 0;
}
