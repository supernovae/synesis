# Security Todo

This tracker is for current, actionable security work that remains after the
controls documented in [SECURITY.md](SECURITY.md). Keep each item retirable:
when the acceptance criteria are met, remove the item. When the file is empty,
delete it and remove links to it.

## SEC-TODO-003: Reindex legacy RAG content after schema upgrades

**Status:** Open until each production corpus has been reindexed.

**Why:** Documents indexed before the current NornicDB schema can miss
`scan_signals`, `review_trace_id`, `effective_at_epoch`, `acl_group_ids`, or
`authz_object_id`. Retrieval remains fail-closed where authz requires metadata,
but missing metadata weakens observability and review quality.

**Evidence:** `base/rag/indexer/app/nornic_writer.py`,
`base/planner-ts/src/retrieval/rag-client.ts`,
`docs/coder/rag-schema-and-knowledge-sources.md`.

**Acceptance criteria:**

- Production corpora are reindexed with the current schema.
- Admin review queue shows non-empty scan/review/freshness fields where source
  data exists.
- Retrieval logs confirm expected `authz_trace_id` and OpenFGA checks for
  restricted/private rows.

**Validation:**

```bash
python3 scripts/check-doc-reference-integrity.py
```

## SEC-TODO-006 through SEC-TODO-014: 2026-07 security remediation

**Status:** Code mitigations complete; deployment rollout remains

Checked items have passed focused validation. Deployment remains an operational
rollout step.

- [x] SEC-TODO-006: Keep local-file ingestion CLI-only and reject it in Admin and queue flows.
- [x] SEC-TODO-007: Authenticate and network-restrict the vision worker.
- [x] SEC-TODO-008: Make sandbox authentication mandatory and replay-resistant.
- [x] SEC-TODO-009: Require the expected Keycloak client identity.
- [x] SEC-TODO-010: Refresh vulnerable locks and audit every Python service.
- [x] SEC-TODO-011: Validate public HTTPS ingestion destinations and redirects.
- [x] SEC-TODO-012: Gate unsuppressed Kubernetes findings against exact resource/check exceptions.
- [x] SEC-TODO-013: Gate the existing test suites and establish a coverage floor.
- [x] SEC-TODO-014: Split language extractors by domain, replace the WebUI full-file fork with a version-checked
  build patch against pinned upstream, split Admin hooks and governor recovery, and remove generated build state.

## SEC-TODO-005: Add model compliance regression cases for trust policy claims

**Status:** Live model qualification pending. Deterministic regression cases and the result recorder are complete; the configured AKS endpoint was DNS-unreachable on 2026-07-17.

**Why:** Trust envelopes, policy text, datamarks, and sandwich reminders reduce
injection risk, but effectiveness varies by model and context shape.

**Evidence:** `packages/synesis-context-trust/src/operational-policy.ts`,
`base/planner-ts/src/nodes/writer-compose.ts`,
`base/yarn-ts/src/security/transcript-trust.ts`,
`docs/coder/COMPACTION_SENSITIVITY.md`.

**Acceptance criteria:**

- [x] Add representative prompt-injection regression cases for at least planner
  writer and Yarn transcript flows.
- [ ] Record model/family outcomes so operators can see which models are safe for
  stricter trust policies.
- [x] Document model qualification recommendations in the relevant coder
  or chat docs.

**Validation:**

```bash
npm test -w @synesis/context-trust
npm test --workspace synesis-yarn-ts -- transcript-trust
```
