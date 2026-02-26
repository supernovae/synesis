# Contributing to Project Synesis

Thank you for your interest in contributing! This document provides guidelines to help you get started.

## Getting Started

1. Fork the repository and clone your fork
2. Create a feature branch from `main`
3. Make your changes following the standards below
4. Run the linters locally before pushing
5. Open a pull request against `main`

## Development Setup

```bash
# Install Python tooling
pip install ruff yamllint

# Install ShellCheck (macOS)
brew install shellcheck

# Install ShellCheck (Fedora/RHEL)
sudo dnf install ShellCheck

# Install hadolint for Dockerfile linting
brew install hadolint
```

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

### YAML / Kubernetes Manifests

YAML files are validated with [yamllint](https://yamllint.readthedocs.io/). Configuration lives in `.yamllint.yml`.

```bash
yamllint -c .yamllint.yml base/ overlays/ models.yaml
```

Kustomize overlays must build cleanly:

```bash
kustomize build overlays/dev > /dev/null
kustomize build overlays/staging > /dev/null
kustomize build overlays/prod > /dev/null
```

### Dockerfiles

Dockerfiles are linted with [hadolint](https://github.com/hadolint/hadolint):

```bash
find base/ -name Dockerfile | xargs hadolint
```

## Commit Messages

- Use imperative mood: "Add feature" not "Added feature"
- Keep the subject line under 72 characters
- Reference issues when applicable: "Fix sandbox timeout (#42)"

## Pull Request Checklist

- [ ] All linters pass locally (`ruff check`, `shellcheck`, `yamllint`, `hadolint`)
- [ ] Kustomize builds succeed for all overlays
- [ ] New shell scripts have `set -euo pipefail`
- [ ] New Python files follow the existing patterns in `base/`
- [ ] New Kubernetes resources include appropriate labels (`app.kubernetes.io/*`)
- [ ] `README.md` is updated if adding new features or changing architecture
- [ ] No secrets, credentials, or API keys in the commit

## Security

If you discover a security vulnerability, please report it privately by opening a GitHub Security Advisory rather than a public issue.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
