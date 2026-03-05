# Knowledge Indexers

Synesis includes four classes of **RAG knowledge indexers** that go beyond the basic language pack corpus. These indexers run as Kubernetes Jobs (manual trigger) or CronJobs (automated weekly refresh) and populate the unified `synesis_catalog` Milvus collection. The planner automatically queries the catalog based on task context, and the Critic uses architecture knowledge for its analysis.

## Indexer 1: Code Repository Indexer

Clones 50 high-quality open-source repositories across Python, Go, Rust, TypeScript, and Java, parses source files using **tree-sitter** for AST-aware chunking (functions, classes, methods as self-contained semantic units), and optionally extracts merged PR descriptions and commit messages via the GitHub API.

**Why tree-sitter matters:** Line-count-based chunking breaks functions mid-body, producing garbled embeddings. Tree-sitter extracts complete semantic units — a function with its docstring, a class with its methods — that embedding models can reason about meaningfully. PR/commit patterns capture the "why" behind code changes.

**Collections created:**

| Collection | Contents |
|------------|----------|
| `code_{lang}_v1` | AST-chunked functions, classes, methods with `symbol_name` and `symbol_type` metadata |
| `patterns_{lang}_v1` | PR descriptions and merge commit messages with author, date, changed files |

**Repositories indexed** (configurable via `base/rag/indexers/code/sources.yaml`):

| Language | Projects |
|----------|----------|
| Python | FastAPI, Django, Requests, Pytest, SQLAlchemy, Airflow, Celery, Pydantic, Black, Home Assistant |
| Go | Kubernetes, Prometheus, Etcd, Traefik, Hugo, Terraform, Gin, GORM, Docker, Go-ethereum |
| Rust | Tokio, rust-analyzer, Actix-web, Rocket, Diesel, Ripgrep, Cargo, Polars, Firecracker, Tauri |
| TypeScript | VS Code, Next.js, NestJS, Redux, Prisma, Axios, Tailwind CSS, D3.js, Express, Electron |
| Java | Spring Boot, JUnit 5, Guava, Elasticsearch, Kafka, Jenkins, Maven, Mockito, Spark, Hadoop |

**Running the indexer:**

```bash
./scripts/index-code.sh                              # Index all languages and repos
./scripts/index-code.sh --language python             # Index only Python
./scripts/index-code.sh --language python --repo tiangolo/fastapi  # Single repo
```

**GitHub PR extraction:** If you provide a GitHub PAT, the indexer uses the GitHub API to fetch merged PR descriptions with titles, labels, changed files, and merge commit messages. Without a PAT, it falls back to `git log --merges`:

```bash
oc create secret generic synesis-github-token \
  --from-literal=token=ghp_YOUR_TOKEN_HERE \
  -n synesis-rag
```

Or run `./scripts/bootstrap.sh --github-token` (prompts) or `./scripts/bootstrap.sh --ghcr-creds` (same token for GHCR + RAG).

## Indexer 2: API Spec Indexer

Fetches OpenAPI 3.x / Swagger 2.0 specs from URLs, parses them into **endpoint-level chunks** (one chunk per path+method with parameters, request body, response schema, and description), and stores in the catalog. This gives the Worker accurate API knowledge when generating code that interacts with Kubernetes, OpenShift, or cloud APIs.

**Collections created:**

| Collection | Specs Included |
|------------|----------------|
| `apispec_kubernetes_v1` | Core v1, Apps v1, Batch v1, Networking v1 APIs |
| `apispec_openshift_v1` | OpenShift Route API |

**Running the indexer:**

```bash
./scripts/index-apispec.sh                            # Index all specs
./scripts/index-apispec.sh --spec kubernetes-core-v1  # Index only Kubernetes
```

**Adding custom API specs:** Edit `base/rag/indexers/apispec/sources.yaml`:

```yaml
specs:
  - name: "my-internal-api"
    url: "https://my-api.example.com/openapi.json"
    description: "My internal service API"
    collection: "apispec_myapi_v1"
```

## Indexer 3: Architecture Whitepaper Indexer

Downloads whitepapers and design pattern documentation (PDFs, HTML, Markdown), converts to text, and chunks by section. This gives the **Critic** node access to architectural best practices for its analysis.

**Collections created:**

| Collection | Documents |
|------------|-----------|
| `arch_well_architected_v1` | AWS Well-Architected Framework, Reliability Pillar, Security Pillar, Operational Excellence Pillar |
| `arch_cloud_patterns_v1` | Microsoft Cloud Design Patterns (Circuit Breaker, Retry, Bulkhead, CQRS, Event Sourcing, Sidecar), Twelve-Factor App |

**Running the indexer:**

```bash
./scripts/index-architecture.sh
```

**Adding documents:** Edit `base/rag/indexers/architecture/sources.yaml`:

```yaml
documents:
  - name: "My Architecture Guide"
    url: "https://example.com/guide.pdf"
    type: pdf
    collection: "arch_my_guide_v1"
    tags: ["custom", "internal"]
```

## Indexer 4: License Compliance Indexer

Indexes open source license data from three authoritative sources plus a built-in compatibility matrix, then makes this knowledge available to the Critic for compliance checking. The code indexer is also enhanced to detect and tag every code chunk with its source repository's SPDX license identifier.

**Data sources:**

| Source | What It Provides |
|--------|-----------------|
| [SPDX License List](https://spdx.org/licenses/) | 500+ licenses with SPDX ID, name, full text, OSI approval status |
| [Fedora License Data](https://docs.fedoraproject.org/en-US/legal/) | Red Hat / Fedora approval status (`allowed`, `allowed-content`, `not-allowed`) |
| [choosealicense.com](https://choosealicense.com/) | Structured permissions, conditions, and limitations per license |
| Built-in compatibility matrix | Pairwise license compatibility rules (e.g., "MIT -> Apache-2.0: compatible") |

**Running the indexer:**

```bash
./scripts/index-license.sh                     # Index all licenses
./scripts/index-license.sh --license MIT       # Index a single license
./scripts/index-license.sh --force             # Re-index everything
```

**Customizing compatibility rules:** Edit `base/rag/indexers/license/compatibility.yaml`.

## How the Planner Uses Indexed Knowledge

**Unified catalog:** All tasks query `synesis_catalog` only. Metadata (`domain`, `indexer_source`) drives retrieval gravity — domain runbooks, code, API specs, architecture docs, and license data share the same collection.

The Critic receives architecture and design pattern context as part of its prompt when relevant. License metadata travels with code patterns from the code indexer, allowing the Critic to flag compatibility issues.

## CronJob Schedules

| Environment | Code Indexer | API Spec Indexer | Architecture Indexer | License Indexer |
|------------|-------------|-----------------|---------------------|-----------------|
| **Dev** | Suspended (manual only) | Suspended (manual only) | Suspended (manual only) | Suspended (manual only) |
| **Staging** | 1st & 15th of month | 1st & 15th of month | 1st & 15th of month | 1st & 15th of month |
| **Prod** | Weekly (Sunday 3am) | Weekly (Sunday 4am) | Weekly (Sunday 5am) | Weekly (Sunday 6am) |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `RAG_CRITIC_ARCH_ENABLED` | `true` | Give the Critic architecture context from synesis_catalog |
| `RAG_CRITIC_LICENSE_ENABLED` | `true` | Give the Critic license compliance context from synesis_catalog |

## Resource Requirements

| Indexer | CPU Request | Memory | Disk | Typical Runtime |
|---------|------------|--------|------|-----------------|
| Code (all 50 repos) | 1 core | 2-8Gi | 50Gi (clone cache) | 2-6 hours |
| API Spec | 500m | 1-2Gi | minimal | 5-15 minutes |
| Architecture | 500m | 1-2Gi | minimal | 5-15 minutes |
| License | 250m | 512Mi | minimal | 5-10 minutes |

---

Back to [README](../README.md) | See also: [RAG Pipeline](RAG.md), [Taxonomy Shaping](TAXONOMY_SHAPING.md)
