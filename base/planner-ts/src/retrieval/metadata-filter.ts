/**
 * Metadata filter builder for knowledge search endpoint.
 *
 * Constructs Milvus boolean filter expressions from structured metadata
 * parameters. With schema v14, corpus_class, constraint_kind, content_profile,
 * and scope_tags are first-class columns with equality/like filters.
 * The tags column remains for backward compatibility with pre-v14 data;
 * extractTagMetadata parses it as a fallback.
 */

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
  has_code?: boolean;
}

function esc(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function sanitize(s: string, maxLen = 64): string {
  return esc(s.trim().toLowerCase()).slice(0, maxLen);
}

export function buildMetadataFilter(params: MetadataFilterParams): string {
  const clauses: string[] = [];

  if (params.language) {
    clauses.push(`language == "${sanitize(params.language, 32)}"`);
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
  if (typeof params.has_code === "boolean") {
    clauses.push(`has_code == ${params.has_code ? "true" : "false"}`);
  }

  // v14 first-class columns (equality filters, indexed)
  if (params.corpus_class) {
    clauses.push(`corpus_class == "${sanitize(params.corpus_class, 32)}"`);
  }
  if (params.constraint_kind) {
    clauses.push(`constraint_kind == "${sanitize(params.constraint_kind, 16)}"`);
  }
  if (params.content_profile) {
    clauses.push(`content_profile == "${sanitize(params.content_profile, 32)}"`);
  }
  if (params.constraint_source) {
    clauses.push(`constraint_source == "${sanitize(params.constraint_source, 64)}"`);
  }
  if (params.golden_path_id) {
    clauses.push(`golden_path_id == "${sanitize(params.golden_path_id, 128)}"`);
  }
  if (params.scope_tags?.length) {
    for (const tag of params.scope_tags.slice(0, 10)) {
      const safe = sanitize(tag, 64);
      if (safe) {
        clauses.push(`scope_tags like "%${safe}%"`);
      }
    }
  }
  if (params.tags) {
    clauses.push(`tags like "%${sanitize(params.tags, 128)}%"`);
  }

  if (clauses.length === 0) return "";
  return clauses.join(" and ");
}

/**
 * Combine scope/ACL filter with metadata filters into a single Milvus
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
 * Extract structured metadata from a Milvus tags string (backward compat).
 * Tags are comma-separated; prefixed entries like "corpus_class:X",
 * "ck:X", "scope:X", "content_profile:X" are parsed into typed fields.
 * With v14, prefer the first-class columns over these tag-parsed values.
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
      result.corpus_class = t.slice("corpus_class:".length);
    } else if (t.startsWith("ck:")) {
      result.constraint_kind = t.slice("ck:".length);
    } else if (t.startsWith("scope:")) {
      result.scope_tags.push(t.slice("scope:".length));
    } else if (t.startsWith("content_profile:")) {
      result.content_profile = t.slice("content_profile:".length);
    }
  }
  return result;
}
