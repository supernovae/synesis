"""Sandbox node -- runs generated code in an isolated OpenShift sandbox pod.

Formerly executor_node. Creates an ephemeral K8s Job in the synesis-sandbox
namespace with deny-all networking, restricted SCC, and no privilege escalation.
The Job runs linting, security scanning, and code execution, returning structured JSON.

Two-Phase Commit: When Worker outputs patch_ops (multi-file), bundles them into
a runnable script that creates files and runs the command. Works with existing
single-script Sandbox.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from typing import Any

from ..config import settings
from ..failfast_cache import cache as failfast_cache
from ..failure_store import compute_failure_id, store_failure
from ..revision_constraints import REVISION_CONSTRAINTS, STRATEGY_CANDIDATES_BY_FAILURE
from ..schemas import make_tool_ref
from ..state import NodeOutcome, NodeTrace

_background_tasks: set[asyncio.Task] = set()

logger = logging.getLogger("synesis.executor")

try:
    from prometheus_client import Counter, Histogram

    _sandbox_execution_counter = Counter(
        "synesis_sandbox_executions_total",
        "Total sandbox executions by outcome and language",
        ["outcome", "language"],
    )
    _sandbox_latency_histogram = Histogram(
        "synesis_sandbox_duration_seconds",
        "Sandbox execution latency",
        ["language"],
        buckets=[0.5, 1, 2, 5, 10, 15, 30, 60],
    )
    _sandbox_failure_type_counter = Counter(
        "synesis_sandbox_failures_by_type_total",
        "Sandbox failures by error type",
        ["error_type", "language"],
    )
    _warm_pool_counter = Counter(
        "synesis_sandbox_warm_pool_total",
        "Warm pool usage: hit (served by warm pod) vs fallback (K8s Job)",
        ["result"],
    )
except Exception:
    _sandbox_execution_counter = None
    _sandbox_latency_histogram = None
    _sandbox_failure_type_counter = None
    _warm_pool_counter = None


def _bundle_patch_ops_to_script(
    patch_ops: list,
    language: str,
    experiment_plan: dict | None,
    attempt_id: str = "0",
) -> str:
    """Two-Phase Commit: convert patch_ops to a bash script. §7.4: canonical order by (path, op). §7.5: experiments under .synesis/experiments/<attempt_id>/."""
    if not patch_ops:
        return ""

    # Canonical apply order (§7.4)
    def _key(o: dict) -> tuple[str, str]:
        path = o.get("path", "") if isinstance(o, dict) else getattr(o, "path", "")
        op = o.get("op", "modify") if isinstance(o, dict) else getattr(o, "op", "modify")
        return (path, op)

    sorted_ops = sorted(patch_ops, key=_key)
    parts = ["#!/bin/bash", "set -euo pipefail", ""]
    for op in sorted_ops:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        op_type = op.get("op", "modify") if isinstance(op, dict) else getattr(op, "op", "modify")
        if not path:
            continue
        if op_type == "delete":
            parts.append(f"rm -f {path!r}")
            continue
        dir_part = path.rsplit("/", 1)[0] if "/" in path else ""
        if dir_part:
            parts.append(f"mkdir -p {dir_part!r}")
        b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        parts.append(f"echo {b64!r} | base64 -d > {path!r}")
        parts.append("")
    cmd = "python -m pytest" if language in ("python", "py") else "true"
    if experiment_plan and isinstance(experiment_plan, dict):
        cmds = experiment_plan.get("commands", [])
        if cmds:
            cmd = " ".join(str(c) for c in cmds)
    elif hasattr(experiment_plan, "commands") and getattr(experiment_plan, "commands", []):
        cmd = " ".join(getattr(experiment_plan, "commands", []))
    # §7.5: Establish experiment workspace; commands run from repo root (patch files there)
    if experiment_plan and cmd != "true":
        parts.insert(-1, f"mkdir -p .synesis/experiments/{attempt_id}")
        parts.insert(-1, f"export SYNESIS_EXPERIMENT_DIR=.synesis/experiments/{attempt_id}")
        parts.insert(-1, "")
    parts.append(cmd)
    return "\n".join(parts)


LANGUAGE_EXTENSIONS = {
    "bash": "sh",
    "shell": "sh",
    "sh": "sh",
    "python": "py",
    "javascript": "js",
    "js": "js",
    "typescript": "ts",
    "ts": "ts",
    "c": "c",
    "cpp": "cpp",
    "c++": "cpp",
    "java": "java",
    "go": "go",
}


async def _create_sandbox_job(
    code: str,
    language: str,
    run_id: str,
) -> str:
    """Create a ConfigMap with code and a Job to execute it. Returns Job name."""
    from kubernetes_asyncio import client, config
    from kubernetes_asyncio.client.api_client import ApiClient

    try:
        config.load_incluster_config()
    except config.ConfigException:
        await config.load_kube_config()

    ext = LANGUAGE_EXTENSIONS.get(language, "txt")
    filename = f"script.{ext}"
    namespace = settings.sandbox_namespace
    job_name = f"sandbox-{run_id}"
    cm_name = f"sandbox-code-{run_id}"

    metadata_json = json.dumps({"language": language, "filename": filename})

    async with ApiClient() as api:
        core = client.CoreV1Api(api)
        batch = client.BatchV1Api(api)

        cm = client.V1ConfigMap(
            metadata=client.V1ObjectMeta(
                name=cm_name,
                namespace=namespace,
                labels={"app.kubernetes.io/part-of": "synesis", "synesis.io/sandbox-run": run_id},
            ),
            data={filename: code, "metadata.json": metadata_json},
        )
        await core.create_namespaced_config_map(namespace=namespace, body=cm)

        job = client.V1Job(
            metadata=client.V1ObjectMeta(
                name=job_name,
                namespace=namespace,
                labels={"app.kubernetes.io/part-of": "synesis", "synesis.io/sandbox-run": run_id},
            ),
            spec=client.V1JobSpec(
                active_deadline_seconds=settings.sandbox_timeout_seconds,
                ttl_seconds_after_finished=300,
                backoff_limit=0,
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(
                        labels={"synesis.io/sandbox-run": run_id},
                    ),
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        image_pull_secrets=[
                            client.V1LocalObjectReference(name="ghcr-pull-secret"),
                        ],
                        security_context=client.V1PodSecurityContext(
                            run_as_non_root=True,
                            seccomp_profile=client.V1SeccompProfile(type="RuntimeDefault"),
                        ),
                        containers=[
                            client.V1Container(
                                name="sandbox",
                                image=settings.sandbox_image,
                                security_context=client.V1SecurityContext(
                                    allow_privilege_escalation=False,
                                    read_only_root_filesystem=True,
                                    capabilities=client.V1Capabilities(drop=["ALL"]),
                                ),
                                resources=client.V1ResourceRequirements(
                                    limits={
                                        "cpu": settings.sandbox_cpu_limit,
                                        "memory": settings.sandbox_memory_limit,
                                        "ephemeral-storage": "100Mi",
                                    },
                                    requests={
                                        "cpu": "100m",
                                        "memory": "128Mi",
                                    },
                                ),
                                volume_mounts=[
                                    client.V1VolumeMount(
                                        name="code",
                                        mount_path="/sandbox/code",
                                        read_only=True,
                                    ),
                                    client.V1VolumeMount(
                                        name="tmp",
                                        mount_path="/tmp",
                                    ),
                                ],
                            ),
                        ],
                        volumes=[
                            client.V1Volume(
                                name="code",
                                config_map=client.V1ConfigMapVolumeSource(name=cm_name),
                            ),
                            client.V1Volume(
                                name="tmp",
                                empty_dir=client.V1EmptyDirVolumeSource(size_limit="50Mi"),
                            ),
                        ],
                    ),
                ),
            ),
        )
        await batch.create_namespaced_job(namespace=namespace, body=job)

    return job_name


async def _wait_for_job(job_name: str, namespace: str, timeout: int) -> dict[str, Any]:
    """Poll Job status until complete or timeout."""
    from kubernetes_asyncio import client, config
    from kubernetes_asyncio.client.api_client import ApiClient

    try:
        config.load_incluster_config()
    except config.ConfigException:
        await config.load_kube_config()

    deadline = time.monotonic() + timeout
    poll_interval = 2.0

    async with ApiClient() as api:
        batch = client.BatchV1Api(api)
        core = client.CoreV1Api(api)

        while time.monotonic() < deadline:
            job = await batch.read_namespaced_job_status(name=job_name, namespace=namespace)
            status = job.status

            if status.succeeded and status.succeeded > 0:
                return await _read_pod_logs(core, job_name, namespace)
            if status.failed and status.failed > 0:
                return await _read_pod_logs(core, job_name, namespace)

            await asyncio.sleep(poll_interval)

    return {"error": f"Job {job_name} timed out after {timeout}s", "exit_code": 124}


async def _read_pod_logs(core, job_name: str, namespace: str) -> dict[str, Any]:
    """Read structured JSON logs from the sandbox pod."""
    pods = await core.list_namespaced_pod(
        namespace=namespace,
        label_selector=f"job-name={job_name}",
    )

    if not pods.items:
        return {"error": "No pods found for job", "exit_code": 1}

    pod = pods.items[0]
    pod_name = pod.metadata.name

    try:
        logs = await core.read_namespaced_pod_log(
            name=pod_name,
            namespace=namespace,
            container="sandbox",
        )
        result = json.loads(logs)
        result["pod_name"] = pod_name
        return result
    except json.JSONDecodeError:
        return {
            "error": "Failed to parse sandbox output",
            "raw_output": logs[:4096] if logs else "",
            "exit_code": 1,
            "pod_name": pod_name,
        }
    except Exception as e:
        return {"error": str(e), "exit_code": 1, "pod_name": pod_name}


async def _cleanup_sandbox(run_id: str, namespace: str) -> None:
    """Best-effort cleanup of Job and ConfigMap."""
    from kubernetes_asyncio import client, config
    from kubernetes_asyncio.client.api_client import ApiClient

    try:
        config.load_incluster_config()
    except config.ConfigException:
        await config.load_kube_config()

    try:
        async with ApiClient() as api:
            batch = client.BatchV1Api(api)
            core = client.CoreV1Api(api)

            await batch.delete_namespaced_job(
                name=f"sandbox-{run_id}",
                namespace=namespace,
                body=client.V1DeleteOptions(propagation_policy="Background"),
            )
            await core.delete_namespaced_config_map(
                name=f"sandbox-code-{run_id}",
                namespace=namespace,
            )
    except Exception as e:
        logger.debug(f"Sandbox cleanup for {run_id}: {e}")


async def _execute_warm_pool(
    code: str,
    language: str,
    filename: str,
    *,
    request_id: str | None = None,
) -> dict[str, Any] | None:
    """Try executing via the pre-warmed sandbox pool. Returns None on failure."""
    import httpx

    if not settings.sandbox_warm_pool_enabled:
        return None

    url = f"{settings.sandbox_warm_pool_url}/execute"
    payload = {"language": language, "code": code, "filename": filename}
    headers = {}
    if request_id:
        headers["X-Synesis-Request-ID"] = request_id

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                json=payload,
                headers=headers or None,
                timeout=settings.sandbox_timeout_seconds + 2.0,
            )
        if resp.status_code == 200:
            if _warm_pool_counter:
                _warm_pool_counter.labels(result="hit").inc()
            return resp.json()
        logger.info("Warm pool returned %d, falling back to Job", resp.status_code)
    except Exception as e:
        logger.info("Warm pool unavailable (%s), falling back to Job", e)

    if _warm_pool_counter:
        _warm_pool_counter.labels(result="fallback").inc()
    return None


async def _execute_via_job(code: str, language: str, run_id: str, namespace: str) -> dict[str, Any]:
    """Create an ephemeral K8s Job and wait for it to finish."""
    job_name = await _create_sandbox_job(code, language, run_id)
    logger.info("Created sandbox job %s for %s code", job_name, language)
    result = await _wait_for_job(
        job_name,
        namespace,
        settings.sandbox_timeout_seconds + 5,
    )
    return result


async def sandbox_node(state: dict[str, Any]) -> dict[str, Any]:
    """Execute generated code in an isolated sandbox pod."""
    start = time.monotonic()
    node_name = "sandbox"

    sandbox_minutes_used = state.get("sandbox_minutes_used", 0.0)
    if sandbox_minutes_used >= settings.max_sandbox_minutes:
        return {
            "current_node": node_name,
            "next_node": "respond",
            "error": f"Sandbox time limit reached ({settings.max_sandbox_minutes} min). Partial result may be available.",
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="Budget limit reached",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=0,
                )
            ],
        }

    if not settings.sandbox_enabled:
        logger.info("Sandbox disabled, skipping execution")
        return {
            "current_node": node_name,
            "next_node": "critic",
            "execution_exit_code": 0,
            "execution_lint_passed": True,
            "execution_security_passed": True,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
        }

    code = state.get("generated_code", "")
    language = state.get("target_language", "python")
    iteration = state.get("iteration_count", 0)
    patch_ops = state.get("patch_ops", []) or []
    experiment_plan = state.get("experiment_plan") or {}
    state_run_id = state.get("run_id", "") or str(uuid.uuid4())
    attempt_id = f"{state_run_id[:8]}-{iteration}"

    # Two-Phase Commit: bundle patch_ops to runnable script when code empty
    has_patch_content = any(
        (
            p.get("text") or p.get("content")
            if isinstance(p, dict)
            else getattr(p, "text", "") or getattr(p, "content", "")
        )
        for p in patch_ops
    )
    if not code.strip() and has_patch_content:
        ep = (
            experiment_plan
            if isinstance(experiment_plan, dict)
            else (experiment_plan.model_dump() if hasattr(experiment_plan, "model_dump") else {})
            if experiment_plan
            else {}
        )
        code = _bundle_patch_ops_to_script(patch_ops, language, ep, attempt_id=attempt_id)
        language = "bash"

    if not code.strip():
        return {
            "current_node": node_name,
            "next_node": "critic",
            "execution_exit_code": 0,
            "execution_lint_passed": True,
            "execution_security_passed": True,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="No code to execute",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=0,
                )
            ],
        }

    run_id = uuid.uuid4().hex[:12]
    request_id = str(uuid.uuid4())
    namespace = settings.sandbox_namespace
    ext = LANGUAGE_EXTENSIONS.get(language, "txt")
    filename = f"script.{ext}"
    used_warm_pool = False

    context_files = state.get("files_touched", []) or state.get("touched_files", [])
    sandbox_params = {
        "code": code[:2000],
        "language": language,
        "context_files": context_files[:20] if context_files else [],
    }

    try:
        result = await _execute_warm_pool(code, language, filename, request_id=request_id)
        if result is not None:
            used_warm_pool = True
        else:
            result = await _execute_via_job(code, language, run_id, namespace)

        tool_ref = make_tool_ref("sandbox", sandbox_params, result, request_id=request_id)
        existing_refs = state.get("tool_refs") or []

        exit_code = result.get("exit_code", 1)
        lint_data = result.get("lint", {}) or {}
        security_data = result.get("security", {}) or {}
        exec_data = result.get("execution", {}) or {}
        lint_passed = lint_data.get("passed", True) if isinstance(lint_data, dict) else True
        security_passed = security_data.get("passed", True) if isinstance(security_data, dict) else True
        pod_name = result.get("pod_name", "")

        # Debug: surface sandbox result so failures are not a black box
        top_level_error = result.get("error", "")
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "sandbox_result_raw",
                extra={
                    "result_keys": list(result.keys()),
                    "exit_code": exit_code,
                    "top_level_error": top_level_error[:200] if top_level_error else None,
                    "lint_passed": lint_passed,
                    "security_passed": security_passed,
                    "lint_output_preview": str(lint_data.get("output", ""))[:200],
                    "security_output_preview": str(security_data.get("output", ""))[:200]
                    if isinstance(security_data, dict)
                    else "",
                    "exec_output_preview": str(exec_data.get("output", ""))[:200]
                    if isinstance(exec_data, dict)
                    else "",
                    "code_preview": (code[:80] + "..." if len(code) > 80 else code),
                    "warm_pool": used_warm_pool,
                },
            )
        if exit_code != 0:
            lint_out = str(lint_data.get("output", ""))[:400] if isinstance(lint_data, dict) else ""
            sec_out = str(security_data.get("output", ""))[:400] if isinstance(security_data, dict) else ""
            exec_out = str(exec_data.get("output", ""))[:400] if isinstance(exec_data, dict) else ""
            # Warm pool parse failures put stdout/stderr at top level
            raw_stdout = str(result.get("stdout", ""))[:400]
            raw_stderr = str(result.get("stderr", ""))[:400]
            failure_type_log = (
                "lint"
                if not lint_passed
                else ("security" if not security_passed else "runtime")
            )
            exec_out_display = exec_out or raw_stdout or raw_stderr
            logger.warning(
                "sandbox_failure_detail exit_code=%s lint_ok=%s sec_ok=%s type=%s exec_out=%s",
                exit_code,
                lint_passed,
                security_passed,
                failure_type_log,
                (exec_out_display or top_level_error or "")[:300],
                extra={
                    "exit_code": exit_code,
                    "lint_passed": lint_passed,
                    "security_passed": security_passed,
                    "failure_type": failure_type_log,
                    "top_level_error": top_level_error[:300] if top_level_error else None,
                    "lint_output": lint_out if not lint_passed else "(passed)",
                    "security_output": sec_out[:200] if not security_passed else "(passed)",
                    "execution_output": exec_out_display,
                    "code_preview": (code[:120] + "..." if len(code) > 120 else code),
                    "language": language,
                    "iteration": iteration,
                },
            )

        strategy_updates: dict[str, Any] = {}
        failure_type = "runtime"
        if not lint_passed:
            failure_type = "lint"
        elif not security_passed:
            failure_type = "security"
        elif state.get("lsp_diagnostics"):
            failure_type = "lsp"

        if exit_code == 0:
            next_node = "critic"
            outcome = NodeOutcome.SUCCESS
        else:
            # Same-failure short-circuit: if we've seen this exact (code, error) before, don't retry
            failure_ids_seen = state.get("failure_ids_seen", []) or []
            current_failure_id = compute_failure_id(code, result)
            same_failure = current_failure_id in failure_ids_seen
            if same_failure:
                logger.warning(
                    "same_failure_repeated failure_id=%s",
                    current_failure_id[:16],
                    extra={"iteration": iteration},
                )
                next_node = "critic"  # postmortem instead of another retry
                strategy_updates["failure_type"] = failure_type
            else:
                strategy_updates["failure_ids_seen"] = [*failure_ids_seen, current_failure_id]

            max_iter = state.get("max_iterations", settings.max_iterations)
            if not same_failure and iteration + 1 < max_iter:
                next_node = "worker"
                # Set strategy_candidates and revision_strategy from failure type
                prev_stages = state.get("stages_passed", [])
                curr_strategy = state.get("revision_strategy", "")
                preserve_stages = (state.get("revision_constraints") or {}).get("preserve_stages", [])
                strategy_violation = False
                if prev_stages and preserve_stages:
                    if (not lint_passed and "lint" in preserve_stages and "lint" in prev_stages) or (
                        not security_passed and "security" in preserve_stages and "security" in prev_stages
                    ):
                        strategy_violation = True
                if strategy_violation:
                    revision_strategies_tried = [*state.get("revision_strategies_tried", []), curr_strategy]
                else:
                    revision_strategies_tried = state.get("revision_strategies_tried", [])

                high_iteration = iteration + 1 >= max(2, max_iter - 1)
                candidates = STRATEGY_CANDIDATES_BY_FAILURE.get(failure_type, STRATEGY_CANDIDATES_BY_FAILURE["default"])
                # High iteration: prefer refactor (constraint degradation)
                if high_iteration and "refactor" not in revision_strategies_tried:
                    refactor_cand = next(
                        (c for c in candidates if isinstance(c, dict) and c.get("name") == "refactor"),
                        None,
                    )
                    if refactor_cand:
                        chosen = "refactor"
                    else:
                        chosen = None
                else:
                    chosen = None
                if chosen is None:
                    for c in candidates:
                        name = c.get("name", "") if isinstance(c, dict) else ""
                        if name and name not in revision_strategies_tried:
                            chosen = name
                            break
                if not chosen and candidates:
                    chosen = (
                        candidates[0].get("name", "minimal_fix") if isinstance(candidates[0], dict) else "minimal_fix"
                    )
                strategy_updates = {
                    "failure_type": failure_type,
                    "strategy_candidates": candidates,
                    "revision_strategy": chosen or "minimal_fix",
                    "revision_strategies_tried": revision_strategies_tried,
                    "revision_constraints": REVISION_CONSTRAINTS.get(chosen or "minimal_fix", {}),
                    "strategy_violation": strategy_violation,
                    "failure_ids_seen": [*failure_ids_seen, current_failure_id],
                }
                # Monotonicity: record stages that passed (do not regress on retry)
                stages_passed: list[str] = []
                if lint_passed:
                    stages_passed.append("lint")
                if security_passed:
                    stages_passed.append("security")
                strategy_updates["stages_passed"] = stages_passed
            else:
                next_node = "critic"  # postmortem path
                strategy_updates["failure_type"] = failure_type
            outcome = NodeOutcome.NEEDS_REVISION

        latency = (time.monotonic() - start) * 1000

        # Record Prometheus metrics
        if _sandbox_execution_counter:
            outcome_label = "success" if exit_code == 0 else "failure"
            _sandbox_execution_counter.labels(outcome=outcome_label, language=language).inc()
        if _sandbox_latency_histogram:
            _sandbox_latency_histogram.labels(language=language).observe(latency / 1000.0)
        if _sandbox_failure_type_counter and exit_code != 0:
            err_type = "runtime"
            if not lint_passed:
                err_type = "lint"
            elif not security_passed:
                err_type = "security"
            elif exit_code == 124:
                err_type = "timeout"
            _sandbox_failure_type_counter.labels(error_type=err_type, language=language).inc()

        logger.info(
            "sandbox_completed",
            extra={
                "exit_code": exit_code,
                "lint_passed": lint_passed,
                "security_passed": security_passed,
                "next_node": next_node,
                "iteration": iteration,
                "latency_ms": latency,
                "pod": pod_name,
            },
        )

        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"exit_code={exit_code}, lint={'pass' if lint_passed else 'fail'}, security={'pass' if security_passed else 'fail'}",
            confidence=1.0 if exit_code == 0 else 0.3,
            outcome=outcome,
            latency_ms=latency,
        )

        # Increment iteration on failure. Do NOT increment on strategy_violation (monotonicity regression).
        strategy_violation = strategy_updates.get("strategy_violation", False)
        if exit_code == 0 or strategy_violation:
            new_iteration = iteration
        else:
            new_iteration = iteration + 1

        # Update failure store and fail-fast cache
        task_desc = state.get("task_description", "")
        result_json = json.dumps(result, default=str)
        if exit_code != 0:
            task = asyncio.create_task(
                store_failure(
                    code=code,
                    execution_result_json=result_json,
                    task_description=task_desc,
                    language=language,
                )
            )
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
            error_summary = ""
            if not lint_passed:
                error_summary += f"Lint: {str(lint_data.get('output', ''))[:256]}. "
            if not security_passed:
                error_summary += "Security issues found. "
            exec_out = exec_data.get("output", "") if isinstance(exec_data, dict) else ""
            if exec_out:
                error_summary += f"Runtime: {exec_out[:256]}"
            failfast_cache.put(task_desc, language, "failure", code, error_summary)
        else:
            failfast_cache.put(task_desc, language, "success", code)

        latency_minutes = (time.monotonic() - start) / 60.0
        return {
            "execution_result": json.dumps(result, default=str),
            "execution_exit_code": exit_code,
            "execution_lint_passed": lint_passed,
            "execution_security_passed": security_passed,
            "execution_sandbox_pod": pod_name,
            "attempt_id": attempt_id,
            "current_node": node_name,
            "next_node": next_node,
            "iteration_count": new_iteration,
            "sandbox_minutes_used": sandbox_minutes_used + latency_minutes,
            "tool_refs": [*existing_refs, tool_ref.model_dump()],
            "node_traces": [trace],
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": strategy_updates.get("failure_ids_seen") or state.get("failure_ids_seen", []),
            **strategy_updates,
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("sandbox_error")
        trace = NodeTrace(
            node_name=node_name,
            reasoning=f"Sandbox error: {e}",
            confidence=0.0,
            outcome=NodeOutcome.ERROR,
            latency_ms=latency,
        )
        return {
            "current_node": node_name,
            "next_node": "critic",
            "execution_exit_code": None,
            "error": f"Sandbox execution failed: {e}",
            "node_traces": [trace],
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
        }

    finally:
        if not used_warm_pool:
            task = asyncio.create_task(_cleanup_sandbox(run_id, namespace))
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
