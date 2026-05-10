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

# Planner graph definition (unified knowledge pipeline).
# model_role: which KNOWN_ROLE (provider_catalog.py) this node uses.
# model_served_name: the runtime alias the node passes as `model=`.
GRAPH_DEFINITION = {
    "nodes": [
        {
            "id": "entry_pipeline",
            "label": "Entry Pipeline",
            "type": "entry",
            "model_role": "router",
            "model_served_name": "synesis-router",
            "notes": "Deterministic classifier + LLM frame segmentation",
        },
        {
            "id": "planner",
            "label": "Planner",
            "type": "planning",
            "model_role": "router",
            "model_served_name": "synesis-router",
        },
        {
            "id": "plan_gate",
            "label": "Plan Gate",
            "type": "planning",
            "model_role": "router",
            "model_served_name": "synesis-router",
            "notes": "Optional coherence check; mostly deterministic",
        },
        {
            "id": "router",
            "label": "Router",
            "type": "retrieval",
            "model_role": "router",
            "model_served_name": "synesis-router",
            "notes": "Evidence packet summarization uses synesis-summarizer",
        },
        {
            "id": "writer",
            "label": "Writer",
            "type": "generation",
            "model_role": "general",
            "model_served_name": "synesis-general",
        },
        {
            "id": "critic",
            "label": "Critic",
            "type": "evaluation",
            "model_role": "critic",
            "model_served_name": "synesis-critic",
        },
        {
            "id": "final_scrubber",
            "label": "Final Scrubber",
            "type": "post",
            "model_role": "general",
            "model_served_name": "synesis-general",
        },
        {
            "id": "respond",
            "label": "Respond",
            "type": "terminal",
            "model_role": None,
            "model_served_name": None,
            "notes": "SSE streaming, no LLM call",
        },
    ],
    "edges": [
        {"from": "entry_pipeline", "to": "planner", "label": "default"},
        {"from": "entry_pipeline", "to": "router", "label": "pending_question"},
        {"from": "entry_pipeline", "to": "respond", "label": "ui_helper"},
        {"from": "planner", "to": "plan_gate", "label": "always"},
        {"from": "plan_gate", "to": "planner", "label": "retry"},
        {"from": "plan_gate", "to": "router", "label": "evidence"},
        {"from": "plan_gate", "to": "respond", "label": "clarify/approve/error"},
        {"from": "router", "to": "planner", "label": "no_plan"},
        {"from": "router", "to": "writer", "label": "ready"},
        {"from": "router", "to": "respond", "label": "error"},
        {"from": "writer", "to": "respond", "label": "needs_input"},
        {"from": "writer", "to": "critic", "label": "inline_critic"},
        {"from": "writer", "to": "final_scrubber", "label": "skip_critic/bg"},
        {"from": "critic", "to": "writer", "label": "revise"},
        {"from": "critic", "to": "router", "label": "evidence_gap"},
        {"from": "critic", "to": "final_scrubber", "label": "approve"},
        {"from": "critic", "to": "respond", "label": "terminal"},
        {"from": "final_scrubber", "to": "respond"},
    ],
}


@router.get("/graph")
async def pipeline_graph(_user: UserInfo = Depends(get_current_user)):
    result = dict(GRAPH_DEFINITION)
    result["model_policies"] = await _load_active_policies()
    return result


async def _load_active_policies() -> dict:
    """Load model policies from DB for graph visualization. Returns {} if table absent."""
    try:
        async with async_session() as session:
            check = await session.execute(
                sa_text("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'model_policies')")
            )
            if not check.scalar():
                return {}
            rows = await session.execute(
                sa_text(
                    "SELECT role, condition_type, condition_value, model, label, priority "
                    "FROM model_policies WHERE enabled = true ORDER BY role, priority"
                )
            )
            policies: dict[str, list[dict]] = {}
            for row in rows:
                role = row[0]
                policies.setdefault(role, []).append(
                    {
                        "condition_type": row[1],
                        "condition_value": row[2],
                        "model": row[3],
                        "label": row[4] or "",
                        "priority": row[5],
                    }
                )
            return policies
    except Exception:
        logger.debug("model_policies load failed (table may not exist)", exc_info=True)
        return {}


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


@router.post("/critic/clear")
async def clear_critic_data(
    trace_id: str = Body(..., embed=True),
    _user: UserInfo = Depends(require_admin),
):
    """Remove critic evaluations from a trace without deleting the trace itself."""
    async with async_session() as session:
        result = await session.execute(
            sa_text("""
                UPDATE traces
                SET full_record = full_record
                    - 'background_critic'
                    - 'manual_critic'
                    - 'critic_scores'
                WHERE trace_id = :tid
                  AND (full_record ? 'background_critic'
                       OR full_record ? 'manual_critic'
                       OR full_record ? 'critic_scores')
            """),
            {"tid": trace_id},
        )
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Trace not found or no critic data to clear")
    return {"trace_id": trace_id, "cleared": True}


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
        task_frame = full_record.get("task_frame") or full_record.get("user_task") or {}
        user_query = (
            task_frame.get("main_question")
            or task_frame.get("raw_prompt")
            or task_frame.get("task_description")
            or query_snippet
        )

        for span in reversed(full_record.get("spans") or []):
            if span.get("node_name") in ("writer", "final_scrubber"):
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
        raise HTTPException(status_code=502, detail=f"Critic model returned {e.response.status_code}") from e
    except Exception as e:
        logger.warning("critic_run_failed", extra={"error": str(e)[:200], "model": model})
        raise HTTPException(status_code=502, detail=f"Failed to call critic model: {type(e).__name__}") from e

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
