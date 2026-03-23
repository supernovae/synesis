# Security Policy

## Supported Versions

Project Synesis is currently experimental. Security fixes are applied to the `main` branch only.

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Project Synesis, please **do not** open a public GitHub issue.

Instead, please report it through one of the following channels:

1. **GitHub Security Advisory** (preferred): Use the [Security Advisories](https://github.com/supernovae/synesis/security/advisories) tab to privately report the vulnerability.
2. **Email**: Contact the maintainers directly.

We will acknowledge receipt within 48 hours and provide an initial assessment within 5 business days.

## Scope

The following are in scope for security reports:

- Container image vulnerabilities in Synesis-built images
- Kubernetes manifest misconfigurations (privilege escalation, missing SCCs, etc.)
- Code execution sandbox escapes
- Secret exposure in logs, manifests, or environment variables
- Authentication/authorization bypasses in the API gateway

## Out of Scope

- Vulnerabilities in upstream dependencies that have already been reported (e.g., vLLM, LiteLLM, Milvus)
- Denial-of-service attacks against development/test environments
- Social engineering

## CI/CD Security Tooling

All checks run on every push to `main` and on pull requests:

| Tool | What it checks | Blocks merge |
|------|---------------|--------------|
| **CodeQL** | Semantic code analysis (Python) | Yes |
| **Bandit** | Python-specific security patterns (medium+ severity) | Yes |
| **Trivy** | K8s/Dockerfile misconfiguration, secrets (HIGH/CRITICAL) | Yes |
| **Semgrep** | OWASP Top 10, Python security rules | Yes |
| **pip-audit** | Known vulnerabilities in Python dependencies | Yes |
| **Ruff** | Lint + flake8-bandit (S-class) security rules | Yes |
| **ShellCheck** | Shell script analysis | Yes |
| **Hadolint** | Dockerfile best practices | Yes |
| **Dependabot** | Dependency version alerts | Advisory |

Suppressions are documented in-code (`# nosec`, `# nosemgrep`) and in `.trivyignore`.

### pip-audit: indexer and NLTK (transitive)

The RAG **indexer** depends on **Crawl4AI**, which pulls **nltk**. OSV currently reports **CVE-2026-33230**, **CVE-2026-33231**, and **GHSA-rf74-v2fm-23pw** for **nltk** through **3.9.3**, and **there is no newer fixed release on PyPI** yet. The indexer does not run NLTK’s `wordnet_app` web UI; risk from these advisories is assessed as **low** for our usage. The **Security Scan** workflow applies **pip-audit `ignore-vulns` only to the indexer matrix job** (not the whole monorepo). **Revisit** when **nltk** publishes a patched version, then drop the ignores and add an explicit `nltk>=…` constraint if needed.

## Known Acceptances (Development Phase)

The following items are accepted during active development and tracked for resolution before production release:

### Container image tags

All first-party images currently use `:latest` tags. This is intentional during rapid development where images are rebuilt frequently from `main`. Before production:

- [ ] Adopt semantic versioning for all Synesis-built images
- [ ] Pin third-party images to digest or semver (vLLM, LiteLLM, Milvus, SearXNG)
- [ ] Enforce tag immutability in the container registry

### Container registries

Images are currently pulled from public registries (`ghcr.io`, `quay.io`, `registry.redhat.io`, Docker Hub). Before production:

- [ ] Restrict to trusted/approved registries via OPA or Kyverno admission policies
- [ ] Mirror required third-party images into an organization-controlled registry
- [ ] Enable image signature verification (cosign/sigstore)

### Read-only root filesystem

`KSV-0014` (readOnlyRootFilesystem) is suppressed in `.trivyignore`. Many containers require writable paths for model caches, HuggingFace home, `/tmp`, and crawl state. Before production:

- [ ] Audit each container for minimum writable paths
- [ ] Enable `readOnlyRootFilesystem: true` with targeted `emptyDir` mounts

### CORS wildcard

The planner service defaults to `CORS_ORIGINS=*` for development. The value is configurable via the `SYNESIS_CORS_ORIGINS` environment variable. Before production:

- [ ] Set `SYNESIS_CORS_ORIGINS` to the specific frontend origin(s) in the deployment overlay

### Secrets in base manifests

Base Kubernetes manifests contain placeholder secrets (LiteLLM master key, WebUI API key, Milvus root password, SearXNG secret key). These are documented with `# SECURITY` comments. Before production:

- [ ] Replace all placeholder secrets via overlays using SealedSecrets or an external secret manager
- [ ] Ensure no plaintext secrets appear in deployed ConfigMaps/Secrets
