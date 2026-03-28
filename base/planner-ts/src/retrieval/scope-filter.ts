/**
 * Milvus boolean expression builder — full parity with Python
 * build_scope_filter() in base/planner/app/rag_client.py.
 *
 * Access tiers (OR-combined):
 *   1. visibility_scope == "global"           — always allowed
 *   2. visibility_scope == "org"     + org_id — org members
 *   3. visibility_scope == "tenant"  + org_id + tenant_id — tenant members
 *   4. visibility_scope == "user"    + org_id + owner_user_id — user-scoped
 *   5. visibility_scope == "session" + org_id + owner_user_id +
 *      conversation_id + TTL — session-scoped
 *
 * Fail-closed: empty callerOrgId → only global content (solo user lane).
 * ACL: acl_mode open/restricted/private enforcement (deny-by-default for
 * restricted/private without matching groups).
 */

import type { ScopeFilterOptions } from "./types.js";

export function buildScopeFilter(opts?: ScopeFilterOptions): string {
  if (!opts) return "";

  const {
    callerOrgId,
    callerTenantIds,
    callerAclGroups,
    callerUserId,
    callerConversationId,
  } = opts;

  const clauses: string[] = ['visibility_scope == "global"'];

  if (callerOrgId) {
    const safeOrg = esc(callerOrgId).slice(0, 64);
    clauses.push(`(visibility_scope == "org" and org_id == "${safeOrg}")`);

    if (callerTenantIds?.length) {
      const safeTenants = callerTenantIds
        .slice(0, 50)
        .map((t) => `"${esc(t).slice(0, 64)}"`)
        .join(",");
      clauses.push(
        `(visibility_scope == "tenant" and org_id == "${safeOrg}" and tenant_id in [${safeTenants}])`,
      );
    }

    if (callerUserId) {
      const safeUser = esc(callerUserId).slice(0, 64);
      clauses.push(
        `(visibility_scope == "user" and org_id == "${safeOrg}" and owner_user_id == "${safeUser}")`,
      );

      if (callerConversationId) {
        const safeConv = esc(callerConversationId).slice(0, 128);
        const nowEpoch = Math.floor(Date.now() / 1000);
        clauses.push(
          `(visibility_scope == "session" and org_id == "${safeOrg}" and owner_user_id == "${safeUser}" and conversation_id == "${safeConv}" and (expires_at_epoch <= 0 or expires_at_epoch >= ${nowEpoch}))`,
        );
      }
    }
  }

  const baseExpr = `(${clauses.join(" or ")})`;

  if (callerAclGroups?.length) {
    const safeGroups = callerAclGroups
      .slice(0, 100)
      .map((g) => esc(g).slice(0, 64))
      .filter((g) => g.trim());
    if (safeGroups.length > 0) {
      const groupLikes = safeGroups
        .map((g) => `acl_groups like "%${g}%"`)
        .join(" or ");
      return `${baseExpr} and (acl_mode in ["open", ""] or (${groupLikes}))`;
    }
  }

  return `${baseExpr} and acl_mode in ["open", ""]`;
}

function esc(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
