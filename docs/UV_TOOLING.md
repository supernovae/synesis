# UV Tooling — Python Dependency Management

Synesis standardizes on [uv](https://docs.astral.sh/uv/) for Python dependency
installation across local development, CI, and container builds.

---

## Why uv

- **Faster installs**: 10-100x faster than pip for cold installs.
- **Consistent resolution**: same resolver locally, in CI, and in containers.
- **Drop-in replacement**: reads `requirements.txt` natively — no migration of
  existing dependency files required.
- **Single binary**: no Python bootstrap needed for tool installation.

---

## Local Development

### Install uv

```bash
# macOS (Homebrew)
brew install uv

# Standalone installer (any platform)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Install service dependencies

```bash
# System-wide (into your active Python)
cd base/planner
uv pip install --system -r requirements-test.txt

# Or create a venv first
uv venv .venv
source .venv/bin/activate
uv pip install -r requirements-test.txt
```

### Run one-shot tools without installing

```bash
uvx ruff check base/
uvx ruff format --check base/
uvx yamllint -c .yamllint.yml base/
uvx "bandit[toml]" -r base/
uvx semgrep scan --config ... base/
```

---

## CI Workflows

All GitHub Actions workflows use [astral-sh/setup-uv](https://github.com/astral-sh/setup-uv)
with dependency caching:

```yaml
- uses: astral-sh/setup-uv@v5
  with:
    enable-cache: true
    cache-dependency-glob: "base/planner/requirements*.txt"

- uses: actions/setup-python@v6
  with:
    python-version: "3.13"

- name: Install dependencies
  run: uv pip install --system -r requirements.txt
```

For single-use linters/scanners, `uvx` avoids installing into the runner:

```yaml
- name: Ruff check
  run: uvx ruff check base/ --output-format=github
```

### pip-audit exception

The `pypa/gh-action-pip-audit` action uses its own pip-based resolution
internally. It reads `requirements.txt` files directly and does not depend on
how we install in containers. This is left unchanged intentionally.

---

## Container Builds

### Base images

`base-api` and `base-devtools` (the two root base images) include uv via a
multi-stage `COPY`:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
```

All child images inherit uv automatically.

### Standalone images (not based on base-api)

Images like the indexer and MCP that use `python:3.x-slim` or UBI directly also
include the same `COPY --from` line.

### Install pattern

```dockerfile
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt
```

`--system` installs into the system Python (no venv in containers).
`--no-cache` keeps the image layer small (equivalent to pip's `--no-cache-dir`).

---

## Rollback

If uv causes issues in a specific context:

1. **CI**: Replace `uv pip install --system` with `pip install` and remove the
   `astral-sh/setup-uv` step. The `setup-python` action already provides pip.
2. **Containers**: Replace `uv pip install --system --no-cache` with
   `pip install --no-cache-dir` and remove the `COPY --from=ghcr.io/astral-sh/uv`
   line. The base Python images already include pip.
3. **Local**: `pip install -r requirements.txt` continues to work since
   `requirements.txt` files are unchanged.

All `requirements.txt` files remain the source of truth — no lockfiles or
`pyproject.toml` migration is required for rollback.

---

## Future: Lock Hardening (Phase 3)

When strict reproducibility is needed:

```bash
uv pip compile requirements.txt -o requirements.lock
uv pip install --system -r requirements.lock
```

This pins every transitive dependency to exact versions. The lock can be
committed and audited. This is not yet enabled — current requirements.txt
files use range specifiers which uv resolves at install time.
