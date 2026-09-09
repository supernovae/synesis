# Contributing to Project Synesis

Thank you for your interest in contributing! This document provides guidelines to help you get started.

## Getting Started

1. Fork the repository and clone your fork
2. Create a feature branch from `main`
3. Make your changes following the standards below
4. Run the linters locally before pushing
5. Open a pull request against `main`

## Development Checks

Use the [development checks](docs/development/DEVELOPMENT_CHECKS.md) and
[testing guide](docs/development/TESTING.md) for the service you change. TypeScript
workspaces provide build and test scripts; live provider checks require a
configured deployment and credentials. Run the relevant local checks before
requesting review and report any checks you could not run.

## Development Setup

```bash
# Install uv (recommended — used in CI and containers)
# macOS
brew install uv
# or standalone installer
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python tooling via uv
uvx ruff check base/        # no install needed — uvx runs tools ephemerally
uvx yamllint -c .yamllint.yml base/

# Install ShellCheck (macOS)
brew install shellcheck

# Install ShellCheck (Fedora/RHEL)
sudo dnf install ShellCheck

# Install hadolint for Dockerfile linting
brew install hadolint

# Use the repository's tracked commit hooks
make install-hooks
```

## Local Quality Gates

The repository includes tracked Git hooks under `.githooks/`.

```bash
make quality       # quick local parity with lint/doc CI checks
make quality-full  # quick checks plus TypeScript/frontend build and tests
npm run lint       # ESLint for TypeScript/JavaScript workspaces and services
```

The pre-commit hook checks staged whitespace, likely secrets, Ruff formatting/linting for Python, yamllint for YAML, and ShellCheck for shell scripts. The pre-push hook runs `make quality` unless `SYNESIS_SKIP_PRE_PUSH=1` is set. `make quality` also runs `scripts/check-authz-coverage.py`, which fails when admin or MCP routes are added without explicit auth/authz coverage.

## Code Standards

### Shell Scripts

All shell scripts must pass [ShellCheck](https://www.shellcheck.net/) at `warning` severity:

```bash
shellcheck --severity=warning scripts/*.sh
```

Key conventions:
- Use `#!/usr/bin/env bash` and `set -euo pipefail`
- Quote all variable expansions: `"$VAR"` not `$VAR`
- Use `[[` instead of `[` for conditionals
- Use `$(command)` instead of backticks

### Python

Python code is linted and formatted with [ruff](https://docs.astral.sh/ruff/). Configuration lives in `pyproject.toml`.

```bash
# Check for lint errors
ruff check base/

# Auto-fix what can be fixed
ruff check --fix base/

# Check formatting
ruff format --check base/

# Auto-format
ruff format base/
```

### TypeScript / JavaScript

TypeScript and JavaScript code is linted with ESLint. The root config covers
workspace packages and services; the admin frontend keeps its React-specific
config under `base/admin/frontend/`.

```bash
npm run lint
cd base/admin/frontend && npm run lint
```

### YAML / Kubernetes Manifests

YAML files are validated with [yamllint](https://yamllint.readthedocs.io/). Configuration lives in `.yamllint.yml`.

```bash
yamllint -c .yamllint.yml base/ overlays/
```

Build the overlays affected by your change, for example:

```bash
kustomize build overlays/api > /dev/null
```

### Dockerfiles

Dockerfiles are linted with [hadolint](https://github.com/hadolint/hadolint):

```bash
find base/ -name Dockerfile | xargs hadolint
```

## Documentation claims

Describe shipped behavior, prerequisites and configuration separately from design
goals. When changing a model adapter, endpoint or harness contract, update its
canonical reference and the README only where the project overview changes.

- Name the tested model/client versions and serving configuration. Recognition
  or a mocked protocol test is not live end-to-end certification.
- Support performance or quality claims with a reproducible workload, baseline,
  configuration and measured result. Label illustrative numbers as examples.
- Explain safety boundaries and recovery limits; avoid guarantees of safe
  execution, perfect recall or lossless compaction.
- Cite research as motivation unless the implementation and evaluations actually
  reproduce its method. Keep proposals and dated findings distinct from current defaults.
- Verify commands, defaults, file links and headings against the repository.
  Run `python3 scripts/check-doc-reference-integrity.py` for reference checks.

Current references: [harness compatibility](docs/clients/HARNESS_COMPATIBILITY.md),
[model behavior audit](docs/model-shim-audit-2026-09.md), and
[architecture controls](docs/model-architecture-awareness.md).

## Commit Messages

- Use imperative mood: "Add feature" not "Added feature"
- Keep the subject line under 72 characters
- Reference issues when applicable: "Fix sandbox timeout (#42)"

## Pull Request Checklist

- [ ] Relevant linters and tests pass; unrun checks are reported
- [ ] Affected deployment manifests build or render successfully
- [ ] New shell scripts have `set -euo pipefail`
- [ ] New Python files follow the existing patterns in `base/`
- [ ] New Kubernetes resources include appropriate labels (`app.kubernetes.io/*`)
- [ ] `README.md` is updated if adding new features or changing architecture
- [ ] No secrets, credentials, or API keys in the commit

## Security

If you discover a security vulnerability, please report it privately by opening a GitHub Security Advisory rather than a public issue.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
