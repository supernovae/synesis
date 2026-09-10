# Security policy

Synesis is experimental. Fixes are applied to `main`; there is no response-time SLA or hosted service. See the [local access and integrity boundaries](../docs/SECURITY.md).

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/supernovae/synesis/security/advisories). Do not include private source material in public issues.

## Scope

Relevant issues include source-root escape, unintended file access, source-pack integrity or version reassignment, unbounded parsing/decompression, disclosure across a configured library/client boundary, and vulnerable retained dependencies. Report dependency findings that affect this checkout, even if an upstream advisory exists.

The retired platform has no supported gateway, remote Admin API, execution sandbox, model service or deployment. The local library is accessible to its OS user and every client explicitly configured to read it; it does not implement per-document multi-tenant authorization or copy revocation.

## Automated checks

CI runs CodeQL for Python and TypeScript, Bandit, Semgrep, Grype, npm audit and pip-audit, plus language/shell lint and local contract tests. Applicable findings fail their workflows. Branch protection is repository configuration, not a guarantee made by these files. Scanners and tests do not establish absence of vulnerabilities.

Container image, Kubernetes and Helm checks were removed with those artifacts. There is no image publication workflow or image SBOM promise. The package artifact workflow builds a local tarball; it does not publish an npm release.

## Dependency handling

The root npm lockfile covers the sole TypeScript workspace and development tools. CI installs with `npm ci --ignore-scripts`, without an install fallback. A separate package-install check verifies that the packed reader works without root overrides or unrelated workspaces.

The optional ingestion environment has one `requirements.txt` and a generated lockfile with selected versions and SHA-256 hashes. It targets Python 3.12/Linux for CI; the saved-HTML command independently declares its smaller script environment. Neither Python environment is needed to run the Node reader.

```bash
./scripts/lock-deps.sh          # intentionally resolve available versions
./scripts/lock-deps.sh --check  # validate declared requirements at existing pins
```

The check seeds the resolver with the committed pins. New available releases alone do not invalidate the lock; changed or removed requirements do. A local-wheel regression test verifies this behavior. Vulnerability scans and intentional version updates remain separate responsibilities.

The former Crawl4AI/NLTK/browser/model-client dependency path is removed. The remaining ingestion code has no database, telemetry, embedding or model-client dependency. Review dependency changes for their actual retained use; do not restore abandoned service stacks to satisfy obsolete lockfiles.
