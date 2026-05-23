import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import type { GraphState } from "./state/types.js";

interface GapPayload {
  gap_id: string;
  query: string;
  task_description: string;
  collections_queried: string;
  max_score: number;
  platform_context: string;
  language: string;
  web_search_fallback: boolean;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  golang: "go",
  go: "go",
  python: "python",
  py: "python",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  rust: "rust",
  java: "java",
  csharp: "csharp",
  "c#": "csharp",
  terraform: "terraform",
  bash: "bash",
};

const LANGUAGE_HINTS: Array<{ language: string; pattern: RegExp }> = [
  { language: "go", pattern: /\b(?:golang|go\s+(?:http|service|server|context|request|module|mod|test|build|program|code)|net\/http|goroutine)\b/i },
  { language: "python", pattern: /\b(?:python|pytest|django|flask|fastapi|pydantic)\b/i },
  { language: "typescript", pattern: /\b(?:typescript|tsx|tsconfig|tsc)\b/i },
  { language: "javascript", pattern: /\b(?:javascript|node\.?js|npm|express|fastify)\b/i },
  { language: "rust", pattern: /\b(?:rust|cargo|tokio|axum|actix)\b/i },
  { language: "terraform", pattern: /\b(?:terraform|hcl|opentofu)\b/i },
  { language: "bash", pattern: /\b(?:bash|shell|zsh|sh script|shellcheck)\b/i },
];

function normalizeLanguage(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "generic" || raw === "general" || raw === "unknown") return "";
  return LANGUAGE_ALIASES[raw] ?? "";
}

export function inferKnowledgeGapMetadata(state: GraphState): { language: string; platform_context: string } {
  const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const taskFrame = (state.task_frame ?? {}) as Record<string, unknown>;
  const domainProfile = state.domain_profile;
  const domainKeys = domainProfile?.domains?.map((d) => d.key) ?? [];
  const activeDomains = Array.isArray(taxonomy.active_domains) ? taxonomy.active_domains.map(String) : [];
  const frameDomains = Array.isArray(taskFrame.domain_tags) ? taskFrame.domain_tags.map(String) : [];
  const technologies = Array.isArray(taskFrame.technologies) ? taskFrame.technologies.map(String) : [];
  const candidates = [...activeDomains, ...domainKeys, ...frameDomains, ...technologies, taxonomy.taxonomy_key];

  let language = "";
  for (const candidate of candidates) {
    language = normalizeLanguage(candidate);
    if (language) break;
  }
  if (!language) {
    const text = state.task_description ?? "";
    language = LANGUAGE_HINTS.find((hint) => hint.pattern.test(text))?.language ?? "";
  }

  const languageLike = new Set(["golang", "go", "python", "typescript", "javascript", "rust", "java", "csharp", "terraform", "bash"]);
  const platform =
    domainKeys.find((key) => key && !languageLike.has(key) && key !== "general" && key !== "generic")
    ?? activeDomains.find((key) => key && !languageLike.has(key) && key !== "general" && key !== "generic")
    ?? frameDomains.find((key) => key && !languageLike.has(key) && key !== "general" && key !== "generic")
    ?? String(taxonomy.taxonomy_key ?? "").trim();
  const platformContext = platform && platform !== "generic" && platform !== "general" && platform !== "unknown"
    ? platform.slice(0, 64)
    : "generic";

  return { language, platform_context: platformContext };
}

/**
 * Fire-and-forget POST to admin knowledge-gap ingest when the router's best
 * evidence confidence is below threshold. Mirrors the Python planner's
 * `publish_knowledge_gap` behavior without requiring a Postgres client.
 */
export function maybePublishKnowledgeGap(
  state: GraphState,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): void {
  const cfg = loadConfig();
  if (!cfg.SYNESIS_PLANNER_TS_KNOWLEDGE_BACKLOG_ENABLED) return;
  if (!cfg.SYNESIS_ADMIN_URL) return;

  const packets = state.evidence_packets ?? [];
  if (packets.length === 0) return;

  const maxConfidence = Math.max(...packets.map((p) => p.confidence));
  if (maxConfidence >= cfg.SYNESIS_PLANNER_TS_KNOWLEDGE_GAP_THRESHOLD) return;

  const query = (state.task_description ?? "").slice(0, 4096);
  if (!query) return;

  const raw = `${query.slice(0, 500)}:${Date.now()}`;
  const gapId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 64);
  const inferred = inferKnowledgeGapMetadata(state);

  const payload: GapPayload = {
    gap_id: gapId,
    query,
    task_description: query,
    collections_queried: "",
    max_score: maxConfidence,
    platform_context: inferred.platform_context,
    language: inferred.language,
    web_search_fallback: false,
  };

  const url = `${cfg.SYNESIS_ADMIN_URL.replace(/\/$/, "")}/api/v1/feedback/knowledge-gaps/ingest`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.SYNESIS_ADMIN_INTERNAL_TOKEN) {
    headers["x-synesis-service-token"] = cfg.SYNESIS_ADMIN_INTERNAL_TOKEN;
    headers["authorization"] = `Bearer ${cfg.SYNESIS_ADMIN_INTERNAL_TOKEN}`;
  }

  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`knowledge_gap_publish_failed: ${msg}`);
  });
}
