# Security Todo

This tracker is for current, actionable security work that remains after the
controls documented in [SECURITY.md](SECURITY.md). Keep each item retirable:
when the acceptance criteria are met, remove the item. When the file is empty,
delete it and remove links to it.

## SEC-TODO-001: Add a second-stage prompt-injection scorer

**Status:** Open

**Why:** The current scanner is deterministic and pattern-based. That is fast
and auditable, but it will not catch every novel, semantic, or heavily
obfuscated prompt-injection technique.

**Evidence:** `packages/synesis-context-trust/src/scanner.ts`,
`packages/synesis-context-trust/src/normalizer.ts`,
`docs/chat/PLANNER_PROMPT_INJECTION_SCORER.md`.

**Acceptance criteria:**

- A scorer service or library is selected and documented.
- Planner/Yarn can emit scorer results to the admin security event pipeline.
- Operator knobs are documented next to `SYNESIS_INJECTION_ACTION` and
  `SYNESIS_INJECTION_REQUIRE_DUAL_SIGNAL`.
- Tests cover benign quotes, obvious attacks, and scorer timeout/failure
  behavior.

**Validation:**

```bash
npm test -w @synesis/context-trust
python3 scripts/check-doc-reference-integrity.py
```

## SEC-TODO-002: Add corpus-level scan signal trend reporting

**Status:** Open

**Why:** Index-time scanning stores scan status/signals, but operators need an
easy way to identify recurring signals by source/domain over time.

**Evidence:** `base/rag/indexer/app/injection_scan.py`,
`base/rag/indexer/app/nornic_writer.py`, `docs/ADMIN_QUALITY_UI.md`.

**Acceptance criteria:**

- Admin exposes aggregate scan signal counts by source/domain/time window.
- Security UI links flagged corpus trends to review queue filters.
- Tests cover org scoping and malformed filter rejection.

**Validation:**

```bash
pytest base/admin/tests/test_security_hardening.py
python3 scripts/check-doc-reference-integrity.py
```

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

## SEC-TODO-004: Decide strictness for trust packet parsing

**Status:** Open

**Why:** Many high-risk tool and artifact schemas are strict, but
`TrustPacketV1` and `AttributionV1` currently use Zod object parsing with
bounded fields and defaults rather than `.strict()`. That can be useful for
forward compatibility, but operators should have an explicit decision.

**Evidence:** `packages/synesis-context-trust/src/trust-packet.ts`,
`packages/synesis-context-trust/tests/trust-packet.test.ts`.

**Acceptance criteria:**

- Either make `TrustPacketV1` / `AttributionV1` strict, or document the
  forward-compatible parsing decision in `docs/SECURITY.md`.
- Tests cover unknown-key behavior.
- Planner and Yarn trust-packet consumers pass the updated tests.

**Validation:**

```bash
npm test -w @synesis/context-trust -- trust-packet.test.ts
npm test --workspace synesis-yarn-ts -- transcript-trust
```

## SEC-TODO-006 through SEC-TODO-014: 2026-07 security remediation

**Status:** Code mitigations complete through SEC-TODO-013; rollout and SEC-TODO-014 remain

Retire each checked item after its focused validation passes and the mitigation
is deployed.

- [x] SEC-TODO-006: Keep local-file ingestion CLI-only and reject it in Admin and queue flows.
- [x] SEC-TODO-007: Authenticate and network-restrict the vision worker.
- [x] SEC-TODO-008: Make sandbox authentication mandatory and replay-resistant.
- [x] SEC-TODO-009: Require the expected Keycloak client identity.
- [x] SEC-TODO-010: Refresh vulnerable locks and audit every Python service.
- [x] SEC-TODO-011: Validate public HTTPS ingestion destinations and redirects.
- [x] SEC-TODO-012: Gate unsuppressed Kubernetes findings against exact resource/check exceptions.
- [x] SEC-TODO-013: Gate the existing test suites and establish a coverage floor.
- [ ] SEC-TODO-014: Finish splitting `language_pack.py`, port the WebUI middleware delta onto pinned upstream,
  and remove the fork. Admin hooks and governor recovery are split; generated `tsconfig.tsbuildinfo` is removed.

## SEC-TODO-005: Add model compliance regression cases for trust policy claims

**Status:** Open

**Why:** Trust envelopes, policy text, datamarks, and sandwich reminders reduce
injection risk, but effectiveness varies by model and context shape.

**Evidence:** `packages/synesis-context-trust/src/operational-policy.ts`,
`base/planner-ts/src/nodes/writer-compose.ts`,
`base/yarn-ts/src/security/transcript-trust.ts`,
`docs/coder/COMPACTION_SENSITIVITY.md`.

**Acceptance criteria:**

- Add representative prompt-injection regression cases for at least planner
  writer and Yarn transcript flows.
- Record model/family outcomes so operators can see which models are safe for
  stricter trust policies.
- Document any model-specific operational recommendation in the relevant coder
  or chat docs.

**Validation:**

```bash
npm test -w @synesis/context-trust
npm test --workspace synesis-yarn-ts -- transcript-trust
```
