# Synesis documentation

This tree is organized by **audience** and **product surface**. Implementation code lives under `base/`; these pages describe how to deploy, operate, extend, and use Synesis.

## How to read this repo

| Area | Canonical product name | Code (engineering) | Doc hub |
|------|------------------------|-------------------|---------|
| **Chat** | Knowledge and conversational assistant (Open WebUI, OpenAI-compatible chat clients) | `base/planner-ts/` | [`docs/chat/README.md`](chat/README.md) |
| **Coder** | IDE and agent coding runtime (Claude Code, Cursor, ACP bridges, etc.) | `base/yarn-ts/` | [`docs/coder/README.md`](coder/README.md) |
| **Platform** | RAG, gateway, models, security, shared infrastructure | Many `base/*` services | This directory (top-level `*.md`) |
| **User / clients** | “How do I connect my tool?” | — | [`docs/user/README.md`](user/README.md) and [`docs/clients/CLIENTS.md`](clients/CLIENTS.md) |
| **Engineering** | CI, local workflows, parity trackers, deep audits | — | [`docs/development/README.md`](development/README.md) |
| **Admin** | Operator UI and bootstrap | `base/admin/` | [`docs/admin/`](admin/) |

**Naming:** In user-facing docs, prefer **chat** and **coder** over internal service names. Reserve **planner-ts** / **yarn-ts** for implementation and development docs.

## Quick links

- **New operators:** [README](../README.md) (repository overview) → [Local Compose](LOCAL_COMPOSE.md) or [Helm install](HELM_INSTALL.md).
- **Chat pipeline:** [Workflow](chat/WORKFLOW_PLANNER.MD) · [Open WebUI](chat/OPENWEBUI.md) · [OpenAI compatibility](chat/PLANNER_OPENAI_COMPATIBILITY.md).
- **Coder runtime:** [`base/yarn-ts/README.md`](../base/yarn-ts/README.md) · [Coder doc index](coder/README.md).
- **Connect a client:** [Client overview](clients/CLIENTS.md) · [Claude Code → coder](clients/CLAUDECODE.md).
- **Develop & test:** [Development index](development/README.md).
- **Coder eval gates:** [Harness trust KPI lane](development/TESTING.md#97-harness-trust-kpi-lane-coder-reliability).
- **Security posture:** [Security controls](SECURITY.md) · [Security todo tracker](security_todo.md).
- **Project positioning:** [Comparison notes](COMPARISON.md).

## Admin-only

Kubernetes / Keycloak / registry details: [`docs/admin/`](admin/) (e.g. [Keycloak bootstrap](admin/KEYCLOAK_BOOTSTRAP.md)).

## Research & long-form design

Product-facing reading paths: **chat/** and **coder/** hubs above. Current engineering checks and validation commands live under **[development/](development/README.md)**.
