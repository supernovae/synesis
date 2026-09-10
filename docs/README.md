# Synesis documentation

The local source-pack CLI and MCP reader are implemented. Start with [source packs](SOURCE_PACKS.md), [MCP setup](clients/MCP_QUICKSTART.md) and [client boundaries](clients/CLIENTS.md). The [architecture decision record](ARCHITECTURE_REVIEW.md) tracks the remaining work. Most platform guides below describe code awaiting extraction/removal; they are not prerequisites for the local reader.
This tree is organized by **audience** and **product surface**. The current core lives in `packages/synesis-mcp`; retained platform implementations live under `base/`. The hosted MCP services and Admin assistant loop have been removed.

## How to read this repo

| Area | Canonical product name | Code (engineering) | Doc hub |
|------|------------------------|-------------------|---------|
| **Local knowledge** | Source-pack CLI and MCP reader | `packages/synesis-mcp/` | [Source packs](SOURCE_PACKS.md) |
| **Retained chat** | Knowledge and conversational assistant (Open WebUI, OpenAI-compatible chat clients) | `base/planner-ts/` | [`docs/chat/README.md`](chat/README.md) |
| **Retained coder** | IDE and agent coding runtime (Claude Code, Cursor, ACP bridges, etc.) | `base/yarn-ts/` | [`docs/coder/README.md`](coder/README.md) |
| **Platform** | RAG, gateway, models, security, shared infrastructure | Many `base/*` services | This directory (top-level `*.md`) |
| **User / clients** | “How do I connect my tool?” | — | [`docs/user/README.md`](user/README.md) and [`docs/clients/CLIENTS.md`](clients/CLIENTS.md) |
| **Engineering** | CI, local workflows, parity trackers, deep audits | — | [`docs/development/README.md`](development/README.md) |
| **Admin** | Operator UI and bootstrap | `base/admin/` | [`docs/admin/`](admin/) |

**Naming:** In user-facing docs, prefer **chat** and **coder** over internal service names. Reserve **planner-ts** / **yarn-ts** for implementation and development docs.

## Quick links

- **Start here:** [README](../README.md) → [local source packs](SOURCE_PACKS.md). For the existing stack: [Local Compose](LOCAL_COMPOSE.md) or [Helm install](HELM_INSTALL.md).
- **Chat pipeline:** [Workflow](chat/WORKFLOW_PLANNER.MD) · [Open WebUI](chat/OPENWEBUI.md) · [OpenAI compatibility](chat/PLANNER_OPENAI_COMPATIBILITY.md).
- **Coder runtime:** [`base/yarn-ts/README.md`](../base/yarn-ts/README.md) · [Coder doc index](coder/README.md).
- **Connect a client:** [Client overview](clients/CLIENTS.md) · [Claude Code → coder](clients/CLAUDECODE.md).
- **Develop & test:** [Development index](development/README.md).
- **Coder eval gates:** [Harness trust KPI lane](development/TESTING.md#97-harness-trust-kpi-lane-coder-reliability).
- **Security posture:** [Security controls](SECURITY.md) · [Security todo tracker](security_todo.md).
- **Model behavior:** [Model compatibility guide](model-compatibility.md) · [Architecture controls](model-architecture-awareness.md).
- **Harness compatibility:** [Client contracts and limitations](clients/HARNESS_COMPATIBILITY.md).
- **Current architecture direction:** [Decision record and implementation sequence](ARCHITECTURE_REVIEW.md). Historical snapshot: [August 2026 review](PLATFORM_AUDIT_2026_08.md).
- **Project positioning:** [Comparison notes](COMPARISON.md).

## Admin-only

Kubernetes / Keycloak / registry details: [`docs/admin/`](admin/) (e.g. [Keycloak bootstrap](admin/KEYCLOAK_BOOTSTRAP.md)).

## Research & long-form design

Product-facing reading paths: **chat/** and **coder/** hubs above. Current engineering checks and validation commands live under **[development/](development/README.md)**.

## Documentation scope

Setup guides describe prerequisites and configuration. Runtime references describe
implemented behavior; design documents describe goals and hypotheses. Dated
audits and benchmark notes are snapshots, not support commitments. A passing
contract test does not certify every client/model release, and performance claims
need a named workload, configuration, and measurement. Prefer the current
compatibility references above when older notes describe retired behavior.
