# Failure Knowledge Base

Synesis learns from its mistakes. Every failed code execution is stored in a **failure vector store** (Milvus `failures_v1` collection), and an **in-memory fail-fast cache** provides instant pattern matching for recent attempts.

## Components

### Failure Vector Store

Stored in Milvus `failures_v1` collection. Contains the failed code, error output, error classification (lint/security/runtime/timeout), language, task description, and an embedding of the code+error pair. When the Router sends a new task to the Worker, it queries this store for similar past failures and injects them as context.

### Fail-Fast Cache

In-memory LRU cache (1000 entries, 24h TTL) keyed by `hash(task_description + language)`. On cache hit:
- **Past success**: inject the successful code pattern as a hint
- **Past failure**: inject the failure context to avoid repeating the same mistake

### Resolution Tracking

When a failed task eventually succeeds on a subsequent iteration, the successful code is stored as a `resolution` on the original failure entry. Over time, the failure store builds a knowledge base of "problem -> solution" pairs.

## Admin Dashboard

An internal-only FastAPI service (`synesis-admin`) provides a web dashboard for browsing failure patterns:

- `/admin/failures` — paginated list of failures with language/type filters
- `/admin/failures/stats` — aggregate stats: failure rate by language, most common error types, resolution rate
- `/admin/failures/gaps` — identifies RAG corpus gaps: unresolved failures suggest missing documentation in the language packs
- `/admin/failures/{id}` — detail view with code, error output, and resolution

The admin service is deployed in the planner namespace with a `ClusterIP` Service (no external Route). Access it via port-forward:

```bash
oc port-forward svc/synesis-admin 8080:8080 -n synesis-planner
# Open http://localhost:8080/admin/failures/stats
```

## Observability (COO + Perses)

Synesis provides a **Perses dashboard** for the Cluster Observability Operator (COO). Dashboards are deployed as `PersesDashboard` CRs in the `perses-dev` namespace.

**Prerequisites:**
- Cluster Observability Operator installed with Perses enabled (`UIPlugin` with `monitoring.perses.enabled: true`)
- User workload monitoring enabled (Prometheus scraping Synesis ServiceMonitors)
- Perses datasource pointing to Thanos/Prometheus

**Deploy:**

```bash
oc apply -k overlays/dev  # or staging/prod
```

**View:** Observe → Dashboards (Perses) in the OpenShift console. Select **Synesis - LLM Assistant Overview**.

See [OBSERVABILITY.md](OBSERVABILITY.md) for the full panel catalog and metrics reference.

---

Back to [README](../README.md) | See also: [Observability](OBSERVABILITY.md)
