# Corpus Ingestion and Annotation

## Objective

Make `bootstrap/corpus/*.yaml` consistently useful for:

- Planner/OpenWebUI exploration
- Yarn/Coder implementation quality
- MCP tool retrieval paths

## Dual-Track Corpus Classes

- `coder_enriched`: coding and platform standards content
- `general`: broader domain knowledge (for example product, cloud context, music domain information)
- `hybrid`: sources useful for both

## Routing Policy

- Planner/OpenWebUI can retrieve from both classes by default.
- Yarn/Coder prioritizes `coder_enriched`, then blends `general` when task intent is cross-domain.
- Deterministic fix suggestions must use high-authority `coder_enriched` evidence.

## Annotation Template v1

Required per source entry:

- `title`
- `handler`
- `uri`
- `origin_type`
- `authority`
- `domain`
- `content_profile`
- `languages`
- `artifact_kind`
- `freshness_sla_days`
- `scope_tags`
- `corpus_class`
- `constraint_kind` (`hard` | `guiding` | `advisory`)
- `config`

Recommended fields:

- `golden_path_id`
- `validation_recipe_id`
- `constraint_domain`
- `constraint_source`
- `source_owner`
- `review_status`
- `backstage_entity_ref`

### Scope tags vocabulary (purpose-oriented)

- `language-spec` — official specification / grammar
- `error-catalog` — compiler/runtime error messages and fixes
- `linter-rules` — linter rule database with explanations
- `style-guide` — formatting and naming conventions
- `testing-framework` — test runner and assertion reference
- `package-manager` — dependency management documentation
- `build-tool` — compilation / bundling / toolchain reference
- `common-patterns` — idiomatic patterns and best practices
- `security` — language-specific security guidance
- `stdlib-reference` — standard library documentation

### Constraint kind semantics

- `hard` — language specs, compiler errors, type system rules: ground truth for deterministic answers
- `guiding` — linter rules, style guides, official best practices: strong defaults, overridable by project rules
- `advisory` — blog posts, community patterns, papers: context for LLM, not authoritative

## Ingestion Guidance UX

Admin ingestion flow should:

1. classify source (`coder_enriched`, `general`, `hybrid`)
2. sample source content and estimate technical relevance
3. recommend missing metadata and enrichment mode
4. preview retrieval behavior for Planner and Yarn
5. support human override with audit reason

## Loader Enhancements

- metadata completeness gates
- class-specific enrichment requirements
- contradiction detection and review queue hooks
- authority-aware dedupe/ranking
- reindex/backfill workflows for new fields
