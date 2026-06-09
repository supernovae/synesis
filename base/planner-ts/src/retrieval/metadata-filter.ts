/**
 * Metadata filter builder for knowledge search endpoint.
 *
 * Constructs diagnostic boolean filter expressions from structured metadata.
 * Planner retrieval applies these fields as Cypher parameters in the NornicDB
 * graph client; this string builder remains useful for logs.
 */

import crypto from "node:crypto";

import { buildScopeFilter } from "./scope-filter.js";
import type { ScopeFilterOptions } from "./types.js";

export interface MetadataFilterParams {
  language?: string;
  artifact_kind?: string;
  domain?: string;
  corpus_class?: string;
  constraint_kind?: string;
  content_profile?: string;
  constraint_source?: string;
  golden_path_id?: string;
  scope_tags?: string[];
  tags?: string;
  content_format?: string;
  repo_path?: string;
  module_path?: string;
  symbol_name?: string;
  has_code?: boolean;
  code_language?: string;
  pack_id?: string;
  pack_ids?: string[];
  pack_version?: string;
  pack_partition?: string;
  symbol_kind?: string;
  symbol_fqn?: string;
  package_name?: string;
  perf_tier?: string;
}

type MetadataLiteralLabel =
  | "metadata"
  | "pack"
  | "tag"
  | "corpus"
  | "constraint"
  | "profile";

const SAFE_METADATA_LITERAL_RE = /^[a-z0-9_.@/+:-]+$/;
const SAFE_PACK_LITERAL_RE = /^[a-z0-9_-]+$/;

function digestLiteral(label: MetadataLiteralLabel, value: string): string {
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${label}-${digest}`;
}

function sanitize(s: string, maxLen = 64, label: MetadataLiteralLabel = "metadata"): string {
  const normalized = s.replace(/\0/g, "").trim().toLowerCase();
  if (!normalized) return "";
  if (SAFE_METADATA_LITERAL_RE.test(normalized)) return normalized.slice(0, maxLen);
  return digestLiteral(label, normalized);
}

function sanitizePackId(s: string): string {
  const normalized = s.replace(/\0/g, "").trim().toLowerCase().replace(/[./\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return "";
  if (SAFE_PACK_LITERAL_RE.test(normalized)) return normalized.slice(0, 96);
  return digestLiteral("pack", normalized);
}

export function buildMetadataFilter(params: MetadataFilterParams): string {
  const clauses: string[] = [];

  if (params.language) {
    clauses.push(`language == "${sanitize(params.language, 32)}"`);
  }
  if (params.pack_id) {
    clauses.push(`pack_id == "${sanitizePackId(params.pack_id)}"`);
  } else if (params.pack_ids?.length) {
    const ids = params.pack_ids.map((id) => sanitizePackId(id)).filter(Boolean).slice(0, 20);
    if (ids.length === 1) {
      clauses.push(`pack_id == "${ids[0]}"`);
    } else if (ids.length > 1) {
      clauses.push(`pack_id in [${ids.map((id) => `"${id}"`).join(", ")}]`);
    }
  }
  if (params.pack_version) {
    clauses.push(`pack_version == "${sanitize(params.pack_version, 64)}"`);
  }
  if (params.pack_partition) {
    clauses.push(`pack_partition == "${sanitize(params.pack_partition, 96)}"`);
  }
  if (params.symbol_kind) {
    clauses.push(`symbol_kind == "${sanitize(params.symbol_kind, 64)}"`);
  }
  if (params.symbol_fqn) {
    clauses.push(`symbol_fqn == "${sanitize(params.symbol_fqn, 256)}"`);
  }
  if (params.package_name) {
    clauses.push(`package_name == "${sanitize(params.package_name, 128)}"`);
  }
  if (params.perf_tier) {
    clauses.push(`perf_tier == "${sanitize(params.perf_tier, 64)}"`);
  }
  if (params.artifact_kind) {
    clauses.push(`artifact_kind == "${sanitize(params.artifact_kind, 32)}"`);
  }
  if (params.domain) {
    clauses.push(`domain == "${sanitize(params.domain, 64)}"`);
  }
  if (params.content_format) {
    clauses.push(`content_format == "${sanitize(params.content_format, 32)}"`);
  }
  if (params.repo_path) {
    clauses.push(`repo_path == "${sanitize(params.repo_path, 256)}"`);
  }
  if (params.module_path) {
    clauses.push(`module_path == "${sanitize(params.module_path, 256)}"`);
  }
  if (params.symbol_name) {
    clauses.push(`symbol_name == "${sanitize(params.symbol_name, 128)}"`);
  }
  if (typeof params.has_code === "boolean") {
    clauses.push(`has_code == ${params.has_code ? "true" : "false"}`);
  }
  if (params.code_language) {
    clauses.push(`code_language == "${sanitize(params.code_language, 32)}"`);
  }

  // v14 first-class columns (equality filters, indexed)
  if (params.corpus_class) {
    clauses.push(`corpus_class == "${sanitize(params.corpus_class, 32, "corpus")}"`);
  }
  if (params.constraint_kind) {
    clauses.push(`constraint_kind == "${sanitize(params.constraint_kind, 16, "constraint")}"`);
  }
  if (params.content_profile) {
    clauses.push(`content_profile == "${sanitize(params.content_profile, 32, "profile")}"`);
  }
  if (params.constraint_source) {
    clauses.push(`constraint_source == "${sanitize(params.constraint_source, 64, "constraint")}"`);
  }
  if (params.golden_path_id) {
    clauses.push(`golden_path_id == "${sanitize(params.golden_path_id, 128)}"`);
  }
  if (params.scope_tags?.length) {
    for (const tag of params.scope_tags.slice(0, 10)) {
      const safe = sanitize(tag, 64, "tag");
      if (safe) {
        clauses.push(`scope_tags like "%${safe}%"`);
      }
    }
  }
  if (params.tags) {
    clauses.push(`tags like "%${sanitize(params.tags, 128, "tag")}%"`);
  }

  if (clauses.length === 0) return "";
  return clauses.join(" and ");
}

/**
 * Combine scope/ACL filter with metadata filters into a single diagnostic
 * boolean expression. Either part may be empty.
 */
export function buildCombinedFilter(
  scopeOpts: ScopeFilterOptions | undefined,
  metaParams: MetadataFilterParams,
): string {
  const scopeExpr = buildScopeFilter(scopeOpts);
  const metaExpr = buildMetadataFilter(metaParams);

  if (scopeExpr && metaExpr) return `${scopeExpr} and ${metaExpr}`;
  return scopeExpr || metaExpr;
}

/**
 * Extract structured metadata from packed tags.
 * Tags are comma-separated; prefixed entries like "corpus_class:X",
 * "ck:X", "scope:X", "content_profile:X" are parsed into typed fields.
 * Prefer first-class graph properties over these tag-parsed values.
 */
export function extractTagMetadata(tags: string): {
  corpus_class: string;
  constraint_kind: string;
  scope_tags: string[];
  content_profile: string;
} {
  const result = { corpus_class: "", constraint_kind: "", scope_tags: [] as string[], content_profile: "" };
  if (!tags) return result;

  for (const part of tags.split(",")) {
    const t = part.trim();
    if (t.startsWith("corpus_class:")) {
      result.corpus_class = sanitize(t.slice("corpus_class:".length), 32, "corpus");
    } else if (t.startsWith("ck:")) {
      result.constraint_kind = sanitize(t.slice("ck:".length), 16, "constraint");
    } else if (t.startsWith("scope:")) {
      const safeTag = sanitize(t.slice("scope:".length), 64, "tag");
      if (safeTag) result.scope_tags.push(safeTag);
    } else if (t.startsWith("content_profile:")) {
      result.content_profile = sanitize(t.slice("content_profile:".length), 32, "profile");
    }
  }
  return result;
}
