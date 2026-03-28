# Synesis OpenFGA Authorization Model

This directory contains the versioned OpenFGA authorization schema used across
all Synesis services (planner-ts, yarn-ts, admin).

## Principal ID conventions

| Source     | OpenFGA user ID               | Example                              |
|------------|-------------------------------|--------------------------------------|
| Keycloak   | `user:<sub claim>`            | `user:a1b2c3d4-...`                 |
| PAT        | `user:<personal_access_tokens.user_id>` | `user:kc-sub-or-legacy-id` |
| Service    | `service:<name>`              | `service:gateway`                    |

All tuple writers (admin API, backfill scripts) MUST use the same canonical
user ID. For Keycloak users the `sub` claim is authoritative; for PAT-only
users the `user_id` column from `personal_access_tokens` must match.

## Key design decisions

- **Org-optional**: solo users get direct `user → resource` tuples; org
  membership adds org/tenant-scoped grants alongside (not replacing) user-level.
- **RAG two-plane**: FGA is control-plane (can this user retrieve at all?);
  Milvus metadata is data-plane (which documents match scope/ACL).
- **Deny via exclusion**: `can_use = enabled but not blocked` for per-user
  deny. Platform-wide blocks use `platform_policy` checked in application code
  (two-step: blocked check first, then FGA `can_use`).
- **Multi-org (Phase 2)**: modeled as multiple `user → org#member` tuples;
  request-scoped org selection validated by `check(user, member, org:X)`.

## Validation

```bash
# Requires: go install github.com/openfga/cli/cmd/fga@latest
fga model validate --file authz/openfga/schema.fga
```
