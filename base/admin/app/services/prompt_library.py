from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from sqlalchemy import select

from ..db.engine import async_session
from ..db.models import PromptAssignment, PromptProfile

ALLOWED_SERVICES = ("yarn", "planner")
ALLOWED_TARGET_TYPES = ("default", "tier", "role", "model_family", "node")

YARN_BASE_PROFILE_NAME = "yarn-default-base"
YARN_QWEN_PROFILE_NAME = "yarn-qwen3-coder-ops"
PLANNER_BASE_PROFILE_NAME = "planner-default-base"

YARN_BASE_PROMPT = """You are Synesis, an engineering assistant operating in an interactive development environment.
Prioritize correctness over speed, inspect before changing code, and ground every decision in observed repository/tool evidence.
Complete requested work end-to-end when feasible, validate meaningful outcomes, and report what is verified vs still uncertain.

Token Efficiency & Style:
- Be direct and concise. Avoid conversational filler, emojis, or repeating unchanged code.
- Only output what is necessary to explain your changes or findings.

Tool Usage Guidelines:
- Use parallel tool calls for independent tasks.
- Prioritize search tools (e.g., grep/glob) over reading full files during exploration."""

YARN_QWEN_PROMPT = """You are Synesis, a software engineering agent in an interactive development environment.
Focus on real engineering outcomes, not placeholders.

Operating rules:
- Inspect relevant files, configuration, and logs before proposing edits.
- Prefer minimal, coherent changes with low blast radius.
- Never claim success without evidence from a relevant validation step.
- If a command or approach fails, update assumptions and try a corrected approach.
- Avoid fake completions, mock outputs, or "done" states when critical work is incomplete.
- Distinguish facts from assumptions, and clearly mark uncertainty.
- Keep responses concise and operational: what changed, what was verified, and what remains.
- Use repository and runtime context (platform, shell, working directory, git state) to choose correct tooling/paths.

Token Efficiency & Style:
- Be direct and concise. Avoid conversational filler, emojis, or repeating unchanged code.
- Only output what is necessary to explain your changes or findings.

Tool Usage Guidelines:
- Use parallel tool calls for independent tasks.
- Prioritize search tools (e.g., grep/glob) over reading full files during exploration."""

PLANNER_BASE_PROMPT = """You are Synesis Planner.
Produce structured, practical plans that preserve user intent, explicitly surface uncertainty, and avoid unstated assumptions.
When context is ambiguous, ask targeted clarification questions; when sufficient context exists, proceed with concrete, validated guidance.

Plan Mode Guardrail:
- Only edit markdown files (e.g., documentation or plans).
- Ask clarifying questions before executing any system-modifying tools.
- Do not execute code changes, terminal commands, or other system modifications during the planning phase."""


def _hash_prompt(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _validate_service(service: str) -> str:
    s = (service or "").strip().lower()
    if s not in ALLOWED_SERVICES:
        raise ValueError(f"invalid service: {service}")
    return s


def _validate_target_type(target_type: str) -> str:
    t = (target_type or "").strip().lower()
    if t not in ALLOWED_TARGET_TYPES:
        raise ValueError(f"invalid target_type: {target_type}")
    return t


def _profile_to_dict(row: PromptProfile) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "service": row.service,
        "description": row.description,
        "content": row.content,
        "content_hash": row.content_hash,
        "enabled": row.enabled,
        "created_by": row.created_by,
        "updated_by": row.updated_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _assignment_to_dict(row: PromptAssignment) -> dict:
    return {
        "id": row.id,
        "service": row.service,
        "target_type": row.target_type,
        "target_value": row.target_value,
        "profile_id": row.profile_id,
        "enabled": row.enabled,
        "updated_by": row.updated_by,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def list_prompt_profiles(*, service: str | None = None) -> list[dict]:
    async with async_session() as session:
        stmt = select(PromptProfile).order_by(PromptProfile.service, PromptProfile.name)
        if service:
            stmt = stmt.where(PromptProfile.service == _validate_service(service))
        rows = (await session.execute(stmt)).scalars().all()
        return [_profile_to_dict(r) for r in rows]


async def create_prompt_profile(data: dict, *, actor: str = "") -> dict:
    service = _validate_service(str(data.get("service", "yarn")))
    name = str(data.get("name", "")).strip()
    content = str(data.get("content", "")).strip()
    if not name:
        raise ValueError("name is required")
    if not content:
        raise ValueError("content is required")
    row = PromptProfile(
        name=name,
        service=service,
        description=str(data.get("description", "")).strip(),
        content=content,
        content_hash=_hash_prompt(content),
        enabled=bool(data.get("enabled", True)),
        created_by=actor,
        updated_by=actor,
    )
    async with async_session() as session:
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _profile_to_dict(row)


async def update_prompt_profile(profile_id: int, data: dict, *, actor: str = "") -> dict | None:
    async with async_session() as session:
        row = await session.get(PromptProfile, profile_id)
        if row is None:
            return None
        if "name" in data:
            name = str(data.get("name", "")).strip()
            if not name:
                raise ValueError("name cannot be empty")
            row.name = name
        if "service" in data:
            row.service = _validate_service(str(data.get("service", "")))
        if "description" in data:
            row.description = str(data.get("description", "")).strip()
        if "content" in data:
            content = str(data.get("content", "")).strip()
            if not content:
                raise ValueError("content cannot be empty")
            row.content = content
            row.content_hash = _hash_prompt(content)
        if "enabled" in data:
            row.enabled = bool(data.get("enabled"))
        row.updated_by = actor
        row.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(row)
        return _profile_to_dict(row)


async def delete_prompt_profile(profile_id: int) -> bool:
    async with async_session() as session:
        row = await session.get(PromptProfile, profile_id)
        if row is None:
            return False
        await session.delete(row)
        await session.commit()
        return True


async def list_prompt_assignments(*, service: str | None = None) -> list[dict]:
    async with async_session() as session:
        stmt = select(PromptAssignment).order_by(
            PromptAssignment.service,
            PromptAssignment.target_type,
            PromptAssignment.target_value,
        )
        if service:
            stmt = stmt.where(PromptAssignment.service == _validate_service(service))
        rows = (await session.execute(stmt)).scalars().all()
        return [_assignment_to_dict(r) for r in rows]


async def upsert_prompt_assignment(data: dict, *, actor: str = "") -> dict:
    service = _validate_service(str(data.get("service", "yarn")))
    target_type = _validate_target_type(str(data.get("target_type", "default")))
    target_value = str(data.get("target_value", "*")).strip() or "*"
    profile_id = int(data.get("profile_id", 0))
    if profile_id <= 0:
        raise ValueError("profile_id is required")
    enabled = bool(data.get("enabled", True))
    async with async_session() as session:
        profile = await session.get(PromptProfile, profile_id)
        if profile is None:
            raise ValueError("profile_id does not exist")
        row = (
            (
                await session.execute(
                    select(PromptAssignment).where(
                        PromptAssignment.service == service,
                        PromptAssignment.target_type == target_type,
                        PromptAssignment.target_value == target_value,
                    )
                )
            )
            .scalars()
            .one_or_none()
        )
        if row is None:
            row = PromptAssignment(
                service=service,
                target_type=target_type,
                target_value=target_value,
                profile_id=profile_id,
                enabled=enabled,
                updated_by=actor,
            )
            session.add(row)
        else:
            row.profile_id = profile_id
            row.enabled = enabled
            row.updated_by = actor
            row.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(row)
        return _assignment_to_dict(row)


async def delete_prompt_assignment(assignment_id: int) -> bool:
    async with async_session() as session:
        row = await session.get(PromptAssignment, assignment_id)
        if row is None:
            return False
        await session.delete(row)
        await session.commit()
        return True


async def get_prompt_snapshot(service: str) -> dict:
    svc = _validate_service(service)
    async with async_session() as session:
        profile_rows = (
            (
                await session.execute(
                    select(PromptProfile).where(
                        PromptProfile.service == svc,
                        PromptProfile.enabled == True,
                    )
                )
            )
            .scalars()
            .all()
        )
        assignment_rows = (
            (
                await session.execute(
                    select(PromptAssignment).where(
                        PromptAssignment.service == svc,
                        PromptAssignment.enabled == True,
                    )
                )
            )
            .scalars()
            .all()
        )
    profiles = [
        {
            "id": p.id,
            "name": p.name,
            "service": p.service,
            "content": p.content,
            "content_hash": p.content_hash,
        }
        for p in profile_rows
    ]
    assignments = [
        {
            "id": a.id,
            "service": a.service,
            "target_type": a.target_type,
            "target_value": a.target_value,
            "profile_id": a.profile_id,
        }
        for a in assignment_rows
    ]
    updated_at = max(
        [p.updated_at for p in profile_rows if p.updated_at] + [a.updated_at for a in assignment_rows if a.updated_at],
        default=None,
    )
    return {
        "service": svc,
        "profiles": profiles,
        "assignments": assignments,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


async def seed_default_prompt_profiles() -> int:
    inserted = 0
    async with async_session() as session:
        seeds = [
            (
                "yarn",
                YARN_BASE_PROFILE_NAME,
                "Yarn: default catch-all system prompt (IDE agent baseline for this service).",
                YARN_BASE_PROMPT,
            ),
            (
                "yarn",
                YARN_QWEN_PROFILE_NAME,
                "Yarn: overlay for model_family qwen3-coder (stricter operational / anti-lazy contract).",
                YARN_QWEN_PROMPT,
            ),
            (
                "planner",
                PLANNER_BASE_PROFILE_NAME,
                "Planner (planner-ts): default catch-all system prompt (Synesis Planner planning persona).",
                PLANNER_BASE_PROMPT,
            ),
        ]
        by_name: dict[str, PromptProfile] = {}
        for service, name, description, content in seeds:
            existing = (
                (await session.execute(select(PromptProfile).where(PromptProfile.name == name))).scalars().one_or_none()
            )
            if existing is None:
                row = PromptProfile(
                    name=name,
                    service=service,
                    description=description,
                    content=content,
                    content_hash=_hash_prompt(content),
                    enabled=True,
                    created_by="system",
                    updated_by="system",
                )
                session.add(row)
                await session.flush()
                by_name[name] = row
                inserted += 1
            else:
                by_name[name] = existing

        desired_assignments = [
            ("yarn", "default", "*", YARN_BASE_PROFILE_NAME),
            ("yarn", "model_family", "qwen3-coder", YARN_QWEN_PROFILE_NAME),
            ("planner", "default", "*", PLANNER_BASE_PROFILE_NAME),
        ]
        for service, target_type, target_value, profile_name in desired_assignments:
            profile = by_name.get(profile_name)
            if profile is None:
                continue
            existing = (
                (
                    await session.execute(
                        select(PromptAssignment).where(
                            PromptAssignment.service == service,
                            PromptAssignment.target_type == target_type,
                            PromptAssignment.target_value == target_value,
                        )
                    )
                )
                .scalars()
                .one_or_none()
            )
            if existing is None:
                session.add(
                    PromptAssignment(
                        service=service,
                        target_type=target_type,
                        target_value=target_value,
                        profile_id=profile.id,
                        enabled=True,
                        updated_by="system",
                    )
                )
                inserted += 1
        await session.commit()
    return inserted
