"""Developer Hub sync engine — pulls entities from Backstage and maps to ingestion items."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update

from ..db.engine import async_session
from ..db.models import (
    DevHubConnector,
    GovernanceClause,
    IngestionItem,
    IngestionSource,
)
from ..route_validation import validate_safe_identifier, validate_safe_text
from .catalog_client import CatalogClient, CatalogClientError, CatalogEntity

logger = logging.getLogger("synesis.admin.devhub_sync")


@dataclass
class SyncResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    errors: int = 0
    governance_clauses_created: int = 0
    governance_clauses_updated: int = 0
    used_cache: bool = False
    error_messages: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "created": self.created,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "errors": self.errors,
            "governance_clauses_created": self.governance_clauses_created,
            "governance_clauses_updated": self.governance_clauses_updated,
            "used_cache": self.used_cache,
            "error_messages": self.error_messages[:20],
        }


@dataclass
class PreviewItem:
    entity_ref: str
    kind: str
    name: str
    action: str  # "create" | "update" | "unchanged"
    golden_path_id: str | None = None
    content_profile: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_ref": self.entity_ref,
            "kind": self.kind,
            "name": self.name,
            "action": self.action,
            "golden_path_id": self.golden_path_id,
            "content_profile": self.content_profile,
        }


# ---------------------------------------------------------------------------
# Entity -> corpus mapping
# ---------------------------------------------------------------------------

_KIND_TO_HANDLER: dict[str, str] = {
    "Template": "devhub_template",
    "Component": "devhub_component",
    "API": "devhub_api",
    "System": "devhub_system",
    "Domain": "devhub_domain",
    "Resource": "devhub_resource",
}

_KIND_TO_CONTENT_PROFILE: dict[str, str] = {
    "Template": "procedural",
    "Component": "reference",
    "API": "api_spec",
    "System": "reference",
    "Domain": "reference",
    "Resource": "reference",
}

VALID_GOVERNANCE_CATEGORIES = {"safety", "compliance", "quality", "style", "architecture", "tooling", "process"}
VALID_CONSTRAINT_KINDS = {"hard", "guiding", "advisory"}


def _safe_external_text(value: Any, *, field_name: str, max_length: int, allow_empty: bool = True) -> str:
    candidate = " ".join(str(value or "").split())
    try:
        return validate_safe_text(candidate, field_name=field_name, max_length=max_length, allow_empty=allow_empty)
    except ValueError:
        if allow_empty:
            return ""
        raise


def _safe_external_identifier(value: Any, *, field_name: str, max_length: int) -> str:
    return validate_safe_identifier(str(value or ""), field_name=field_name, max_length=max_length)


def _safe_optional_external_identifier(value: Any, *, field_name: str, max_length: int) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return _safe_external_identifier(value, field_name=field_name, max_length=max_length)
    except ValueError:
        logger.warning("devhub_sync_invalid_annotation field=%s", field_name)
        return None


def _safe_constraint_kind(value: Any) -> str:
    candidate = str(value or "guiding").strip().lower()
    if candidate not in VALID_CONSTRAINT_KINDS:
        logger.warning("devhub_sync_invalid_annotation field=constraint_kind value=%s", candidate[:64])
        return "guiding"
    return candidate


def _safe_governance_category(value: Any) -> str:
    candidate = str(value or "architecture").strip().lower()
    if candidate not in VALID_GOVERNANCE_CATEGORIES:
        logger.warning("devhub_sync_invalid_annotation field=category value=%s", candidate[:64])
        return "architecture"
    return candidate


def _safe_devhub_clause_id(connector: DevHubConnector, entity: CatalogEntity) -> str:
    connector_token = _safe_external_identifier(connector.connector_id, field_name="connector_id", max_length=64)
    try:
        name_token = _safe_external_identifier(entity.metadata.name, field_name="entity_name", max_length=32)
        candidate = f"devhub-{connector_token}-{name_token}"
        if len(candidate) <= 64:
            return candidate
    except ValueError:
        pass
    digest = hashlib.sha256(f"{connector_token}:{entity.entity_ref}".encode()).hexdigest()[:16]
    return f"devhub-{connector_token[:40]}-{digest}"


def _entity_content_hash(entity: CatalogEntity) -> str:
    payload = json.dumps(entity.to_dict(), sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _build_uri(connector_id: str, entity: CatalogEntity) -> str:
    return f"devhub://{connector_id}/{entity.entity_ref}"


def _entity_to_tags(entity: CatalogEntity) -> list[str]:
    tags = list(entity.metadata.tags)
    tags.append(f"devhub-kind:{entity.kind.lower()}")
    if entity.spec.get("type"):
        tags.append(f"devhub-type:{entity.spec['type']}")
    if entity.spec.get("lifecycle"):
        tags.append(f"lifecycle:{entity.spec['lifecycle']}")
    return tags[:20]


def _entity_to_synesis_meta(connector_id: str, entity: CatalogEntity) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "backstage_entity_ref": entity.entity_ref,
        "constraint_source": "developer-hub",
        "content_profile": _KIND_TO_CONTENT_PROFILE.get(entity.kind, "reference"),
    }
    if entity.kind == "Template":
        meta["golden_path_id"] = entity.metadata.name
    constraint_kind = entity.metadata.annotations.get("synesis.io/constraint-kind")
    if constraint_kind:
        meta["constraint_kind"] = _safe_constraint_kind(constraint_kind)
    scope_tags = entity.metadata.annotations.get("synesis.io/scope-tags")
    if scope_tags:
        safe_scope_tags = _safe_external_text(scope_tags, field_name="scope_tags", max_length=256)
        if safe_scope_tags:
            meta["scope_tags"] = safe_scope_tags
    return meta


def _map_entity_to_item_fields(
    connector: DevHubConnector,
    entity: CatalogEntity,
) -> dict[str, Any]:
    uri = _build_uri(connector.connector_id, entity)
    title = entity.metadata.title or entity.metadata.name
    description = entity.metadata.description or ""
    handler = _KIND_TO_HANDLER.get(entity.kind, "devhub_entity")
    tags = _entity_to_tags(entity)
    synesis_meta = _entity_to_synesis_meta(connector.connector_id, entity)

    config: dict[str, Any] = {
        "url": uri,
        "tags": tags,
        "synesis_meta": synesis_meta,
        "devhub_spec": entity.spec,
        "devhub_entity_ref": entity.entity_ref,
    }
    if description:
        config["context_prefix"] = f"{entity.kind}: {title} — {description}"

    return {
        "uri": uri,
        "handler": handler,
        "title": title,
        "domain": entity.spec.get("system", entity.spec.get("domain", "devhub")),
        "authority": "vetted",
        "origin_type": "curated",
        "tags": tags,
        "visibility_scope": connector.scope if connector.scope != "org" else "org",
        "org_id": connector.org_id,
        "config": config,
        "content_hash": _entity_content_hash(entity),
    }


# ---------------------------------------------------------------------------
# Sync engine
# ---------------------------------------------------------------------------


async def _ensure_ingestion_source(connector: DevHubConnector) -> int:
    """Get or create a single IngestionSource for this connector."""
    source_name = f"DevHub: {connector.name}"
    async with async_session() as session:
        existing = (
            await session.execute(
                select(IngestionSource).where(
                    IngestionSource.handler == "devhub_sync",
                    IngestionSource.name == source_name,
                )
            )
        ).scalar_one_or_none()

        if existing:
            return existing.id

        row = IngestionSource(
            name=source_name,
            handler="devhub_sync",
            origin_type="curated",
            authority="vetted",
            domain="devhub",
            config={"connector_id": connector.connector_id},
            tags=["developer-hub", "backstage"],
            visibility_scope=connector.scope if connector.scope != "org" else "org",
            org_id=connector.org_id,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row.id


async def _upsert_item(
    source_id: int,
    item_fields: dict[str, Any],
    result: SyncResult,
) -> str:
    """Create or update a single IngestionItem, returning the action taken."""
    async with async_session() as session:
        existing = (
            await session.execute(select(IngestionItem).where(IngestionItem.uri == item_fields["uri"]))
        ).scalar_one_or_none()

        if existing:
            if existing.content_hash == item_fields["content_hash"]:
                result.unchanged += 1
                return "unchanged"

            await session.execute(
                update(IngestionItem)
                .where(IngestionItem.id == existing.id)
                .values(
                    title=item_fields["title"],
                    domain=item_fields["domain"],
                    tags=item_fields["tags"],
                    config=item_fields["config"],
                    content_hash=item_fields["content_hash"],
                    status="pending",
                    error_message="",
                    retry_count=0,
                )
            )
            await session.commit()
            result.updated += 1
            return "update"

        row = IngestionItem(
            source_id=source_id,
            **item_fields,
            status="pending",
        )
        session.add(row)
        await session.commit()
        result.created += 1
        return "create"


async def sync_connector(connector_id: str, dry_run: bool = False) -> SyncResult | list[PreviewItem]:
    """Sync entities from a Developer Hub connector into the ingestion pipeline.

    If dry_run=True, returns a list of PreviewItem instead of actually mutating.
    """
    result = SyncResult()

    async with async_session() as session:
        connector = (
            await session.execute(select(DevHubConnector).where(DevHubConnector.connector_id == connector_id))
        ).scalar_one_or_none()
        if not connector:
            raise ValueError(f"Connector {connector_id} not found")
        if not connector.enabled:
            raise ValueError(f"Connector {connector_id} is disabled")

    entity_kinds = connector.entity_kinds or ["Template", "Component", "API", "System"]
    entities: list[CatalogEntity] = []

    client = CatalogClient(
        base_url=connector.base_url,
        auth_type=connector.auth_type,
        auth_token_ref=connector.auth_token_ref,
    )
    try:
        entities = await client.list_entities(kinds=entity_kinds)
    except CatalogClientError as exc:
        logger.warning("devhub_sync_fetch_failed connector=%s error=%s", connector_id, exc)
        if connector.cached_entity_snapshot:
            from .catalog_client import _parse_entity

            entities = [_parse_entity(e) for e in connector.cached_entity_snapshot.get("entities", [])]
            result.used_cache = True
            logger.info("devhub_sync_using_cache connector=%s entities=%d", connector_id, len(entities))
        else:
            result.errors += 1
            result.error_messages.append(f"Fetch failed and no cache available: {exc}")
            await _update_connector_status(connector_id, "error", result.to_dict())
            return result
    finally:
        await client.close()

    if dry_run:
        return await _preview_sync(connector, entities)

    source_id = await _ensure_ingestion_source(connector)

    for entity in entities:
        try:
            item_fields = _map_entity_to_item_fields(connector, entity)
            await _upsert_item(source_id, item_fields, result)
        except Exception as exc:
            result.errors += 1
            result.error_messages.append(f"{entity.entity_ref}: {exc}")
            logger.error("devhub_sync_item_error entity=%s error=%s", entity.entity_ref, exc)

    if not result.used_cache:
        snapshot = {"entities": [e.to_dict() for e in entities], "synced_at": datetime.now(UTC).isoformat()}
        await _update_connector_cache(connector_id, snapshot)

    gov_result = await _bridge_governance(connector, entities)
    result.governance_clauses_created = gov_result.get("created", 0)
    result.governance_clauses_updated = gov_result.get("updated", 0)

    status = "ok" if result.errors == 0 else "partial"
    if result.used_cache:
        status = "fallback_cached"
    await _update_connector_status(connector_id, status, result.to_dict())

    logger.info(
        "devhub_sync_complete connector=%s created=%d updated=%d unchanged=%d errors=%d",
        connector_id,
        result.created,
        result.updated,
        result.unchanged,
        result.errors,
    )
    return result


async def _preview_sync(
    connector: DevHubConnector,
    entities: list[CatalogEntity],
) -> list[PreviewItem]:
    """Dry-run: compare entities with existing items to predict actions."""
    preview: list[PreviewItem] = []

    async with async_session() as session:
        for entity in entities:
            item_fields = _map_entity_to_item_fields(connector, entity)
            existing = (
                await session.execute(select(IngestionItem).where(IngestionItem.uri == item_fields["uri"]))
            ).scalar_one_or_none()

            if not existing:
                action = "create"
            elif existing.content_hash != item_fields["content_hash"]:
                action = "update"
            else:
                action = "unchanged"

            meta = _entity_to_synesis_meta(connector.connector_id, entity)
            preview.append(
                PreviewItem(
                    entity_ref=entity.entity_ref,
                    kind=entity.kind,
                    name=entity.metadata.name,
                    action=action,
                    golden_path_id=meta.get("golden_path_id"),
                    content_profile=meta.get("content_profile"),
                )
            )

    return preview


async def _update_connector_status(connector_id: str, status: str, summary: dict) -> None:
    async with async_session() as session:
        await session.execute(
            update(DevHubConnector)
            .where(DevHubConnector.connector_id == connector_id)
            .values(
                last_sync_at=datetime.now(UTC),
                last_sync_status=status,
                last_sync_summary=summary,
                updated_at=datetime.now(UTC),
            )
        )
        await session.commit()


async def _update_connector_cache(connector_id: str, snapshot: dict) -> None:
    async with async_session() as session:
        await session.execute(
            update(DevHubConnector)
            .where(DevHubConnector.connector_id == connector_id)
            .values(cached_entity_snapshot=snapshot)
        )
        await session.commit()


# ---------------------------------------------------------------------------
# Governance bridge — opt-in via synesis.io annotations on templates
# ---------------------------------------------------------------------------

GOVERNANCE_ANNOTATION = "synesis.io/governance-constitution"
CONSTRAINT_KIND_ANNOTATION = "synesis.io/constraint-kind"
CATEGORY_ANNOTATION = "synesis.io/governance-category"
RECIPE_ANNOTATION = "synesis.io/validation-recipe"


async def _bridge_governance(
    connector: DevHubConnector,
    entities: list[CatalogEntity],
) -> dict[str, int]:
    """For Template entities with governance annotations, auto-create/update clauses."""
    created = 0
    updated = 0

    templates = [e for e in entities if e.kind == "Template"]
    if not templates:
        return {"created": 0, "updated": 0}

    async with async_session() as session:
        for tmpl in templates:
            constitution_id = _safe_optional_external_identifier(
                tmpl.metadata.annotations.get(GOVERNANCE_ANNOTATION),
                field_name="constitution_id",
                max_length=64,
            )
            if not constitution_id:
                continue

            clause_id = _safe_devhub_clause_id(connector, tmpl)
            constraint_kind = _safe_constraint_kind(tmpl.metadata.annotations.get(CONSTRAINT_KIND_ANNOTATION))
            category = _safe_governance_category(tmpl.metadata.annotations.get(CATEGORY_ANNOTATION))
            recipe_id = _safe_optional_external_identifier(
                tmpl.metadata.annotations.get(RECIPE_ANNOTATION),
                field_name="validation_recipe_id",
                max_length=128,
            )

            description = _safe_external_text(
                tmpl.metadata.description or tmpl.metadata.title or tmpl.metadata.name,
                field_name="statement",
                max_length=4000,
            ) or _safe_external_text(tmpl.entity_ref, field_name="statement", max_length=4000, allow_empty=False)
            spec_params = tmpl.spec.get("parameters")
            if spec_params:
                param_summary = _safe_external_text(
                    json.dumps(spec_params, default=str)[:500],
                    field_name="template_parameters",
                    max_length=500,
                )
                if param_summary:
                    description = f"{description} Template parameters: {param_summary}"[:4500]

            existing = (
                await session.execute(select(GovernanceClause).where(GovernanceClause.clause_id == clause_id))
            ).scalar_one_or_none()

            if existing:
                await session.execute(
                    update(GovernanceClause)
                    .where(GovernanceClause.clause_id == clause_id)
                    .values(
                        constitution_id=constitution_id,
                        category=category,
                        constraint_kind=constraint_kind,
                        statement=description,
                        validation_recipe_id=recipe_id,
                        machine_rule={"backstage_entity_ref": tmpl.entity_ref, "connector_id": connector.connector_id},
                    )
                )
                updated += 1
            else:
                clause = GovernanceClause(
                    clause_id=clause_id,
                    constitution_id=constitution_id,
                    category=category,
                    constraint_kind=constraint_kind,
                    statement=description,
                    validation_recipe_id=recipe_id,
                    machine_rule={"backstage_entity_ref": tmpl.entity_ref, "connector_id": connector.connector_id},
                    enabled=True,
                    priority=0,
                )
                session.add(clause)
                created += 1

        await session.commit()

    return {"created": created, "updated": updated}
