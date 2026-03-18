"""Pipeline graph, node metrics, and critic analytics."""

import json
import logging
import os
import time

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text as sa_text

from ..auth import UserInfo, get_current_user, require_admin
from ..db.engine import async_session
from ..services import critic_analytics as critic_svc
from ..services import prometheus_client_svc as prom

logger = logging.getLogger("synesis.admin.pipeline")

AVAILABLE_CRITIC_MODELS = {
    "synesis-critic": {
        "label": "Synesis Critic (local)",
        "provider": "local",
    },
    "openai/gpt-4.1": {
        "label": "GPT-4.1 (OpenRouter)",
        "provider": "openrouter",
    },
    "google/gemini-2.5-pro-preview-05-06": {
        "label": "Gemini 2.5 Pro (OpenRouter)",
        "provider": "openrouter",
    },
    "anthropic/claude-sonnet-4": {
        "label": "Claude Sonnet 4 (OpenRouter)",
        "provider": "openrouter",
    },
}

router = APIRouter(prefix="/api/v1/pipeline", tags=["pipeline"])

GRAPH_DEFINITION = {
    "nodes": [
        {"id": "entry_pipeline", "label": "Entry Pipeline", "type": "entry"},
        {"id": "router", "label": "Router", "type": "retrieval"},
        {"id": "planner", "label": "Planner", "type": "planning"},
        {"id": "executor", "label": "Executor", "type": "execution"},
        {"id": "writer", "label": "Writer", "type": "generation"},
        {"id": "patch_integrity_gate", "label": "Patch Integrity", "type": "validation"},
        {"id": "critic", "label": "Critic", "type": "evaluation"},
        {"id": "final_scrubber", "label": "Final Scrubber", "type": "post"},
        {"id": "respond", "label": "Respond", "type": "terminal"},
    ],
    "edges": [
        {"from": "entry_pipeline", "to": "router", "label": "route"},
        {"from": "entry_pipeline", "to": "writer", "label": "direct write"},
        {"from": "entry_pipeline", "to": "executor", "label": "direct exec"},
        {"from": "entry_pipeline", "to": "respond", "label": "trivial"},
        {"from": "router", "to": "planner", "label": "plan"},
        {"from": "router", "to": "executor", "label": "execute"},
        {"from": "router", "to": "writer", "label": "write"},
        {"from": "router", "to": "respond", "label": "done"},
        {"from": "planner", "to": "router", "label": "evidence gap"},
        {"from": "planner", "to": "writer", "label": "write"},
        {"from": "planner", "to": "executor", "label": "execute"},
        {"from": "planner", "to": "respond", "label": "done"},
        {"from": "executor", "to": "patch_integrity_gate", "label": "verify"},
        {"from": "executor", "to": "respond", "label": "done"},
        {"from": "writer", "to": "critic", "label": "evaluate"},
        {"from": "writer", "to": "final_scrubber", "label": "skip critic"},
        {"from": "patch_integrity_gate", "to": "router", "label": "retry"},
        {"from": "patch_integrity_gate", "to": "critic", "label": "evaluate"},
        {"from": "critic", "to": "writer", "label": "revise"},
        {"from": "critic", "to": "router", "label": "evidence gap"},
        {"from": "critic", "to": "final_scrubber", "label": "approve"},
        {"from": "critic", "to": "respond", "label": "done"},
        {"from": "final_scrubber", "to": "respond"},
    ],
}


@router.get("/graph")
async def pipeline_graph(_user: UserInfo = Depends(get_current_user)):
    return GRAPH_DEFINITION


@router.get("/metrics")
async def pipeline_metrics(_user: UserInfo = Depends(get_current_user)):
    nodes = await prom.get_pipeline_node_metrics()
    return {"nodes": nodes}


@router.get("/critic/detailed")
async def critic_detailed(
    days: int = Query(7, ge=1, le=90),
    _user: UserInfo = Depends(get_current_user),
):
    """Critic analytics from Postgres traces (full_record JSONB)."""
    data = await critic_svc.get_critic_detailed(days)
    if data is not None:
        return data
    return {
        "period_days": days,
        "total_evaluated": 0,
        "approved": 0,
        "rejected": 0,
        "approval_rate": 0.0,
        "avg_scores": {},
        "score_distribution": [
            {"bucket": "0-3", "count": 0},
            {"bucket": "3-5", "count": 0},
            {"bucket": "5-7", "count": 0},
            {"bucket": "7-8", "count": 0},
            {"bucket": "8-10", "count": 0},
        ],
        "top_failure_modes": [],
        "rejection_reasons": [],
    }


@router.get("/critic/evaluations")
async def critic_evaluations(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: UserInfo = Depends(get_current_user),
):
    """Paginated list of individual critic evaluations."""
    data = await critic_svc.get_critic_evaluations(days, limit, offset)
    if data is not None:
        return data
    return {"evaluations": [], "total": 0, "limit": limit, "offset": offset}


@router.get("/critic")
async def critic_analytics(_user: UserInfo = Depends(get_current_user)):
    """Main critic stats: try Postgres detailed first, fall back to Prometheus."""
    data = await critic_svc.get_critic_detailed(7)
    if data is not None:
        total = data["total_evaluated"]
        return {
            "total_evaluations": total,
            "approval_rate": data["approval_rate"],
            "rejection_rate": data["rejected"] / total if total > 0 else 0.0,
            "avg_score": data["avg_scores"].get("weighted_overall", 0),
            "blocking_issues": data["rejected"],
        }
    return await prom.get_critic_stats()


@router.get("/critic/models")
async def critic_models(_user: UserInfo = Depends(get_current_user)):
    """Return available critic models for manual runs."""
    has_openrouter = bool(os.environ.get("OPENROUTER_API_KEY") or os.environ.get("SYNESIS_OPENROUTER_API_KEY"))
    models = []
    for model_id, info in AVAILABLE_CRITIC_MODELS.items():
        if info["provider"] == "openrouter" and not has_openrouter:
            continue
        models.append({"id": model_id, "label": info["label"], "provider": info["provider"]})
    return {"models": models}


CRITIC_SYSTEM_PROMPT = """You are a strict evaluator of AI-generated responses.
You will be given a user prompt and the AI's response. Evaluate the response quality.

Return a JSON object with exactly these fields:
{
  "scores": {
    "weighted_overall": <1-10>,
    "task_faithfulness": <1-10>,
    "constraint_compliance": <1-10>,
    "coverage": <1-10>,
    "judgment_quality": <1-10>
  },
  "approved": <true if weighted_overall >= 7 else false>,
  "failure_modes": ["list", "of", "issues"],
  "repair_instructions": [{"priority": 1, "target": "...", "action": "...", "reason": "..."}],
  "overall_assessment": "brief assessment text"
}

Scoring guide:
- task_faithfulness: Does the response actually answer what was asked?
- constraint_compliance: Does it follow any constraints/format requirements?
- coverage: Does it address all parts of the question thoroughly?
- judgment_quality: Are recommendations/tradeoffs well-reasoned?
- weighted_overall: Holistic quality score.

Be rigorous. Return ONLY valid JSON, no markdown fences."""


@router.post("/critic/run")
async def run_critic_on_trace(
    trace_id: str = Body(...),
    model: str = Body("synesis-critic"),
    _user: UserInfo = Depends(require_admin),
):
    """Run a critic evaluation on a specific trace using the selected model.

    Fetches the trace's prompt and output, calls the critic model, and
    stores results in full_record -> 'manual_critic'.
    """
    if model not in AVAILABLE_CRITIC_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model}")

    async with async_session() as session:
        row = (
            await session.execute(
                sa_text("SELECT query_snippet, full_record FROM traces WHERE trace_id = :tid"),
                {"tid": trace_id},
            )
        ).one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Trace not found")

    query_snippet = row.query_snippet or ""
    full_record = row.full_record or {}

    user_query = ""
    final_output = ""

    if isinstance(full_record, dict):
        user_task = full_record.get("user_task") or {}
        user_query = user_task.get("raw_prompt") or user_task.get("task_description") or query_snippet

        for span in reversed(full_record.get("spans") or []):
            if span.get("node_name") in ("writer", "final_scrubber", "executor"):
                for llm_call in reversed(span.get("llm_calls") or []):
                    if llm_call.get("completion_full") or llm_call.get("completion_snippet"):
                        final_output = llm_call.get("completion_full") or llm_call.get("completion_snippet", "")
                        break
                if final_output:
                    break

    if not user_query:
        user_query = query_snippet
    if not final_output:
        final_output = full_record.get("generated_code") or full_record.get("code_explanation") or ""

    if not final_output:
        raise HTTPException(status_code=400, detail="No output found in trace to critique")

    user_content = f"## User Prompt\n{user_query[:4000]}\n\n## AI Response\n{final_output[:12000]}"

    model_info = AVAILABLE_CRITIC_MODELS[model]
    t0 = time.monotonic()

    try:
        if model_info["provider"] == "openrouter":
            api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("SYNESIS_OPENROUTER_API_KEY", "")
            if not api_key:
                raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY not configured")
            api_base = "https://openrouter.ai/api/v1"
            headers = {"Authorization": f"Bearer {api_key}"}
        else:
            api_base = os.environ.get(
                "SYNESIS_CRITIC_MODEL_URL",
                "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
            )
            headers = {}

        async with httpx.AsyncClient(timeout=120.0) as http:
            resp = await http.post(
                f"{api_base.rstrip('/')}/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": CRITIC_SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    "max_tokens": 4096,
                    "temperature": 0.1,
                },
            )
            resp.raise_for_status()
            completion = resp.json()
    except httpx.HTTPStatusError as e:
        logger.warning("critic_run_http_error", extra={"status": e.response.status_code, "model": model})
        raise HTTPException(status_code=502, detail=f"Critic model returned {e.response.status_code}")
    except Exception as e:
        logger.warning("critic_run_failed", extra={"error": str(e)[:200], "model": model})
        raise HTTPException(status_code=502, detail=f"Failed to call critic model: {type(e).__name__}")

    latency_ms = round((time.monotonic() - t0) * 1000)

    raw_content = ""
    choices = completion.get("choices") or []
    if choices:
        raw_content = (choices[0].get("message") or {}).get("content", "")

    scores = {}
    failure_modes: list[str] = []
    repair_instructions: list[dict] = []
    approved = False
    overall_assessment = ""

    try:
        cleaned = raw_content.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        parsed = json.loads(cleaned)
        scores = parsed.get("scores") or {}
        approved = parsed.get("approved", False)
        failure_modes = parsed.get("failure_modes") or []
        repair_instructions = parsed.get("repair_instructions") or []
        overall_assessment = parsed.get("overall_assessment", "")
    except (json.JSONDecodeError, KeyError):
        logger.warning("critic_run_parse_failed", extra={"raw_length": len(raw_content)})
        overall_assessment = raw_content[:2000]

    critic_result = {
        "scores": scores,
        "approved": approved,
        "failure_modes": failure_modes,
        "repair_instructions": repair_instructions,
        "overall_assessment": overall_assessment,
        "model": model,
        "model_label": model_info["label"],
        "latency_ms": latency_ms,
        "run_at": time.time(),
        "triggered_by": "admin_ui",
    }

    async with async_session() as session:
        await session.execute(
            sa_text("""
                UPDATE traces
                SET full_record = jsonb_set(
                    COALESCE(full_record, '{}'::jsonb),
                    '{manual_critic}',
                    :data::jsonb
                )
                WHERE trace_id = :tid
            """),
            {"data": json.dumps(critic_result, default=str), "tid": trace_id},
        )
        await session.commit()

    return {
        "trace_id": trace_id,
        "model": model,
        "model_label": model_info["label"],
        "scores": scores,
        "approved": approved,
        "failure_modes": failure_modes,
        "repair_instructions": repair_instructions,
        "overall_assessment": overall_assessment,
        "latency_ms": latency_ms,
    }
