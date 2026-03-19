"""LangGraph reducer functions for anti-oscillation state fields.

These pure functions enforce immutability and monotonicity contracts
on state fields that must not be silently overwritten by downstream nodes.

Usage: ``Annotated[T, reducer_fn]`` in GraphState (state.py).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("synesis.reducers")

_STATUS_ORDER = {"open": 0, "resolved": 1, "settled": 2}


def _merge_evidence_packets(existing: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reducer for evidence_packets: append new packets, deduplicate by (query, section_id).

    Later packets for the same (query, section_id) replace earlier ones so that
    Router refinement loops update rather than accumulate stale evidence.
    """
    if not new:
        return existing
    if not existing:
        return list(new)

    def _key(p: dict[str, Any]) -> tuple[str, int | None]:
        return (p.get("query", ""), p.get("section_id"))

    merged: dict[tuple[str, int | None], dict[str, Any]] = {}
    for p in existing:
        merged[_key(p)] = p
    for p in new:
        merged[_key(p)] = p
    return list(merged.values())


def _set_once_dict(existing: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """First non-empty dict wins; subsequent writes are ignored.

    Used for ``task_frame`` and ``style_contract_locked`` — once set by
    frame_extractor / planner, no downstream node can overwrite them.
    """
    if existing:
        if new and new != existing:
            logger.debug("set_once_dict: ignoring overwrite attempt (existing keys: %s)", list(existing.keys())[:5])
        return existing
    return new


def _append_only_ledger(existing: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Append new entries; existing entries with the same id key are preserved.

    Works for ``decision_ledger`` (keyed by ``decision_id``), ``override_log``
    (no dedup — always append), and ``draft_fingerprints`` (plain strings
    wrapped in dicts are handled by ``_append_only_strings``).

    Entries without a ``decision_id`` are always appended (override_log pattern).
    """
    if not new:
        return existing
    if not existing:
        return list(new)

    seen_ids: set[str] = set()
    for entry in existing:
        did = entry.get("decision_id", "")
        if did:
            seen_ids.add(did)

    merged = list(existing)
    for entry in new:
        did = entry.get("decision_id", "")
        if did and did in seen_ids:
            continue
        merged.append(entry)
        if did:
            seen_ids.add(did)
    return merged


def _append_only_strings(existing: list[str], new: list[str]) -> list[str]:
    """Append-only for string lists (draft_fingerprints)."""
    if not new:
        return existing
    if not existing:
        return list(new)
    return list(existing) + list(new)


def _merge_critique_register(
    existing: dict[str, Any],
    new: dict[str, Any],
) -> dict[str, Any]:
    """Merge critique items by ``item_id`` with forward-only status transitions.

    Status order: open (0) -> resolved (1) -> settled (2).
    A new entry can only advance status forward. Reopening (backward move)
    is allowed only when the new entry provides a non-empty ``evidence_ref``
    that differs from the existing one, and increments ``reopen_count``.
    """
    if not new:
        return existing
    if not existing:
        return dict(new)

    merged = dict(existing)

    for item_id, new_item in new.items():
        if not isinstance(new_item, dict):
            merged[item_id] = new_item
            continue

        if item_id not in merged:
            merged[item_id] = new_item
            continue

        old_item = merged[item_id]
        if not isinstance(old_item, dict):
            merged[item_id] = new_item
            continue

        old_status = old_item.get("status", "open")
        new_status = new_item.get("status", "open")
        old_rank = _STATUS_ORDER.get(old_status, 0)
        new_rank = _STATUS_ORDER.get(new_status, 0)

        if new_rank >= old_rank:
            merged[item_id] = new_item
        else:
            new_evidence = (new_item.get("evidence_ref") or "").strip()
            old_evidence = (old_item.get("evidence_ref") or "").strip()
            if new_evidence and new_evidence != old_evidence:
                reopen_count = old_item.get("reopen_count", 0) + 1
                reopened = {**new_item, "reopen_count": reopen_count}
                merged[item_id] = reopened
                logger.info(
                    "critique_register: reopened %s (%s->%s) with new evidence, reopen_count=%d",
                    item_id,
                    old_status,
                    new_status,
                    reopen_count,
                )
            else:
                logger.debug(
                    "critique_register: blocking status regression %s (%s->%s) without new evidence",
                    item_id,
                    old_status,
                    new_status,
                )

    return merged
