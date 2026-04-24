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

- **New operators:** [README](../README.md) (repository overview) → [Deployment / secrets](DEPLOY_SECRETS.md) as needed.
- **Chat pipeline:** [Workflow (LangGraph)](chat/WORKFLOW_PLANNER.MD) · [Open WebUI](chat/OPENWEBUI.md) · [OpenAI compatibility](chat/PLANNER_OPENAI_COMPATIBILITY.md).
- **Coder runtime:** [`base/yarn-ts/README.md`](../base/yarn-ts/README.md) · [Coder doc index](coder/README.md).
- **Connect a client:** [Client overview](clients/CLIENTS.md) · [Claude Code → coder](clients/CLAUDECODE.md).
- **Develop & test:** [Development index](development/README.md).
- **Harness trust strategy:** [Trust hardening plan](development/HARNESS_TRUST_HARDENING.md).

## Admin-only

Kubernetes / Keycloak / registry details: [`docs/admin/`](admin/) (e.g. [Keycloak bootstrap](admin/KEYCLOAK_BOOTSTRAP.md)).

## Research & long-form design

Product-facing reading paths: **chat/** and **coder/** hubs above. **Milestone program (M1–M11)** and the **testing inventory** live under **[development/](development/README.md)** alongside CI and parity trackers.
