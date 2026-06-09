/**
 * Scope/ACL boolean expression builder used for diagnostics and tests.
 * Runtime retrieval applies equivalent constraints as Cypher parameters.
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

import crypto from "node:crypto";

import type { ScopeFilterOptions } from "./types.js";

const SAFE_SCOPE_LITERAL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

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
    const safeOrg = scopeLiteral("org", callerOrgId, 64);
    if (!safeOrg) return `(${clauses[0]}) and acl_mode in ["open", ""]`;
    clauses.push(`(visibility_scope == "org" and org_id == "${safeOrg}")`);

    if (callerTenantIds?.length) {
      const safeTenants = callerTenantIds
        .slice(0, 50)
        .map((t) => scopeLiteral("tenant", t, 64))
        .filter((t) => t.length > 0)
        .map((t) => `"${t}"`)
        .join(",");
      if (safeTenants) {
        clauses.push(
          `(visibility_scope == "tenant" and org_id == "${safeOrg}" and tenant_id in [${safeTenants}])`,
        );
      }
    }

    if (callerUserId) {
      const safeUser = scopeLiteral("user", callerUserId, 64);
      if (safeUser) {
        clauses.push(
          `(visibility_scope == "user" and org_id == "${safeOrg}" and owner_user_id == "${safeUser}")`,
        );

        if (callerConversationId) {
          const safeConv = scopeLiteral("conversation", callerConversationId, 128);
          if (safeConv) {
            const nowEpoch = Math.floor(Date.now() / 1000);
            clauses.push(
              `(visibility_scope == "session" and org_id == "${safeOrg}" and owner_user_id == "${safeUser}" and conversation_id == "${safeConv}" and (expires_at_epoch <= 0 or expires_at_epoch >= ${nowEpoch}))`,
            );
          }
        }
      }
    }
  }

  const baseExpr = `(${clauses.join(" or ")})`;

  if (callerAclGroups?.length) {
    const safeGroups = callerAclGroups
      .slice(0, 100)
      .map((g) => scopeLiteral("acl", g, 64))
      .filter((g) => g.length > 0);
    if (safeGroups.length > 0) {
      const groupLikes = safeGroups
        .map((g) => `acl_groups like "%${g}%"`)
        .join(" or ");
      return `${baseExpr} and (acl_mode in ["open", ""] or (${groupLikes}))`;
    }
  }

  return `${baseExpr} and acl_mode in ["open", ""]`;
}

function scopeLiteral(label: "org" | "tenant" | "user" | "conversation" | "acl", value: string, maxLength: number): string {
  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength && SAFE_SCOPE_LITERAL_RE.test(normalized)) return normalized;
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${label}-${digest}`;
}
