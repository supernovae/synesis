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

  const payload: GapPayload = {
    gap_id: gapId,
    query,
    task_description: query,
    collections_queried: "",
    max_score: maxConfidence,
    platform_context: "generic",
    language: "python",
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
