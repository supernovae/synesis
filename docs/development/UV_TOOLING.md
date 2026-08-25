# uv tooling — Python dependency management

Synesis uses [uv](https://docs.astral.sh/uv/) for Python resolution,
installation, project environments, and one-shot developer tools. Runtime,
benchmark, and evaluation dependencies use committed, SHA-256-hashed
`requirements.lock` files; the root development environment uses `uv.lock`.

## Source and lock policy

- Edit `requirements.txt` to express dependency intent. Do not hand-edit its
  generated `requirements.lock`.
- Generate locks with `./scripts/lock-deps.sh`. The script targets Python 3.12
  on Linux x86_64 and constrains child-image dependencies to their base-image
  lock where applicable.
- Install deployable environments from `requirements.lock` with
  `--require-hashes`.
- Use `uv sync --locked` or `uv run --locked` for the root `pyproject.toml` /
  `uv.lock` development environment.
- Comment-only service requirement files intentionally inherit all packages
  from their locked base image and therefore do not produce an additional
  lockfile.

```bash
# Verify every managed requirements lock without changing it.
./scripts/lock-deps.sh --check

# Refresh one environment after editing its requirements.txt.
./scripts/lock-deps.sh indexer

# Refresh all environments in dependency order.
./scripts/lock-deps.sh
```

The lockfile freshness job runs a change-aware check on pull requests and
pushes, plus a complete scheduled check. `pip-audit` scans every non-empty
requirements environment in the security matrix.

## Local development

Install uv with Homebrew or Astral's installer:

```bash
brew install uv
# or: curl -LsSf https://astral.sh/uv/install.sh | sh
```

For root development tools and tests:

```bash
uv sync --locked --group dev
uv run --locked --group dev pytest
```

For a service or benchmark:

```bash
uv venv .venv --python 3.12
uv pip install --require-hashes -r base/rag/indexer/requirements.lock
```

Use `uvx` for isolated one-shot tools such as Ruff, Bandit, and yamllint. CI
pins these invocations where reproducibility or security gating requires it.

## CI pattern

Current workflows use `astral-sh/setup-uv@v7`, Python 3.12, and cache keys based
on the lockfile:

```yaml
- uses: astral-sh/setup-uv@v7
  with:
    enable-cache: true
    cache-dependency-glob: "tests/prompts/requirements.lock"

- uses: actions/setup-python@v7
  with:
    python-version: "3.12"

- name: Install dependencies
  run: uv pip install --system --require-hashes -r tests/prompts/requirements.lock
```

The `pip-audit` jobs consume the already resolved locks with `--disable-pip`,
so the vulnerability result does not depend on a second resolver pass.

## Container pattern

Base and child images install into the application virtual environment. A
typical locked layer is:

```dockerfile
COPY requirements.lock .
RUN uv pip install --python /opt/app-root/venv/bin/python \
    --no-cache --require-hashes -r requirements.lock
```

Standalone images use the same lock-and-hash rule with their own interpreter.
The quality runner installs the corpus and curator locks together because it
contains both tools.

## Rollback and incident response

The human-maintained `requirements.txt` remains portable to pip, but replacing
uv in CI or images is an explicit reviewed change: retain exact versions and
hash verification when changing installers. If a lock is suspected of being
compromised, regenerate it from the reviewed input, inspect the diff, run the
full freshness and `pip-audit` gates, and rebuild the affected image rather
than weakening `--require-hashes`.
