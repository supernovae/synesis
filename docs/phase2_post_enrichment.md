# Phase 2 Post-Enrichment Ideas

This tracks platform capabilities discovered while building language SynPacks.
These are not required for schema v17 pack creation, but they would make the
upper harness more decisive for small and OSS coding models.

## Python Repo Maps

- Promote `artifact_kind=repo_map` from logical rows to indexed schema fields if
  usage proves high: `map_level`, `center_of_gravity`, and `dependency_edge`.
- Add a hierarchical retrieval mode: project map search, module zoom, then
  surgical code fetch.
- Evaluate session-scoped repo maps in Milvus, Redis, or local memory for
  user workspaces that should not become global knowledge.
- Generate maps from `pyproject.toml`, `__init__.py`, public exports, imports,
  module docstrings, type hints, and side-effect signals.

## UV And Environment Tools

- Consider guarded MCP tools for `uv add`, `uv sync`, `uv run`, and
  `uv run pytest`, with explicit working-directory and mutation policies.
- Prefer guidance-only mode until command safety and user-confirmation behavior
  is designed for every client harness.
- Use pack metadata to steer agents away from manual dependency edits when
  `uv` or lockfile-aware commands are safer.

## Search-Space Control

- Teach agents to query architecture/map partitions before broad text search in
  large repos.
- Use language-pack metadata as retrieval pivots: compiler errors for Rust,
  build-time config for Quarkus, repo maps and type stubs for Python.
- Track repeated broad searches as a harness smell and nudge toward map-first
  retrieval when results are noisy.

## Future Schema Candidates

- First-class `map_level`, `center_of_gravity`, `edition_scope`, and
  `command_safety` fields.
- Indexed `error_code`/`pep_id` fields if logical `symbol_fqn` is not enough.
- Pack-specific retrieval profiles that automatically set filters for common
  workflows such as Python SWE-bench, Quarkus config debugging, or Rust borrow
  checker repair.
