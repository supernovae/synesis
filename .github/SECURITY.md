# Security policy

Synesis is experimental. Fixes are applied to `main`; there is no response-time SLA or hosted service. See the [local access and integrity boundaries](../docs/SECURITY.md).

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/supernovae/synesis/security/advisories). Do not include private source material in public issues.

## Scope

Relevant issues include source-root escape, unintended file access, source-pack integrity or version reassignment, unbounded parsing/decompression, disclosure across a configured library/client boundary, and vulnerable dependencies. Report dependency findings that affect this checkout, even if an upstream advisory exists.

The local library is accessible to its OS user and every client explicitly configured to read it. It does not implement per-document multi-tenant authorization or copy revocation.

## Automated checks

CI runs CodeQL for Python and TypeScript, Bandit, Semgrep, Grype, npm audit and pip-audit, plus language/shell lint and local contract tests. Applicable findings fail their workflows. Branch protection is repository configuration, not a guarantee made by these files. Scanners and tests do not establish absence of vulnerabilities.

The package artifact workflow builds a local tarball; it does not publish an npm release.

## Dependency handling

The root npm lockfile covers the sole TypeScript workspace and development tools. CI installs with `npm ci --ignore-scripts`, without an install fallback. A separate package-install check verifies that the packed reader works without root overrides or unrelated workspaces.

The saved-HTML script declares its dependencies inline. Its generated requirements lockfile records selected versions and SHA-256 hashes for Python 3.12/Linux CI. The Node reader does not require Python.

```bash
./scripts/lock-deps.sh          # intentionally resolve available versions
./scripts/lock-deps.sh --check  # validate declared requirements at existing pins
```

The check seeds the resolver with the committed pins. New available releases alone do not invalidate the lock; changed or removed requirements do. A local-wheel regression test verifies this behavior. Vulnerability scans and intentional version updates remain separate responsibilities.

The trial helper validates matching source snapshots and the known local MCP executable. It does not execute commands supplied by trial metadata. These checks verify setup and evidence consistency, not the behavior of a model or the client's other tools.

Dependabot manages npm and GitHub Actions updates. Python version updates are reviewed through the inline declaration and generated lockfile; this configuration does not depend on [pending inline-script update support](https://github.com/dependabot/dependabot-core/issues/11946). Scheduled CI continues auditing the resolved Python environment.
