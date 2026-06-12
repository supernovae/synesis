# Local Compose

Run Synesis on a workstation with Podman Compose or Docker Compose when you
want the core platform without Kubernetes, Helm, Cloudflare Tunnel, or
OpenShift routes.

This stack is for local development and evaluation. Production deployments
should use the Helm chart in [`docs/HELM_INSTALL.md`](HELM_INSTALL.md).

## What Starts By Default

```text
Open WebUI  ->  planner-ts  -> model provider
                 |
                 +-> admin API / Postgres / Redis

IDE clients ->  yarn-ts     -> model provider
```

Default services:

| Service | Local URL | Purpose |
|---------|-----------|---------|
| Open WebUI | <http://localhost:3000> | Local chat UI pointed at planner-ts |
| Synesis Admin | <http://localhost:8081> | Admin API and UI shell |
| planner-ts | <http://localhost:8082> | OpenAI-compatible chat/planner API |
| yarn-ts | <http://localhost:8000> | Coder/IDE OpenAI-compatible runtime |
| Postgres | `localhost:5432` | Admin, traces, usage, model/provider metadata |
| Redis | `localhost:6379` | Planner and Yarn session state |

Optional profiles add MCP, search, RAG, and ingestion services.

## Requirements

- Podman with Compose support, or Docker with the Compose plugin.
- Enough disk for images and volumes.
- Optional model/provider API keys if you want real model calls.

The default compose stack pulls published images from GHCR and Docker Hub. It
does not require building the repository.

## Quick Start

```bash
cp .env.example .env
podman compose -f podman-compose.yaml up -d
```

Docker equivalent:

```bash
docker compose -f podman-compose.yaml up -d
```

Open <http://localhost:3000>, create the first Open WebUI local account, and
select `Synesis Auto`.

By default `SYNESIS_PLANNER_TS_LLM_ENABLED=false`, so the stack is suitable for
health checks and UI smoke tests before any model key is configured. To make
chat call a model, edit `.env`:

```dotenv
SYNESIS_PLANNER_TS_LLM_ENABLED=true
SYNESIS_PLANNER_TS_LLM_BASE_URL=https://api.openai.com/v1
SYNESIS_PLANNER_TS_LLM_API_KEY=sk-...
SYNESIS_PLANNER_TS_WRITER_MODEL=gpt-4.1-mini
SYNESIS_PLANNER_TS_PLANNER_MODEL=gpt-4.1-mini
SYNESIS_PLANNER_TS_CRITIC_MODEL=gpt-4.1-mini
```

Then restart planner:

```bash
podman compose -f podman-compose.yaml up -d planner
```

## Local Auth Behavior

Open WebUI uses its local login form in compose mode. The first registered user
is local to Open WebUI's volume.

Synesis Admin does not have a local username/password fallback. That is
intentional. The admin API supports Keycloak/OIDC browser sessions and Synesis
PATs. Without `SYNESIS_KEYCLOAK_ISSUER_URL`, the admin UI starts but interactive
admin login remains disabled. Configure OIDC in `.env` when you need to operate
the admin UI locally:

```dotenv
SYNESIS_KEYCLOAK_ISSUER_URL=http://localhost:8080/realms/synesis
SYNESIS_KEYCLOAK_INTERNAL_ISSUER_URL=http://keycloak:8080/realms/synesis
```

The repository's maintained Keycloak bootstrap path is the Helm chart and
[`docs/admin/KEYCLOAK_BOOTSTRAP.md`](admin/KEYCLOAK_BOOTSTRAP.md). The compose
stack does not currently ship a local realm import.

## Profiles

Start only the default stack:

```bash
podman compose -f podman-compose.yaml up -d
```

Add MCP services:

```bash
podman compose -f podman-compose.yaml --profile mcp up -d
```

Add local SearXNG for web-search experiments:

```bash
SYNESIS_WEB_SEARCH_ENABLED=true \
SYNESIS_WEB_SEARCH_URL=http://searxng:8080 \
podman compose -f podman-compose.yaml --profile search up -d
```

Add NornicDB and lightweight RAG helper services:

```bash
podman compose -f podman-compose.yaml --profile rag up -d
```

Planner and Admin already default `SYNESIS_NORNIC_URI` to
`bolt://nornicdb:7687` for compose. Optional helpers are only used when their
URLs are set. For example:

```dotenv
SYNESIS_BGE_RERANKER_URL=http://bge-reranker:8000
SYNESIS_EMBEDDER_URL=http://embedder:8080/v1
```

Run the queue indexer once against admin + NornicDB:

```bash
podman compose -f podman-compose.yaml --profile rag --profile ingest run --rm indexer
```

The queue indexer claims work from Synesis Admin. Create or import ingestion
items first through the admin API/UI. For staged ingestion, SynPack, and content
pack operations, see [`docs/INDEXERS.md`](INDEXERS.md) and
[`base/rag/README.md`](../base/rag/README.md).

Heavy helper services are intentionally opt-in:

```bash
podman compose -f podman-compose.yaml --profile heavy up -d gliner-service spam-service
```

The `embedder` service is also under `heavy` because the BGE-M3 TEI CPU image is
large and memory hungry. Prefer setting `SYNESIS_EMBEDDER_URL` to the embedder
you use for SynPack/RAG pack generation.

## Useful Commands

Check status:

```bash
podman compose -f podman-compose.yaml ps
```

Tail logs:

```bash
podman compose -f podman-compose.yaml logs -f planner yarn admin open-webui
```

Smoke test planner:

```bash
curl http://localhost:8082/health
curl http://localhost:8082/v1/models
```

Smoke test Yarn:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/v1/models
```

Stop the stack:

```bash
podman compose -f podman-compose.yaml down
```

Remove local volumes:

```bash
podman compose -f podman-compose.yaml down -v
```

## Local Image Development

The compose file uses published images by default. To test a local service
change:

```bash
podman build -t ghcr.io/supernovae/synesis/planner-ts:local -f base/planner-ts/Containerfile .
SYNESIS_IMAGE_TAG=local podman compose -f podman-compose.yaml up -d planner
```

Repeat with the relevant `Containerfile` or `Dockerfile` for `admin`, `yarn-ts`,
`synesis-mcp`, or the RAG helper service you are changing.

## Production Differences

The local compose defaults trade strict production posture for convenience:

- planner-ts allows opaque bearer tokens and does not require bearer auth by
  default.
- RAG authorization is set to `audit` unless you configure OpenFGA.
- Open WebUI allows local signup.
- Admin browser login still requires OIDC; no dev password fallback is added.
- TLS, ingress, network policies, Kubernetes secrets, service accounts,
  autoscaling, and OpenShift SCC hardening are not represented.

Use Helm for internet-facing environments.
