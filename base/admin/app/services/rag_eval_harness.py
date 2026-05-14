"""SynPack retrieval eval harness.

Runs YAML-defined pack eval cases against planner's graph-native knowledge
bundle endpoint and stores the result as a benchmark run. These evals measure
whether the pack can produce answer-ready evidence, not whether a writer model
can compose a final answer.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import yaml

from ..db.engine import async_session
from ..db.models import BenchmarkResult
from ..deps import INTERNAL_SERVICE_TOKEN, PLANNER_TS_URL

_DEFAULT_EVAL_DIR = Path(__file__).resolve().parents[4] / "base" / "rag" / "pack-evals"
_EVAL_DIR = Path(os.getenv("SYNESIS_RAG_EVAL_DIR", str(_DEFAULT_EVAL_DIR))).resolve()


@dataclass(frozen=True)
class RagEvalCase:
    id: str
    query: str
    language: str = ""
    package_name: str = ""
    symbol: str = ""
    topic: str = ""
    task: str = ""
    pack_id: str = ""
    version: str = ""
    expect: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RagEvalSuite:
    name: str
    description: str
    path: str
    cases: list[RagEvalCase]


def _str(value: Any) -> str:
    return str(value or "").strip()


def _str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_str(item) for item in value if _str(item)]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _repo_eval_dir() -> Path:
    if _EVAL_DIR.exists():
        return _EVAL_DIR
    fallback = Path("base/rag/pack-evals").resolve()
    return fallback


def _load_suite(path: Path) -> RagEvalSuite:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"{path.name} must contain a YAML object")
    cases = []
    for index, item in enumerate(raw.get("cases") or []):
        if not isinstance(item, dict):
            continue
        case_id = _str(item.get("id")) or f"case-{index + 1}"
        query = _str(item.get("query"))
        if not query:
            continue
        expect = item.get("expect") if isinstance(item.get("expect"), dict) else {}
        cases.append(
            RagEvalCase(
                id=case_id,
                query=query,
                language=_str(item.get("language")),
                package_name=_str(item.get("package_name")),
                symbol=_str(item.get("symbol")),
                topic=_str(item.get("topic")),
                task=_str(item.get("task")),
                pack_id=_str(item.get("pack_id")),
                version=_str(item.get("version")),
                expect=expect,
            )
        )
    return RagEvalSuite(
        name=_str(raw.get("name")) or path.stem,
        description=_str(raw.get("description")),
        path=str(path),
        cases=cases,
    )


def list_rag_eval_suites() -> list[dict[str, Any]]:
    suites = []
    for path in sorted(_repo_eval_dir().glob("*.yaml")):
        try:
            suite = _load_suite(path)
        except Exception as exc:
            suites.append({"name": path.stem, "path": str(path), "case_count": 0, "error": str(exc)[:200]})
            continue
        suites.append(
            {
                "name": suite.name,
                "description": suite.description,
                "path": suite.path,
                "case_count": len(suite.cases),
                "languages": sorted({case.language for case in suite.cases if case.language}),
                "topics": sorted({case.topic for case in suite.cases if case.topic})[:20],
            }
        )
    return suites


def load_rag_eval_suite(name: str) -> RagEvalSuite:
    wanted = name.strip()
    for path in sorted(_repo_eval_dir().glob("*.yaml")):
        suite = _load_suite(path)
        if suite.name == wanted or path.stem == wanted:
            return suite
    raise KeyError(wanted)


def _textify(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(_textify(v) for v in value.values())
    if isinstance(value, list):
        return " ".join(_textify(v) for v in value)
    return str(value or "")


def _items(bundle: dict[str, Any], key: str) -> list[dict[str, Any]]:
    raw = bundle.get(key)
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _contains_any(haystack: str, needles: list[str]) -> bool:
    folded = haystack.lower()
    return any(needle.lower() in folded for needle in needles if needle)


def _quality_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out >= 0 else None


def _pack_quality(bundle: dict[str, Any]) -> dict[str, Any]:
    quality = bundle.get("quality") if isinstance(bundle.get("quality"), dict) else {}
    resolved = bundle.get("resolved_pack") if isinstance(bundle.get("resolved_pack"), dict) else {}
    return {
        "quality_score": _quality_float(quality.get("quality_score") or resolved.get("quality_score")),
        "trust_score": _quality_float(quality.get("trust_score") or resolved.get("trust_score")),
        "freshness_score": _quality_float(quality.get("freshness_score") or resolved.get("freshness_score")),
    }


def _score_case(case: RagEvalCase, bundle: dict[str, Any], latency_ms: float) -> dict[str, Any]:
    chunks = _items(bundle, "source_chunks") or _items(bundle, "results")
    cards = _items(bundle, "context_cards")
    examples = _items(bundle, "examples")
    anti_patterns = _items(bundle, "anti_patterns")
    related = _items(bundle, "related_symbols")
    warnings = _str_list(bundle.get("freshness_warnings"))
    resolved = bundle.get("resolved_pack") if isinstance(bundle.get("resolved_pack"), dict) else {}
    expect = case.expect

    corpus_text = _textify([chunks, cards, examples, anti_patterns, related, warnings, resolved])
    failures: list[str] = []
    warnings_out: list[str] = []
    checks: dict[str, bool] = {}

    expected_symbols = _str_list(expect.get("symbols"))
    if expected_symbols:
        checks["symbol_hit"] = _contains_any(corpus_text, expected_symbols)
        if not checks["symbol_hit"]:
            failures.append(f"missing expected symbol: {', '.join(expected_symbols)}")

    expected_language = _str(expect.get("pack_language") or case.language)
    if expected_language:
        lang_text = _textify([resolved, chunks[:3], cards[:3]]).lower()
        checks["language_match"] = expected_language.lower() in lang_text
        if not checks["language_match"]:
            warnings_out.append(f"language mismatch or absent: expected={expected_language}")

    examples_required = bool(expect.get("examples_required"))
    checks["examples_present"] = len(examples) > 0
    if examples_required and not checks["examples_present"]:
        failures.append("expected at least one first-class example")

    expected_anti = _str_list(expect.get("anti_patterns"))
    if expected_anti:
        checks["anti_pattern_hit"] = _contains_any(_textify([anti_patterns, cards, chunks]), expected_anti)
        if not checks["anti_pattern_hit"]:
            failures.append(f"missing anti-pattern evidence: {', '.join(expected_anti)}")

    expected_warnings = _str_list(expect.get("warnings"))
    if expected_warnings:
        checks["warning_hit"] = _contains_any(_textify([warnings, anti_patterns, cards, chunks]), expected_warnings)
        if not checks["warning_hit"]:
            failures.append(f"missing warning evidence: {', '.join(expected_warnings)}")

    if bool(expect.get("source_evidence_required")):
        checks["source_evidence_present"] = len(chunks) > 0
        if not checks["source_evidence_present"]:
            failures.append("expected source chunks")

    checks["context_cards_present"] = len(cards) > 0
    if len(cards) == 0:
        warnings_out.append("no answer-ready context cards returned")

    quality = _pack_quality(bundle)
    scored_checks = [
        checks.get("symbol_hit", True),
        checks.get("language_match", True),
        checks.get("examples_present", True) if examples_required else True,
        checks.get("anti_pattern_hit", True),
        checks.get("warning_hit", True),
        checks.get("source_evidence_present", True),
        checks.get("context_cards_present", False),
    ]
    base_score = sum(1 for item in scored_checks if item) / max(len(scored_checks), 1)
    quality_bonus = 0.0
    for value in quality.values():
        if isinstance(value, float):
            quality_bonus += min(value, 1.0) * 0.02
    score = round(min(1.0, base_score + quality_bonus), 4)
    passed = not failures and score >= 0.8

    return {
        "case_id": case.id,
        "query": case.query,
        "passed": passed,
        "score": score,
        "latency_ms": round(latency_ms, 1),
        "checks": checks,
        "failures": failures,
        "warnings": warnings_out,
        "counts": {
            "source_chunks": len(chunks),
            "context_cards": len(cards),
            "examples": len(examples),
            "anti_patterns": len(anti_patterns),
            "related_symbols": len(related),
            "freshness_warnings": len(warnings),
        },
        "resolved_pack": resolved,
        "quality": quality,
        "top_evidence": [
            {
                "id": _str(item.get("id") or item.get("chunk_id")),
                "kind": _str(item.get("kind") or "Chunk"),
                "name": _str(item.get("name") or item.get("document_name")),
                "symbol": _str(item.get("symbol_fqn") or item.get("symbol")),
                "source_url": _str(item.get("source_url")),
                "score": _quality_float(item.get("score")),
            }
            for item in (cards + examples + anti_patterns + chunks)[:8]
        ],
        "training_row": {
            "messages": [{"role": "user", "content": case.query}],
            "retrieval_context": {
                "context_cards": cards[:3],
                "examples": examples[:3],
                "anti_patterns": anti_patterns[:3],
                "source_chunks": chunks[:5],
            },
            "expected": expect,
            "quality_label": "positive" if passed else "negative",
            "reward": score if passed else round(score - 1.0, 4),
            "source": "synpack_retrieval_eval",
            "case_id": case.id,
        },
    }


async def _run_bundle_case(
    client: httpx.AsyncClient,
    case: RagEvalCase,
    *,
    top_k: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "query": case.query,
        "top_k": top_k,
        "mode": "bundle",
        "include_examples": True,
        "include_antipatterns": True,
        "include_context_cards": True,
    }
    for key, value in {
        "language": case.language,
        "package_name": case.package_name,
        "symbol": case.symbol,
        "topic": case.topic,
        "task": case.task,
        "pack_id": case.pack_id,
        "version": case.version,
    }.items():
        if value:
            payload[key] = value
    started = time.perf_counter()
    resp = await client.post("/v1/knowledge/bundle", json=payload)
    latency_ms = (time.perf_counter() - started) * 1000
    if resp.status_code >= 400:
        return {
            "case_id": case.id,
            "query": case.query,
            "passed": False,
            "score": 0.0,
            "latency_ms": round(latency_ms, 1),
            "checks": {},
            "failures": [f"planner returned HTTP {resp.status_code}"],
            "warnings": [],
            "counts": {},
            "resolved_pack": {},
            "quality": {},
            "top_evidence": [],
            "training_row": {
                "messages": [{"role": "user", "content": case.query}],
                "quality_label": "negative",
                "reward": -1.0,
                "source": "synpack_retrieval_eval",
                "case_id": case.id,
            },
        }
    return _score_case(case, resp.json(), latency_ms)


def _aggregate(suite: RagEvalSuite, cases: list[dict[str, Any]], elapsed_ms: float) -> dict[str, Any]:
    total = len(cases)
    passed = sum(1 for case in cases if case.get("passed"))
    errored = sum(1 for case in cases if case.get("failures") and not case.get("counts"))
    avg_score = sum(float(case.get("score") or 0) for case in cases) / max(total, 1)

    def rate(name: str) -> float:
        relevant = [case for case in cases if name in (case.get("checks") or {})]
        if not relevant:
            return 1.0
        return sum(1 for case in relevant if (case.get("checks") or {}).get(name)) / len(relevant)

    return {
        "suite_name": suite.name,
        "case_count": total,
        "passed": passed,
        "failed": total - passed,
        "errored": errored,
        "pass_rate": round(passed / max(total, 1), 4),
        "avg_score": round(avg_score, 4),
        "symbol_hit_rate": round(rate("symbol_hit"), 4),
        "example_hit_rate": round(rate("examples_present"), 4),
        "anti_pattern_hit_rate": round(rate("anti_pattern_hit"), 4),
        "warning_hit_rate": round(rate("warning_hit"), 4),
        "context_card_rate": round(rate("context_cards_present"), 4),
        "source_evidence_rate": round(rate("source_evidence_present"), 4),
        "avg_latency_ms": round(sum(float(case.get("latency_ms") or 0) for case in cases) / max(total, 1), 1),
        "elapsed_ms": round(elapsed_ms, 1),
    }


async def run_rag_eval_suite(
    suite: RagEvalSuite,
    *,
    planner_url: str = PLANNER_TS_URL,
    top_k: int = 8,
    triggered_by: str = "",
) -> dict[str, Any]:
    started = datetime.now(UTC)
    t0 = time.perf_counter()
    headers = {"Content-Type": "application/json", "x-synesis-service-name": "admin-rag-eval"}
    if INTERNAL_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"
    async with httpx.AsyncClient(base_url=planner_url.rstrip("/"), headers=headers, timeout=45.0) as client:
        cases = [await _run_bundle_case(client, case, top_k=max(1, min(top_k, 30))) for case in suite.cases]
    elapsed_ms = (time.perf_counter() - t0) * 1000
    aggregate = _aggregate(suite, cases, elapsed_ms)
    run_id = hashlib.sha256(f"{suite.name}:{started.isoformat()}:{triggered_by}".encode()).hexdigest()[:16]
    result = {
        "run_id": run_id,
        "benchmark_type": "synpack_retrieval_eval",
        "suite_name": suite.name,
        "description": suite.description,
        "aggregate": aggregate,
        "per_query": cases,
        "training_rows": [case.get("training_row") for case in cases if isinstance(case.get("training_row"), dict)],
        "started_at": started.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "triggered_by": triggered_by,
    }
    await persist_rag_eval_result(result)
    return result


async def persist_rag_eval_result(result: dict[str, Any]) -> None:
    async with async_session() as session:
        session.add(
            BenchmarkResult(
                run_id=_str(result.get("run_id")),
                benchmark_type="synpack_retrieval_eval",
                metrics=result.get("aggregate", {}),
                per_query={
                    "cases": result.get("per_query", []),
                    "training_rows": result.get("training_rows", []),
                    "suite_name": result.get("suite_name", ""),
                    "description": result.get("description", ""),
                },
                triggered_by=_str(result.get("triggered_by")),
                started_at=datetime.fromisoformat(_str(result.get("started_at"))),
                completed_at=datetime.fromisoformat(_str(result.get("completed_at"))),
            )
        )
        await session.commit()
