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
  build-time config for Quarkus, repo maps and type stubs for Python, and
  class/signal/lifecycle rows for Godot.
- Track repeated broad searches as a harness smell and nudge toward map-first
  retrieval when results are noisy.

## Godot Scene And Asset Awareness

- Add a guarded `godot_scene_mapper` MCP tool that reads `.tscn`, `.scn`, and
  project settings to summarize the active scene tree before an agent edits
  scripts.
- Use Godot pack metadata to join local scene nodes to class-reference rows:
  `node_compatibility`, `signal_contract`, lifecycle order, thread safety, and
  legacy Godot 3.x warnings.
- Consider a local-only scene map partition for large games: node path, script
  path, groups, exported properties, signals, autoloads, input map actions, and
  resource dependencies.
- Add headless validation helpers for `godot --headless --check-only`,
  GDScript parse checks, imported resource checks, and minimal scene smoke runs.
- Track fine-tuning export formats from enriched rows: prompt, raw source
  excerpt, enrichment JSON, and preferred agent advice pairs. Godot is a good
  candidate because Godot 3.x/4.x differences are compact and high-impact.

## Terraform Risk-Aware Harness

- Generalize the Terraform plan analyzer into a reusable risk middleware for
  other language packs: ingest local action graphs, join SynPack metadata, emit
  hard/soft approval gates, and return agent directives.
- Add a private `live_state` partition populated from `terraform show -json`
  for workspace/tenant state. Never store live state in global packs.
- Add guarded drift discovery tools for AWS/Azure/GCP inventories. Match by
  tags/project/workspace, compare against state, and return unmanaged-resource
  candidates without importing automatically.
- Add an approval API/UI for destructive actions with reject-with-directive
  feedback. Store the plan excerpt, SynPack metadata, agent rationale, human
  decision, and follow-up directive in an audit log.
- Add safe import workflows later: propose import blocks, show import ID format,
  require human approval for production/high-sensitivity resources, then ask the
  agent to generate zero-diff HCL from refreshed state.
- Add Terraform sandbox benchmarks using LocalStack or dry-run state fixtures:
  unmanaged subnet import, RDS replacement avoidance, IAM overpermission lint,
  and circular dependency repair.

## Future Schema Candidates

- First-class `map_level`, `center_of_gravity`, `edition_scope`, and
  `command_safety` fields.
- First-class Godot `node_class`, `signal_name`, `scene_tree_role`, and
  `engine_major_version` fields if Godot usage warrants indexed filtering.
- First-class Terraform `resource_type`, `provider_address`, `core_safety`,
  `force_new_fields`, `import_id_format`, and `state_sensitivity` fields if
  plan analysis becomes a common query path.
- Indexed `error_code`/`pep_id` fields if logical `symbol_fqn` is not enough.
- Pack-specific retrieval profiles that automatically set filters for common
  workflows such as Python SWE-bench, Quarkus config debugging, or Rust borrow
  checker repair.
