"""Reusable NornicDB graph query abstractions for admin views."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from ..deps import CATALOG_COLLECTION, NORNIC_DATABASE, get_nornic_driver

logger = logging.getLogger("synesis.admin.nornic")

SCHEMA_VERSION = 20
EMBEDDING_DIM = 1024
DELETE_BATCH_SIZE = 500

_FILTER_EQ_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"\s*$')
_FILTER_NE_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*!=\s*"([^"]*)"\s*$')
_FILTER_IN_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\s+\[([^\]]*)\]\s*$")
_FILTER_FIELD_DEFAULTS = {
    # Older rows can predate the explicit review fields. Treat missing scan state
    # as unscanned so legacy content remains visible in the review queue.
    "scan_status": "unscanned",
}

_CONTENT_TEXT_CYPHER = "coalesce(n.text, n.content, n.chunk_summary, n.summary, '')"
_CONTENT_NODE_CASE_CYPHER = f"CASE WHEN {_CONTENT_TEXT_CYPHER} <> '' THEN 1 ELSE 0 END"
_STRICT_CHUNK_CASE_CYPHER = (
    f"CASE WHEN coalesce(n.kind, 'Chunk') = 'Chunk' AND {_CONTENT_TEXT_CYPHER} <> '' THEN 1 ELSE 0 END"
)
_DOCUMENT_KEY_CYPHER = "coalesce(n.doc_id, n.document_id, n.document_name, n.source_url, n.url, '')"
_SOURCE_KEY_CYPHER = "coalesce(n.source_url, n.url, n.document_name, n.doc_id, n.document_id, '')"
_CONTENT_NODE_KINDS = frozenset({"Chunk", "Concept", "Pattern", "Constraint", "Example", "ContextCard", "PackCard"})
_CONTENT_NODE_KIND_LIST_CYPHER = "['Chunk','Concept','Pattern','Constraint','Example','ContextCard','PackCard']"


def expected_graph_schema_version() -> int:
    return int(os.environ.get("SYNESIS_EXPECTED_GRAPH_SCHEMA_VERSION", str(SCHEMA_VERSION)))


def reported_graph_schema_version() -> int:
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            row = session.run(
                "MATCH (s:GraphSchema {name: $name}) RETURN s.version AS version LIMIT 1",
                name=CATALOG_COLLECTION,
            ).single()
            if not row:
                return 0
            return int(row["version"] or 0)
    except Exception as exc:
        logger.warning("nornic_schema_version_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return 0


def _delete_content_nodes_in_batches(session: Any, *, pack_id: str = "") -> int:
    deleted = 0
    while True:
        if pack_id:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                WHERE n.pack = $pack_id OR n.pack_id = $pack_id
                RETURN n.id AS id
                LIMIT $limit
                """,
                pack_id=pack_id,
                limit=DELETE_BATCH_SIZE,
            )
        else:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.id AS id
                LIMIT $limit
                """,
                limit=DELETE_BATCH_SIZE,
            )
        ids = [str(row["id"]) for row in rows if row.get("id")]
        if not ids:
            return deleted
        session.run("MATCH (n:ContentNode) WHERE n.id IN $ids DETACH DELETE n", ids=ids)
        deleted += len(ids)


def recreate_content_graph(collection: str = CATALOG_COLLECTION) -> dict[str, Any]:
    del collection
    try:
        schema_version = expected_graph_schema_version()
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            deleted = _delete_content_nodes_in_batches(session)
            session.run("CREATE CONSTRAINT content_node_id IF NOT EXISTS FOR (n:ContentNode) REQUIRE n.id IS UNIQUE")
            session.run("CREATE INDEX content_node_pack IF NOT EXISTS FOR (n:ContentNode) ON (n.pack)")
            session.run(
                "CREATE INDEX content_node_source_version IF NOT EXISTS FOR (n:ContentNode) ON (n.source_version)"
            )
            session.run("CREATE INDEX content_node_kind IF NOT EXISTS FOR (n:ContentNode) ON (n.kind)")
            session.run("CREATE INDEX content_node_domain IF NOT EXISTS FOR (n:ContentNode) ON (n.domain)")
            session.run("CREATE INDEX content_node_content_type IF NOT EXISTS FOR (n:ContentNode) ON (n.content_type)")
            session.run("CREATE INDEX content_node_language IF NOT EXISTS FOR (n:ContentNode) ON (n.language)")
            session.run("CREATE INDEX content_node_package IF NOT EXISTS FOR (n:ContentNode) ON (n.package_name)")
            session.run("CREATE INDEX content_node_symbol_fqn IF NOT EXISTS FOR (n:ContentNode) ON (n.symbol_fqn)")
            session.run("CREATE INDEX content_node_artifact IF NOT EXISTS FOR (n:ContentNode) ON (n.artifact_kind)")
            session.run("CREATE INDEX content_node_deprecated IF NOT EXISTS FOR (n:ContentNode) ON (n.deprecated)")
            session.run("CREATE INDEX content_node_path IF NOT EXISTS FOR (n:ContentNode) ON (n.path)")
            session.run(
                "CREATE INDEX content_node_acl IF NOT EXISTS FOR (n:ContentNode) ON (n.visibility_scope, n.org_id, n.tenant_id)"
            )
            session.run(
                "CREATE INDEX content_node_authz_object IF NOT EXISTS FOR (n:ContentNode) ON (n.authz_object_id)"
            )
            session.run(
                "CREATE VECTOR INDEX embeddings IF NOT EXISTS FOR (n:ContentNode) ON (n.embedding) "
                f"OPTIONS {{ indexConfig: {{ `vector.dimensions`: {EMBEDDING_DIM}, "
                "`vector.similarity_function`: 'cosine' }}}}"
            )
            session.run(
                """
                MERGE (s:GraphSchema {name: $name})
                SET s.version = $version, s.updated_at_epoch = timestamp()
                """,
                name=CATALOG_COLLECTION,
                version=schema_version,
            )
        return {
            "ok": True,
            "graph": CATALOG_COLLECTION,
            "schema_version": schema_version,
            "dropped": True,
            "deleted_nodes": deleted,
        }
    except Exception as exc:
        return {"ok": False, "error": f"recreate_failed: {str(exc)[:200]}", "dropped": False}


def _org_scope_clause(
    alias: str = "n",
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> str:
    """Return a Cypher WHERE clause fragment for org-scoped reads."""
    if is_platform_admin or not caller_org_id:
        return ""
    return f"WHERE (coalesce({alias}.visibility_scope, 'global') = 'global' OR {alias}.org_id = $caller_org_id)"


def _org_scope_predicates(
    alias: str = "n",
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> list[str]:
    if is_platform_admin or not caller_org_id:
        return []
    return [f"(coalesce({alias}.visibility_scope, 'global') = 'global' OR {alias}.org_id = $caller_org_id)"]


def _strip_wrapping_parens(clause: str) -> str:
    clause = clause.strip()
    while clause.startswith("(") and clause.endswith(")"):
        clause = clause[1:-1].strip()
    return clause


def _filter_value_expr(alias: str, field: str) -> str:
    default = _FILTER_FIELD_DEFAULTS.get(field, "")
    return f"toString(coalesce({alias}.{field}, '{default}'))"


def _parse_filter_list(raw_values: str) -> list[str]:
    return [v.strip().strip('"').strip("'") for v in raw_values.split(",") if v.strip()]


def _filter_row_value(row: dict[str, Any], field: str) -> str:
    value = row.get(field)
    if value is None or value == "":
        value = _FILTER_FIELD_DEFAULTS.get(field, "")
    return str(value)


def _scan_signal_values(row: dict[str, Any]) -> list[str]:
    value = row.get("scan_signals", "")
    if isinstance(value, list | tuple | set):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def _scan_signal_cypher(alias: str) -> str:
    return f"[signal IN split(toString(coalesce({alias}.scan_signals, '')), ',') | trim(signal)]"


def _filter_expr_to_cypher(
    filter_expr: str,
    *,
    alias: str = "n",
    param_prefix: str = "filter",
) -> tuple[list[str], dict[str, Any]] | None:
    """Translate Admin's supported filter subset into Cypher predicates.

    Unknown syntax returns ``None`` so callers can fail closed instead of
    accidentally widening a scoped query.
    """
    expr = (filter_expr or "").strip()
    if not expr:
        return [], {}
    if len(expr) > 4096:
        logger.warning("nornic_filter_too_long len=%s — returning empty (fail closed)", len(expr))
        return None

    clauses: list[str] = []
    params: dict[str, Any] = {}
    for idx, raw_part in enumerate(_split_filter_clauses(expr)):
        part = _strip_wrapping_parens(raw_part)
        param = f"{param_prefix}_{idx}"

        eq = _FILTER_EQ_RE.match(part)
        if eq:
            field, expected = eq.groups()
            if field == "scan_signal":
                clauses.append(f"${param} IN {_scan_signal_cypher(alias)}")
            else:
                clauses.append(f"{_filter_value_expr(alias, field)} = ${param}")
            params[param] = expected
            continue

        ne = _FILTER_NE_RE.match(part)
        if ne:
            field, expected = ne.groups()
            if field == "scan_signal":
                clauses.append(f"NOT ${param} IN {_scan_signal_cypher(alias)}")
            else:
                clauses.append(f"{_filter_value_expr(alias, field)} <> ${param}")
            params[param] = expected
            continue

        in_match = _FILTER_IN_RE.match(part)
        if in_match:
            field = in_match.group(1)
            allowed = _parse_filter_list(in_match.group(2))
            if field == "scan_signal":
                clauses.append(f"any(signal IN {_scan_signal_cypher(alias)} WHERE signal IN ${param})")
            else:
                clauses.append(f"{_filter_value_expr(alias, field)} IN ${param}")
            params[param] = allowed
            continue

        logger.warning(
            "nornic_filter_unrecognized expr=%s clause=%s — returning empty (fail closed)",
            expr[:120],
            part[:80],
        )
        return None

    return clauses, params


def _where_clause(
    *,
    alias: str,
    filter_expr: str = "",
    caller_org_id: str = "",
    is_platform_admin: bool = False,
    param_prefix: str = "filter",
) -> tuple[str, dict[str, Any]] | None:
    filter_parts = _filter_expr_to_cypher(filter_expr, alias=alias, param_prefix=param_prefix)
    if filter_parts is None:
        return None
    clauses, params = filter_parts
    predicates = [*_org_scope_predicates(alias, caller_org_id, is_platform_admin), *clauses]
    if not predicates:
        return "", params
    return "WHERE " + " AND ".join(predicates), params


def safe_query(
    collection: str,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
    *,
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> list[dict[str, Any]]:
    del collection
    fields = output_fields or []
    projection = "properties(n) AS props" if not fields else "n AS node"
    where_parts = _where_clause(
        alias="n",
        filter_expr=filter_expr,
        caller_org_id=caller_org_id,
        is_platform_admin=is_platform_admin,
    )
    if where_parts is None:
        return []
    where, filter_params = where_parts
    params: dict[str, Any] = {
        "offset": max(0, offset),
        "limit": max(1, min(limit, 5000)),
    }
    params.update(filter_params)
    if caller_org_id and not is_platform_admin:
        params["caller_org_id"] = caller_org_id
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                {where}
                RETURN {projection}
                SKIP $offset
                LIMIT $limit
                """,
                **params,
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                props = dict(row["props"]) if "props" in row else dict(row["node"])
                if fields:
                    props = {field: props.get(field, "") for field in fields}
                out.append(props)
            return out
    except Exception as exc:
        logger.warning("nornic_query_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def safe_count(
    collection: str,
    filter_expr: str = "",
    *,
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> int:
    del collection
    where_parts = _where_clause(
        alias="n",
        filter_expr=filter_expr,
        caller_org_id=caller_org_id,
        is_platform_admin=is_platform_admin,
        param_prefix="count_filter",
    )
    if where_parts is None:
        return 0
    where, filter_params = where_parts
    params: dict[str, Any] = dict(filter_params)
    if caller_org_id and not is_platform_admin:
        params["caller_org_id"] = caller_org_id
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            row = session.run(
                f"""
                MATCH (n:ContentNode)
                {where}
                RETURN count(n) AS count
                """,
                **params,
            ).single()
            return int(row["count"] or 0) if row else 0
    except Exception as exc:
        logger.warning("nornic_count_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return 0


def collection_scan_signal_trends(
    collection: str,
    *,
    since_epoch: int,
    domain: str = "",
    source: str = "",
    signal: str = "",
    limit: int = 50,
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> list[dict[str, Any]]:
    """Aggregate flagged scan signals without returning corpus text."""
    del collection
    observed_at = (
        "CASE WHEN toInteger(coalesce(n.effective_at_epoch, 0)) > 0 "
        "THEN toInteger(n.effective_at_epoch) ELSE toInteger(coalesce(n.crawl_timestamp, 0)) END"
    )
    predicates = [
        *_org_scope_predicates("n", caller_org_id, is_platform_admin),
        "toString(coalesce(n.scan_status, 'unscanned')) = 'flagged'",
        f"{observed_at} >= $since_epoch",
        "toString(coalesce(n.scan_signals, '')) <> ''",
    ]
    params: dict[str, Any] = {
        "since_epoch": max(0, int(since_epoch)),
        "domain": domain,
        "source": source,
        "signal": signal,
        "limit": max(1, min(limit, 200)),
    }
    if caller_org_id and not is_platform_admin:
        params["caller_org_id"] = caller_org_id
    where = " AND ".join(predicates)
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                WHERE {where}
                WITH n,
                     {observed_at} AS observed_at,
                     toString(coalesce(n.domain, '')) AS domain,
                     toString(coalesce(n.source_url, '')) AS source
                UNWIND {_scan_signal_cypher("n")} AS signal
                WITH trim(signal) AS signal, domain, source, observed_at
                WHERE signal <> ''
                  AND ($domain = '' OR domain = $domain)
                  AND ($source = '' OR source = $source)
                  AND ($signal = '' OR signal = $signal)
                RETURN signal, domain, source, count(*) AS count,
                       min(observed_at) AS first_seen_epoch,
                       max(observed_at) AS last_seen_epoch
                ORDER BY count DESC, signal, domain, source
                LIMIT $limit
                """,
                **params,
            )
            return [
                {
                    "signal": str(row.get("signal") or ""),
                    "domain": str(row.get("domain") or ""),
                    "source": str(row.get("source") or ""),
                    "count": int(row.get("count") or 0),
                    "first_seen_epoch": int(row.get("first_seen_epoch") or 0),
                    "last_seen_epoch": int(row.get("last_seen_epoch") or 0),
                }
                for row in rows
            ]
    except Exception as exc:
        logger.warning("nornic_scan_trends_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def _apply_single_clause(rows: list[dict[str, Any]], clause: str) -> list[dict[str, Any]] | None:
    """Apply a single filter clause. Returns None if the clause is unrecognized."""
    clause = clause.strip()
    if not clause:
        return rows

    # Strip wrapping parens: "(scan_status == "x")" -> "scan_status == "x""
    clause = _strip_wrapping_parens(clause)

    eq = _FILTER_EQ_RE.match(clause)
    if eq:
        field, expected = eq.groups()
        if field == "scan_signal":
            return [row for row in rows if expected in _scan_signal_values(row)]
        return [row for row in rows if _filter_row_value(row, field) == expected]

    ne = _FILTER_NE_RE.match(clause)
    if ne:
        field, expected = ne.groups()
        if field == "scan_signal":
            return [row for row in rows if expected not in _scan_signal_values(row)]
        return [row for row in rows if _filter_row_value(row, field) != expected]

    in_match = _FILTER_IN_RE.match(clause)
    if in_match:
        field = in_match.group(1)
        raw_values = in_match.group(2)
        allowed = _parse_filter_list(raw_values)
        if field == "scan_signal":
            return [row for row in rows if any(signal in allowed for signal in _scan_signal_values(row))]
        return [row for row in rows if _filter_row_value(row, field) in allowed]

    return None


def _split_filter_clauses(expr: str) -> list[str]:
    """Split supported filter expressions on top-level ``and`` without regex backtracking."""
    clauses: list[str] = []
    start = 0
    depth = 0
    in_quote = False
    quote_char = ""
    i = 0
    while i < len(expr):
        ch = expr[i]
        if in_quote:
            if ch == quote_char:
                in_quote = False
            i += 1
            continue
        if ch in {'"', "'"}:
            in_quote = True
            quote_char = ch
            i += 1
            continue
        if ch in "([":
            depth += 1
            i += 1
            continue
        if ch in ")]":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0 and expr[i : i + 3] == "and":
            before_ok = i == 0 or expr[i - 1].isspace()
            after_ok = i + 3 >= len(expr) or expr[i + 3].isspace()
            if before_ok and after_ok:
                clauses.append(expr[start:i].strip())
                start = i + 3
                i = start
                continue
        i += 1
    clauses.append(expr[start:].strip())
    return [clause for clause in clauses if clause]


def _apply_filter_expr(rows: list[dict[str, Any]], filter_expr: str) -> list[dict[str, Any]]:
    """Apply the filter subset Admin uses for NornicDB-backed tables.

    Supports: equality (==), inequality (!=), membership (in [...]),
    and compound expressions joined by `` and ``.
    Unrecognized expressions fail closed (return empty) to prevent
    silent filter bypass.
    """
    expr = (filter_expr or "").strip()
    if not expr:
        return rows
    if len(expr) > 4096:
        logger.warning("nornic_filter_too_long len=%s — returning empty (fail closed)", len(expr))
        return []

    parts = _split_filter_clauses(expr)

    result = rows
    for part in parts:
        filtered = _apply_single_clause(result, part)
        if filtered is None:
            logger.warning(
                "nornic_filter_unrecognized expr=%s clause=%s — returning empty (fail closed)", expr[:120], part[:80]
            )
            return []
        result = filtered

    return result


def safe_upsert(collection: str, data: dict[str, Any]) -> bool:
    del collection
    try:
        driver = get_nornic_driver()
        node_id = str(data.get("id") or data.get("chunk_id") or "")
        if not node_id:
            return False
        data = {**data, "id": node_id}
        with driver.session(database=NORNIC_DATABASE) as session:
            session.run(
                "MERGE (n:ContentNode {id: $id}) SET n += $props",
                id=node_id,
                props=data,
            )
        return True
    except Exception as exc:
        logger.warning("nornic_upsert_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return False


def safe_delete(collection: str, chunk_id: str) -> bool:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            session.run("MATCH (n:ContentNode {id: $id}) DETACH DELETE n", id=chunk_id)
        return True
    except Exception as exc:
        logger.warning("nornic_delete_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return False


def safe_vector_search(
    collection: str,
    vector: list[float] | str,
    *,
    top_k: int = 5,
    filter_expr: str = "",
    output_fields: list[str] | None = None,
    caller_org_id: str = "",
    is_platform_admin: bool = False,
) -> list[dict[str, Any]]:
    del collection
    query = vector if isinstance(vector, str) else " ".join(str(x) for x in vector[:16])
    where_parts = _where_clause(
        alias="node",
        filter_expr=filter_expr,
        caller_org_id=caller_org_id,
        is_platform_admin=is_platform_admin,
        param_prefix="vector_filter",
    )
    if where_parts is None:
        return []
    where, filter_params = where_parts
    params: dict[str, Any] = {
        "query": query,
        "limit": max(1, min(top_k, 50)),
    }
    params.update(filter_params)
    if caller_org_id and not is_platform_admin:
        params["caller_org_id"] = caller_org_id
    scope_filter = ""
    if where:
        scope_filter = f"WITH node, score\n                {where}"
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                CALL db.index.vector.queryNodes('embeddings', $limit, $query)
                YIELD node, score
                {scope_filter}
                RETURN node, score
                ORDER BY score DESC
                LIMIT $limit
                """,
                **params,
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                props = dict(row["node"])
                if output_fields:
                    props = {field: props.get(field, "") for field in output_fields}
                props["score"] = row["score"]
                out.append(props)
            return out
    except Exception as exc:
        logger.warning("nornic_vector_search_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def collection_stats(collection: str) -> dict[str, Any]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            kind_rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN coalesce(n.kind, '') AS kind, count(n) AS count
                """
            )
            counts_by_kind: dict[str, int] = {}
            for row in kind_rows:
                kind = str(row.get("kind") or "")
                counts_by_kind[kind] = counts_by_kind.get(kind, 0) + int(row.get("count") or 0)
            edge_count = session.run("MATCH (:ContentNode)-[r]->(:ContentNode) RETURN count(r) AS c").single()["c"]
            embedding_row = session.run("MATCH (n:ContentNode) RETURN count(n.embedding) AS count").single()
            pack_row = session.run(
                "MATCH (n:ContentNode) WHERE n.pack IS NOT NULL RETURN count(DISTINCT n.pack) AS count"
            ).single()
            node_count = sum(counts_by_kind.values())
            content_node_count = sum(counts_by_kind.get(kind, 0) for kind in _CONTENT_NODE_KINDS)
            strict_chunk_count = counts_by_kind.get("Chunk", 0)
            embedding_count = int(embedding_row["count"] or 0) if embedding_row else 0
            pack_count = int(pack_row["count"] or 0) if pack_row else 0
        return {
            "row_count": content_node_count,
            "chunk_count": content_node_count,
            "strict_chunk_count": strict_chunk_count,
            "node_count": node_count,
            "malformed_node_count": max(0, node_count - content_node_count),
            "embedding_count": embedding_count,
            "edge_count": int(edge_count),
            "pack_count": pack_count,
        }
    except Exception as exc:
        logger.warning("nornic_stats_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:80])
        return {"row_count": 0, "node_count": 0, "edge_count": 0, "pack_count": 0}


def collection_corpus_summary(collection: str) -> dict[str, Any]:
    del collection
    stats: dict[str, Any] = {
        "row_count": 0,
        "chunk_count": 0,
        "strict_chunk_count": 0,
        "node_count": 0,
        "malformed_node_count": 0,
        "embedding_count": 0,
        "edge_count": 0,
        "pack_count": 0,
    }
    total_documents = 0
    total_sources = 0
    domains_covered = 0
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            kind_rows = session.run(
                """
                MATCH (n:ContentNode)
                RETURN coalesce(n.kind, '') AS kind, count(n) AS count
                """
            )
            counts_by_kind: dict[str, int] = {}
            for row in kind_rows:
                kind = str(row.get("kind") or "")
                counts_by_kind[kind] = counts_by_kind.get(kind, 0) + int(row.get("count") or 0)
            node_count = sum(counts_by_kind.values())
            content_node_count = sum(counts_by_kind.get(kind, 0) for kind in _CONTENT_NODE_KINDS)
            total_documents = counts_by_kind.get("Document", 0)
            total_sources = total_documents
            domain_row = session.run(
                "MATCH (n:ContentNode) WHERE n.domain IS NOT NULL RETURN count(DISTINCT n.domain) AS count"
            ).single()
            domains_covered = int(domain_row["count"] or 0) if domain_row else 0
            stats.update(
                {
                    "row_count": content_node_count,
                    "chunk_count": content_node_count,
                    "strict_chunk_count": counts_by_kind.get("Chunk", 0),
                    "node_count": node_count,
                    "malformed_node_count": max(0, node_count - content_node_count),
                    "embedding_count": counts_by_kind.get("Chunk", 0),
                    "pack_count": 1 if node_count else 0,
                }
            )
    except Exception as exc:
        logger.warning("nornic_corpus_summary_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
    return {
        **stats,
        "total_chunks": int(stats.get("chunk_count", stats.get("row_count", 0)) or 0),
        "total_documents": total_documents,
        "total_sources": total_sources,
        "domains_covered": domains_covered,
    }


def collection_installed_packs(collection: str) -> list[dict[str, Any]]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                RETURN coalesce(n.pack, n.pack_id, '') AS pack_id,
                       max(n.pack_version) AS pack_version,
                       max(n.pack_source_version) AS pack_source_version,
                       max(n.language) AS language,
                       max(n.domain) AS domain,
                       max(n.pack_artifact_hash) AS pack_artifact_hash,
                       sum({_CONTENT_NODE_CASE_CYPHER}) AS row_count
                ORDER BY pack_id
                """
            )
            packs = []
            for row in rows:
                row_count = int(row["row_count"] or 0)
                pack_id = str(row.get("pack_id") or "").strip()
                if not pack_id or row_count <= 0:
                    continue
                packs.append(
                    {
                        "pack_id": pack_id,
                        "pack_version": row.get("pack_version", ""),
                        "pack_source_version": row.get("pack_source_version", ""),
                        "language": row.get("language", ""),
                        "domain": row.get("domain", ""),
                        "pack_artifact_hash": row.get("pack_artifact_hash", ""),
                        "row_count": row_count,
                    }
                )
            return packs
    except Exception as exc:
        logger.warning("nornic_installed_packs_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def collection_pack_quality_reports(collection: str) -> list[dict[str, Any]]:
    del collection
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                WITH coalesce(n.pack, n.pack_id, '') AS pack_id, n
                WHERE pack_id <> ''
                WITH pack_id,
                     count(n) AS node_count,
                     sum(CASE WHEN {_CONTENT_TEXT_CYPHER} <> '' THEN 1 ELSE 0 END) AS chunk_count,
                     count(n.embedding) AS embedding_count,
                     count(DISTINCT CASE WHEN {_DOCUMENT_KEY_CYPHER} <> '' THEN {_DOCUMENT_KEY_CYPHER} ELSE null END) AS doc_count,
                     count(DISTINCT CASE WHEN {_SOURCE_KEY_CYPHER} <> '' THEN {_SOURCE_KEY_CYPHER} ELSE null END) AS source_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'Example' THEN 1 ELSE 0 END) AS example_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'ContextCard' THEN 1 ELSE 0 END) AS context_card_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'PackCard' THEN 1 ELSE 0 END) AS pack_card_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'Pattern' THEN 1 ELSE 0 END) AS anti_pattern_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'Constraint' THEN 1 ELSE 0 END) AS constraint_count,
                     sum(CASE WHEN coalesce(n.kind, '') = 'ExternalRef' THEN 1 ELSE 0 END) AS external_ref_count,
                     collect(n)[0] AS sample
                OPTIONAL MATCH (a:ContentNode)-[r]-(b:ContentNode)
                WHERE (a.pack = pack_id OR a.pack_id = pack_id)
                  AND (b.pack = pack_id OR b.pack_id = pack_id)
                WITH pack_id, sample, node_count, chunk_count, embedding_count, doc_count, source_count,
                     example_count, context_card_count, pack_card_count, anti_pattern_count, constraint_count,
                     external_ref_count, count(DISTINCT r) AS edge_count
                RETURN pack_id,
                       node_count, chunk_count, embedding_count, doc_count, source_count,
                       example_count, context_card_count, pack_card_count, anti_pattern_count,
                       constraint_count, external_ref_count,
                       edge_count,
                       coalesce(sample.domain, '') AS domain,
                       coalesce(sample.language, sample.code_language, '') AS language,
                       coalesce(sample.document_name, '') AS document_name,
                       coalesce(sample.source_version, '') AS source_version,
                       coalesce(sample.source_release, '') AS source_release,
                       coalesce(sample.quality_score, -1.0) AS quality_score,
                       coalesce(sample.trust_score, -1.0) AS trust_score,
                       coalesce(sample.freshness_score, -1.0) AS freshness_score
                ORDER BY pack_id
                """
            )
            reports = []
            for row in rows:
                reports.append(
                    {
                        "pack_id": str(row.get("pack_id") or ""),
                        "node_count": int(row.get("node_count") or 0),
                        "chunk_count": int(row.get("chunk_count") or 0),
                        "embedding_count": int(row.get("embedding_count") or 0),
                        "doc_count": int(row.get("doc_count") or 0),
                        "source_count": int(row.get("source_count") or 0),
                        "example_count": int(row.get("example_count") or 0),
                        "context_card_count": int(row.get("context_card_count") or 0),
                        "pack_card_count": int(row.get("pack_card_count") or 0),
                        "anti_pattern_count": int(row.get("anti_pattern_count") or 0),
                        "constraint_count": int(row.get("constraint_count") or 0),
                        "external_ref_count": int(row.get("external_ref_count") or 0),
                        "edge_count": int(row.get("edge_count") or 0),
                        "domain": str(row.get("domain") or ""),
                        "language": str(row.get("language") or ""),
                        "document_name": str(row.get("document_name") or ""),
                        "source_version": row.get("source_version", ""),
                        "source_release": row.get("source_release", ""),
                        "quality_score": float(row.get("quality_score") or -1),
                        "trust_score": float(row.get("trust_score") or -1),
                        "freshness_score": float(row.get("freshness_score") or -1),
                        "node_kind_counts": {},
                        "edge_type_counts": {},
                    }
                )
            by_id = {report["pack_id"]: report for report in reports}
            kind_rows = session.run(
                """
                MATCH (n:ContentNode)
                WITH coalesce(n.pack, n.pack_id, '') AS pack_id, n
                WHERE pack_id <> ''
                WITH pack_id, coalesce(n.kind, 'Chunk') AS kind, count(n) AS count
                RETURN pack_id, collect({kind: kind, count: count}) AS counts
                """
            )
            for row in kind_rows:
                report = by_id.get(str(row.get("pack_id") or ""))
                if report is not None:
                    report["node_kind_counts"] = {
                        str(item.get("kind") or "unknown"): int(item.get("count") or 0)
                        for item in (row.get("counts") or [])
                        if isinstance(item, dict)
                    }
            edge_rows = session.run(
                """
                MATCH (a:ContentNode)-[r]-(b:ContentNode)
                WITH coalesce(a.pack, a.pack_id, '') AS pack_id, a, r, b
                WHERE pack_id <> '' AND (b.pack = pack_id OR b.pack_id = pack_id)
                WITH pack_id, type(r) AS edge_type, count(DISTINCT r) AS count
                RETURN pack_id, collect({edge_type: edge_type, count: count}) AS counts
                """
            )
            for row in edge_rows:
                report = by_id.get(str(row.get("pack_id") or ""))
                if report is not None:
                    report["edge_type_counts"] = {
                        str(item.get("edge_type") or "unknown"): int(item.get("count") or 0)
                        for item in (row.get("counts") or [])
                        if isinstance(item, dict)
                    }
            return reports
    except Exception as exc:
        logger.warning("nornic_pack_quality_report_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []


def collection_schema_info(collection: str) -> dict[str, Any]:
    del collection
    return {
        "collection": CATALOG_COLLECTION,
        "graph": CATALOG_COLLECTION,
        "schema_version": expected_graph_schema_version(),
        "exists": True,
        "fields": [
            {"name": "id", "type": "string", "is_primary": True, "max_length": 128},
            {"name": "chunk_id", "type": "string", "is_primary": False, "max_length": 128},
            {"name": "doc_id", "type": "string", "is_primary": False, "max_length": 256},
            {"name": "text", "type": "text", "is_primary": False},
            {"name": "content", "type": "text", "is_primary": False},
            {"name": "embedding", "type": "vector<float>", "is_primary": False, "dim": EMBEDDING_DIM},
            {"name": "context_prefix", "type": "text", "is_primary": False},
            {"name": "chunk_summary", "type": "text", "is_primary": False},
            {"name": "summary", "type": "text", "is_primary": False},
            {"name": "heading_path", "type": "string", "is_primary": False},
            {"name": "section", "type": "string", "is_primary": False},
            {"name": "domain", "type": "string", "is_primary": False, "max_length": 128},
            {"name": "source_url", "type": "string", "is_primary": False},
            {"name": "url", "type": "string", "is_primary": False},
            {"name": "document_name", "type": "string", "is_primary": False},
            {"name": "source_type", "type": "string", "is_primary": False},
            {"name": "handler", "type": "string", "is_primary": False},
            {"name": "authority", "type": "string", "is_primary": False, "max_length": 32},
            {"name": "origin_type", "type": "string", "is_primary": False, "max_length": 32},
            {"name": "visibility_scope", "type": "string", "is_primary": False, "max_length": 16},
            {"name": "org_id", "type": "string", "is_primary": False, "max_length": 64},
            {"name": "tenant_id", "type": "string", "is_primary": False, "max_length": 64},
            {"name": "owner_user_id", "type": "string", "is_primary": False, "max_length": 64},
            {"name": "conversation_id", "type": "string", "is_primary": False, "max_length": 128},
            {"name": "upload_batch_id", "type": "string", "is_primary": False, "max_length": 64},
            {"name": "upload_mode", "type": "string", "is_primary": False, "max_length": 24},
            {"name": "is_ephemeral", "type": "boolean", "is_primary": False},
            {"name": "expires_at_epoch", "type": "integer", "is_primary": False},
            {"name": "acl_mode", "type": "string", "is_primary": False, "max_length": 16},
            {"name": "acl_groups", "type": "text", "is_primary": False},
            {"name": "acl_group_ids", "type": "list<string>", "is_primary": False},
            {"name": "authz_object_id", "type": "string", "is_primary": False, "max_length": 192},
            {"name": "pack", "type": "string", "is_primary": False},
            {"name": "pack_id", "type": "string", "is_primary": False},
            {"name": "pack_version", "type": "string", "is_primary": False},
            {"name": "source_version", "type": "string", "is_primary": False},
            {"name": "pack_source_version", "type": "string", "is_primary": False},
            {"name": "source_release", "type": "string", "is_primary": False},
            {"name": "upstream_commit", "type": "string", "is_primary": False},
            {"name": "upstream_tag", "type": "string", "is_primary": False},
            {"name": "symbol_fqn", "type": "string", "is_primary": False},
            {"name": "symbol_kind", "type": "string", "is_primary": False},
            {"name": "symbol_type", "type": "string", "is_primary": False},
            {"name": "symbol_name", "type": "string", "is_primary": False},
            {"name": "kind", "type": "string", "is_primary": False},
            {"name": "content_type", "type": "string", "is_primary": False},
            {"name": "content_format", "type": "string", "is_primary": False},
            {"name": "package_name", "type": "string", "is_primary": False},
            {"name": "language", "type": "string", "is_primary": False},
            {"name": "repo_path", "type": "string", "is_primary": False},
            {"name": "module_path", "type": "string", "is_primary": False},
            {"name": "path", "type": "string", "is_primary": False},
            {"name": "retrieval_terms", "type": "text", "is_primary": False},
            {"name": "query_aliases", "type": "text", "is_primary": False},
            {"name": "task_intents", "type": "text", "is_primary": False},
            {"name": "scan_status", "type": "string", "is_primary": False},
            {"name": "approval_status", "type": "string", "is_primary": False},
            {"name": "scan_signals", "type": "text", "is_primary": False},
            {"name": "review_trace_id", "type": "string", "is_primary": False},
            {"name": "effective_at_epoch", "type": "integer", "is_primary": False},
            {"name": "crawl_timestamp", "type": "integer", "is_primary": False},
            {"name": "quality_score", "type": "float", "is_primary": False},
            {"name": "trust_score", "type": "float", "is_primary": False},
            {"name": "freshness_score", "type": "float", "is_primary": False},
            {"name": "content_profile", "type": "string", "is_primary": False},
            {"name": "corpus_class", "type": "string", "is_primary": False},
            {"name": "artifact_kind", "type": "string", "is_primary": False},
            {"name": "deprecated", "type": "boolean", "is_primary": False},
            {"name": "deprecation_status", "type": "string", "is_primary": False},
            {"name": "replacement_api", "type": "string", "is_primary": False},
            {"name": "graph_schema_version", "type": "integer", "is_primary": False},
            {"name": "corpus_version", "type": "string", "is_primary": False},
        ],
        "indexes": [
            {"name": "content_node_id", "field": "id", "type": "unique_constraint", "metric": "exact"},
            {"name": "content_node_pack", "field": "pack", "type": "range", "metric": "exact"},
            {"name": "content_node_source_version", "field": "source_version", "type": "range", "metric": "exact"},
            {"name": "content_node_kind", "field": "kind", "type": "range", "metric": "exact"},
            {"name": "content_node_domain", "field": "domain", "type": "range", "metric": "exact"},
            {"name": "content_node_content_type", "field": "content_type", "type": "range", "metric": "exact"},
            {"name": "content_node_language", "field": "language", "type": "range", "metric": "exact"},
            {"name": "content_node_package", "field": "package_name", "type": "range", "metric": "exact"},
            {"name": "content_node_symbol_fqn", "field": "symbol_fqn", "type": "range", "metric": "exact"},
            {"name": "content_node_artifact", "field": "artifact_kind", "type": "range", "metric": "exact"},
            {"name": "content_node_deprecated", "field": "deprecated", "type": "range", "metric": "exact"},
            {"name": "content_node_path", "field": "path", "type": "range", "metric": "exact"},
            {
                "name": "content_node_acl",
                "field": "visibility_scope, org_id, tenant_id",
                "type": "range",
                "metric": "exact",
            },
            {"name": "content_node_authz_object", "field": "authz_object_id", "type": "range", "metric": "exact"},
            {"name": "embeddings", "field": "embedding", "type": "vector", "metric": "cosine"},
        ],
        "node_labels": [
            "ContentNode",
            "Pack",
            "Source",
            "Document",
            "File",
            "Package",
            "Module",
            "Chunk",
            "Symbol",
            "Function",
            "Class",
            "Method",
            "Resource",
            "Concept",
            "Pattern",
            "Constraint",
            "Example",
            "ContextCard",
            "ExternalRef",
            "EvalCase",
            "Version",
        ],
        "edge_types": [
            "CONTAINS",
            "DEFINES",
            "CALLS",
            "IMPORTS",
            "REFERENCES",
            "OVERRIDES",
            "IMPLEMENTS",
            "DOCUMENTS",
            "HAS_CONSTRAINT",
            "HAS_EXAMPLE",
            "HAS_PATTERN",
            "HAS_CONTEXT_CARD",
            "APPLIES_TO",
            "DEPRECATED_BY",
            "REPLACED_BY",
            "WARNS_ABOUT",
            "RELATED_TO",
            "VALID_IN",
            "DERIVED_FROM",
        ],
        "vector_indexes": ["embeddings"],
    }


def collection_domain_hierarchy(collection: str) -> list[dict[str, Any]]:
    del collection
    hierarchy: dict[str, Any] = {}
    try:
        driver = get_nornic_driver()
        with driver.session(database=NORNIC_DATABASE) as session:
            rows = session.run(
                f"""
                MATCH (n:ContentNode)
                WHERE n.kind IN {_CONTENT_NODE_KIND_LIST_CYPHER}
                RETURN coalesce(n.domain, 'generalist') AS domain,
                       coalesce(n.pack, n.pack_id, n.document_name, n.source_url, n.id, 'unknown') AS source,
                       count(n) AS chunks
                """
            )
            for row in rows:
                chunks = int(row["chunks"] or 0)
                if chunks <= 0:
                    continue
                domain = str(row.get("domain") or "generalist")
                source = str(row.get("source") or "unknown")
                entry = hierarchy.setdefault(domain, {"domain": domain, "total_chunks": 0, "sources": {}})
                entry["total_chunks"] += chunks
                sources = entry["sources"]
                sources[source] = int(sources.get(source, 0)) + chunks
    except Exception as exc:
        logger.warning("nornic_hierarchy_error graph=%s error=%s", CATALOG_COLLECTION, str(exc)[:120])
        return []

    shaped = []
    for entry in hierarchy.values():
        sources = [
            {"source": source, "chunks": chunks}
            for source, chunks in sorted(entry["sources"].items(), key=lambda item: (-item[1], item[0]))
        ]
        shaped.append({"domain": entry["domain"], "total_chunks": entry["total_chunks"], "sources": sources})
    return sorted(shaped, key=lambda item: item["domain"])
