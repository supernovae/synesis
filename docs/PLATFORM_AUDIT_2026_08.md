# Platform audit — August 2026

This is a source-backed architecture and implementation audit of the current
Synesis repository. It is intentionally not a feature wishlist. Each finding
is tied to a live code path, a current standard, or a primary research source.
The audit date is 2026-08-25.

## Executive outcome

Synesis's core direction still makes sense. The platform should retain its
separate chat planner and coder runtime, graph-native authorization-aware RAG,
shared MCP tool surface, structural trust envelopes, deterministic policy
checks, bounded critic, and operator-facing telemetry. The review did not find
a reason for a wholesale framework or architecture rewrite.

The highest-risk drift was at the seams rather than in those foundations:

- The active corpus-quality workflow had been partially migrated to NornicDB,
  while CI, Make targets, and documentation still invoked retired-backend
  arguments. A separate retrieval workflow used a zero-query baseline and
  comparison logic that skipped zero values, so it could appear green without
  measuring retrieval.
- Hosted MCP could prefer the caller's bearer token for MCP-to-planner and
  MCP-to-knowledge requests. That crosses the token's resource boundary and is
  explicitly disallowed by current MCP security guidance.
- Agent evaluation was strong on known loops and deterministic policy behavior,
  but a single passing run could mask variance and refusal safety had no
  controlled should-act/should-abstain metric.
- Yarn, Planner, hosted MCP, and Admin MCP package manifests contained duplicate
  JSON dependency keys. Standard JSON parsing silently made older declarations
  authoritative.

Those four issues are corrected by this audit. The remaining work is ordered
below and should be treated as a measured roadmap, not as justification to add
new infrastructure without evidence.

## What changed in this audit

### Retrieval and quality gates

- Made NornicDB the single active corpus-audit path in the quality runner,
  scheduled workflow, Make targets, and operator documentation.
- Removed the obsolete retrieval-regression workflow and its empty
  committed baseline.
- Hardened the remaining legacy lab comparator so missing, empty, non-finite,
  zero-signal, and query-set-drifted baselines fail closed. Baseline promotion
  now requires an explicit `--update-baseline` action.
- Made `rag-retrieval-eval.yml` install its declared Python requirements,
  require the expected artifact, and run on relevant pull requests only when
  the validation environment is enabled.
- Replaced the golden-eval stub with a runbook that separates deterministic
  offline, live planner, and protected-principal lanes.

### MCP authorization boundary

- Internal MCP-to-service calls now prefer the dedicated internal service
  token. A validated principal is carried in explicit identity/scope headers;
  hosted callers fail closed if that credential is absent. Explicit local
  stdio/package clients may reuse their configured Synesis PAT at the same
  platform origin.
- Hosted MCP readiness now reports a missing internal service token instead of
  advertising a ready service whose upstream tool calls cannot authenticate.
- Added regression coverage proving that client tokens are not forwarded when
  a service token is configured, and that unvalidated identity headers are not
  synthesized in fallback mode.
- Forwarded ACL groups are now preserved with the already validated hosted MCP
  identity.

This aligns the hop with the MCP authorization requirement to issue tokens for
the intended resource and with the security guidance that token passthrough is
forbidden. It does **not** yet make hosted MCP a complete OAuth resource server;
that remaining gap is P1 below.

### Agent reliability

- Added an `abstention` Eval Gym category with controlled pairs. A pair passes
  only when both its should-act and should-abstain variants pass.
- Abstention is checked before side effects: calling the irreversible tool and
  objecting afterward fails the scenario.
- Added paired accuracy to Eval Gym output and added the lane to nightly and
  prerelease governor suites.
- Added repeated-run `pass^k` to Harness Matrix. It reports the fraction of
  repeated case groups for which all configured runs pass, instead of hiding
  stochastic failures in aggregate pass rate.

These changes follow [AgentAbstain](https://arxiv.org/abs/2607.10059), which
shows that should-act and should-abstain behavior must be measured together,
and [ReliabilityBench](https://arxiv.org/abs/2601.06112), which evaluates agents
over repeated runs, perturbations, tool faults, and equivalent end states.

### Dependency clarity

- Removed duplicate dependency keys from Yarn, Planner, hosted MCP, and Admin
  MCP, retaining the newest versions already declared in each manifest.
- Updated Planner's AI SDK usage adapter to the current
  `inputTokenDetails.cacheReadTokens` contract and removed the obsolete
  `cachedInputTokens` access that prevented a production TypeScript build.
- Advanced the root Fastify override from the older security-remediation pin
  to the current 5.12.1 requested by all four Fastify services.
- Updated Yarn's remaining outdated direct dependency, `tinypool`, from 2.1.0
  to 2.1.2. The Linux Rolldown binding is already pinned to its current/latest
  release; npm reports no installed version for it on a Darwin audit host.
- Updated the standalone Admin frontend patch dependencies and aligned
  `@eslint/js` with ESLint 10; updated Vision Worker to Fastify 5.12.1. Admin
  remains on TypeScript 6.0.3 because the current `typescript-eslint` peer
  range is `<6.1.0`; TypeScript 7.0.2 is therefore a compatibility migration,
  not a safe lock refresh.
- Regenerated the root npm lockfile after manifest changes.
- Added hashed, base-image-constrained Python lockfiles for the corpus benchmark
  and curator. Their workflows and quality-runner image now install only those
  locks with hash verification, and the security matrix now audits both
  quality-tool environments alongside the service environments.
- Added locks for the retained retrieval labs and prompt-evaluation harness,
  replacing the last floating workflow install. Every non-empty
  `requirements.txt` is now managed by the centralized freshness and audit
  gates; comment-only child-service files inherit their locked base image.
- Refreshed the two locks found stale by the complete check (Admin and Indexer),
  advancing their boto3/botocore patch release in sync.
- Refreshed the committed root development `uv.lock` to current releases.
  AST-MCP's canonical `requirements.lock` remains on the newest MCP 1.x SDK
  because the service explicitly declares `<2`; the 2.x protocol/API move is
  tracked as migration work below rather than applied without validation.

## Retain, revise, remove, add

| Decision | Platform area | Rationale |
|---|---|---|
| Retain | Planner/Yarn separation | Chat research synthesis and coding-agent mediation have different state, latency, and tool contracts. The current separation keeps those concerns inspectable. |
| Retain | NornicDB graph-native RAG | The production path consistently uses vector retrieval plus graph expansion, provenance, freshness, review state, and principal-derived authorization. |
| Retain | TrustPacket, strict schemas, scanners | Structural attribution and bounded inputs are useful defense-in-depth. Keep claims precise: these mitigate untrusted-content risk but do not prove non-interference. |
| Retain | Deterministic checks plus bounded critic | Binary checks cover properties an LLM judge should not be trusted to score alone; the critic remains useful for semantic failures. |
| Retain | Governor, replay fixtures, Eval Gym, live harnesses | The layered test shape is sound because rules, model behavior, protocol adapters, and real harness processes fail differently. |
| Revise | Agent reliability claims | Replace single-run success language with paired abstention, repeated-run `pass^k`, perturbation, and tool-fault evidence. |
| Revise | MCP OAuth story | Keep PAT/OIDC validation and OpenFGA, but add standard protected-resource discovery and resource/audience binding before claiming full HTTP MCP OAuth conformance. |
| Revise | Memory model | Active planner memory is appropriately bounded and purgeable. Persistent Yarn/project observations need invalidation, supersession, and stale-memory evaluation before longer-lived personalization expands. |
| Revise | Telemetry vocabulary | Preserve useful `yarn.*` operational attributes, while mapping model, agent, tool, and MCP spans onto current OpenTelemetry GenAI semantic conventions. |
| Remove | Retired retrieval backends from release gates | Production quality gates and comparison tools must exercise the NornicDB runtime. |
| Remove | Zero-signal baselines and implicit baseline creation | A regression gate without observations is worse than no gate because it creates false confidence. |
| Remove | Duplicate package keys and stale documentation claims | Ambiguous machine inputs and false operator instructions are reliability defects. |
| Add | Controlled act/abstain pairs | Refusal-only tests reward over-caution; action-only tests reward unsafe compliance. A pair catches both. |
| Add | Repeated-run and fault-surface reliability | One success is not an availability or correctness guarantee for a stochastic, tool-using system. |
| Add | Explicit forgetting controls | Persistent memory needs deletion/invalidation by observation, supersession lineage, and tests that obsolete facts are not reused. |

## Prioritized remaining gaps

### P1 — MCP standards completion

Hosted MCP already validates PATs/OIDC claims, scopes access, applies OpenFGA,
preflights JSON-RPC, rate limits, and now separates the service token from the
client token. It still needs:

1. OAuth Protected Resource Metadata for the MCP resource.
2. Resource-indicator support during authorization and token issuance.
3. Explicit audience/resource validation at the MCP server.
4. Tests for confused-deputy, metadata URL/SSRF, and multi-resource token cases.
5. Migrate the Python AST-MCP service from MCP SDK 1.x to 2.x with transport,
   lifecycle, path-scope, and client-compatibility regression coverage.

Acceptance: a conforming remote MCP client can discover authorization metadata,
obtain a token bound to this MCP resource, and that token is rejected at other
resources and never forwarded upstream. The relevant primary standards are the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
and [MCP security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).

### P1 — Persistent-memory invalidation

Planner conversation memory is a bounded active-session cache with TTL and an
explicit purge API; it should not be described as long-term personalization.
Yarn's session/project observation store can persist useful findings but can
currently clear only a whole scope. Add observation IDs and states such as
`active`, `superseded`, and `invalidated`; expose targeted invalidation; record
replacement lineage; and exclude inactive observations from recall.

Acceptance: an eval inserts an old fact, invalidates or supersedes it, inserts a
new fact, and fails if any subsequent action relies on the old fact. Track a
forgetting-aware invalid-memory reuse metric based on
[Memora](https://arxiv.org/abs/2604.20006).

### P1 — Reliability surfaces beyond repetition

`pass^k` and paired abstention are the first additions, not the full benchmark.
Extend Harness Matrix with recorded perturbation classes:

- tool timeout, rate limit, partial result, and schema drift;
- equivalent prompt/paraphrase variants;
- semantically equivalent tool order or final workspace state;
- recovery after a fault rather than only final success.

Acceptance: every release candidate reports clean-run pass rate, `pass^k`,
faulted-run recovery, and metamorphic-equivalence results with the perturbation
seed/config in its artifact. Use
[ReliabilityBench](https://arxiv.org/abs/2601.06112) as the measurement model,
not as a claim that Synesis reproduces its full benchmark today.

### P1 — Standards-based GenAI telemetry

Yarn has useful OpenTelemetry spans, metrics, and session events, but the custom
span vocabulary is not yet mapped to the current GenAI conventions. Add standard
provider/model/operation, tool-call, agent, and MCP attributes where applicable;
keep Synesis-specific fields under their existing namespace.

Acceptance: a trace through coder request → model → tool/MCP → response is
queryable using standard GenAI fields without losing the governor, reducer, and
trust metadata needed by operators. Track the evolving
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
and pin the version against which dashboards/tests are written.

### P1 — RAG golden-set depth

The repaired lane now fails honestly, but its value depends on the corpus. Grow
the golden set across documentation, code, API, security, freshness, and
authorization cases. Every promoted baseline should carry corpus revision,
embedding model/revision, index configuration, query-set hash, and principal
scope.

Acceptance: release artifacts contain nonzero deterministic metrics and live
planner results, query-set drift is rejected, and a separate protected-corpus
suite proves both relevant access and absence of forbidden results.

### P2 — Critic calibration and requirements traceability

The existing critic research backlog remains sound: calibrate on a small human
label set, aggregate failure-mode prevalence, use difficulty-aware rubric
granularity, and trace explicit requirements to answer sections. Do not add a
second uncalibrated judge merely to increase apparent coverage.

Acceptance: inter-rater/calibration error is reported by domain and difficulty;
every explicit requirement is mapped to evidence and output section or marked
unmet; dashboards show failure prevalence over a fixed evaluation cohort.

### P2 — Capability/data-flow enforcement

Trust envelopes and scanners are defense-in-depth, not the full control/data
flow architecture described by
[CaMeL](https://arxiv.org/abs/2503.18813). Pilot explicit capabilities for the
small number of highest-risk tool actions and propagate taint/provenance through
tool arguments before attempting a general policy engine.

Acceptance: an untrusted retrieved value cannot influence a protected tool
argument without a typed, logged declassification step. Start with destructive
filesystem and credential/secret operations, and measure task degradation.

## Governance and non-claims

Use the [NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
as a lifecycle checklist for measurement, deployment, incident learning, and
human oversight—not as a certification. The controls in this repository do not
make arbitrary agent execution safe, prove prompt-injection immunity, or turn
LLM judges into ground truth.

Research-derived features should enter the platform in this order:

1. State the measurable failure and current baseline.
2. Add a fixture or evaluation artifact that reproduces it.
3. Implement the smallest control that changes the measurement.
4. Test the negative control so safety does not collapse into blanket refusal.
5. Promote only after a reviewed, reproducible result.

## Validation record

The audit's focused checks cover:

- Python syntax, Ruff checks, and 7 retrieval-baseline policy tests.
- All 3,593 Yarn tests, Yarn typecheck, and Yarn build.
- All 562 Planner tests; its wall-clock latency budget was also rerun and
  passed in isolation after a parallel full-suite run introduced CPU contention.
- All 41 hosted MCP and 27 local MCP package tests, plus hosted/local/shared
  MCP typechecks and builds.
- All 3 Python AST-MCP tests against its current compatible dependency set.
- All 18 Admin frontend tests plus lint/production build, and all 4 Vision
  Worker tests against their refreshed standalone npm locks.
- npm lockfile regeneration and audit (0 known vulnerabilities), root `uv.lock`
  freshness/registry/audit checks (0 known vulnerabilities), hashed Python
  lockfile freshness/install checks, and `pip-audit` across all 12 non-empty
  requirements environments (0 unignored known vulnerabilities). The two
  no-fixed-version exceptions remain narrowly documented in the security
  policy. YAML parsing, repository lint, auth/schema/doc-integrity checks, and
  diff checks also pass.

Live NornicDB, model-in-loop, OAuth-provider, and Kubernetes deployment checks
remain environment-dependent. Their absence is called out as a deployment
qualification requirement rather than represented as a passing local test.
