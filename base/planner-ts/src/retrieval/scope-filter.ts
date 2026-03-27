/**
 * Milvus boolean expression builder for three-tier visibility.
 *
 * Produces a filter string that enforces global/org/tenant scoping,
 * matching the Python build_scope_filter() in rag_client.py.
 */

import type { ScopeFilterOptions } from "./types.js";

export function buildScopeFilter(opts?: ScopeFilterOptions): string {
  if (!opts) return "";
  const { callerOrgId, callerTenantIds, callerAclGroups } = opts;
  if (!callerOrgId && !callerTenantIds?.length && !callerAclGroups?.length) {
    return "";
  }

  const clauses: string[] = [];
  clauses.push('visibility_scope == "global"');

  if (callerOrgId) {
    clauses.push(`(visibility_scope == "org" && org_id == "${esc(callerOrgId)}")`);
  }
  if (callerTenantIds?.length) {
    const ids = callerTenantIds.map((t) => `"${esc(t)}"`).join(", ");
    clauses.push(`(visibility_scope == "tenant" && tenant_id in [${ids}])`);
  }

  const scopeExpr = clauses.join(" || ");

  if (callerAclGroups?.length) {
    const aclOr = callerAclGroups
      .map((g) => `acl_groups like "%${esc(g)}%"`)
      .join(" || ");
    return `(${scopeExpr}) && (acl_mode in ["open", ""] || ${aclOr})`;
  }

  return scopeExpr;
}

function esc(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
