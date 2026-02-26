"""Executor node -- runs generated code in an isolated OpenShift sandbox pod.

Creates an ephemeral K8s Job in the synesis-sandbox namespace with deny-all
networking, restricted SCC, and no privilege escalation. The Job runs
linting, security scanning, and code execution, returning structured JSON.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from ..config import settings
from ..state import NodeTrace, NodeOutcome
from ..failure_store import store_failure, update_resolution
from ..failfast_cache import cache as failfast_cache

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

LANGUAGE_EXTENSIONS = {
    "bash": "sh", "shell": "sh", "sh": "sh",
    "python": "py",
    "javascript": "js", "js": "js",
    "typescript": "ts", "ts": "ts",
    "c": "c",
    "cpp": "cpp", "c++": "cpp",
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


async def _execute_warm_pool(code: str, language: str, filename: str) -> dict[str, Any] | None:
    """Try executing via the pre-warmed sandbox pool. Returns None on failure."""
    import httpx

    if not settings.sandbox_warm_pool_enabled:
        return None

    url = f"{settings.sandbox_warm_pool_url}/execute"
    payload = {"language": language, "code": code, "filename": filename}

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                json=payload,
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
        job_name, namespace, settings.sandbox_timeout_seconds + 5,
    )
    return result


async def executor_node(state: dict[str, Any]) -> dict[str, Any]:
    """Execute generated code in an isolated sandbox pod."""
    start = time.monotonic()
    node_name = "executor"

    if not settings.sandbox_enabled:
        logger.info("Sandbox disabled, skipping execution")
        return {
            "current_node": node_name,
            "next_node": "critic",
            "execution_exit_code": 0,
            "execution_lint_passed": True,
            "execution_security_passed": True,
        }

    code = state.get("generated_code", "")
    language = state.get("target_language", "bash")
    iteration = state.get("iteration_count", 0)

    if not code.strip():
        return {
            "current_node": node_name,
            "next_node": "critic",
            "execution_exit_code": 0,
            "execution_lint_passed": True,
            "execution_security_passed": True,
            "node_traces": [NodeTrace(
                node_name=node_name,
                reasoning="No code to execute",
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=0,
            )],
        }

    run_id = uuid.uuid4().hex[:12]
    namespace = settings.sandbox_namespace
    ext = LANGUAGE_EXTENSIONS.get(language, "txt")
    filename = f"script.{ext}"
    used_warm_pool = False

    try:
        result = await _execute_warm_pool(code, language, filename)
        if result is not None:
            used_warm_pool = True
        else:
            result = await _execute_via_job(code, language, run_id, namespace)

        exit_code = result.get("exit_code", 1)
        lint_data = result.get("lint", {})
        security_data = result.get("security", {})
        exec_data = result.get("execution", {})
        lint_passed = lint_data.get("passed", True) if isinstance(lint_data, dict) else True
        security_passed = security_data.get("passed", True) if isinstance(security_data, dict) else True
        pod_name = result.get("pod_name", "")

        if exit_code == 0:
            next_node = "critic"
            outcome = NodeOutcome.SUCCESS
        else:
            max_iter = state.get("max_iterations", settings.max_iterations)
            if iteration + 1 < max_iter:
                next_node = "worker"
            else:
                next_node = "respond"
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
            "executor_completed",
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

        # Increment iteration on failure so the worker sees it as a revision
        new_iteration = iteration + 1 if exit_code != 0 else iteration

        # Update failure store and fail-fast cache
        task_desc = state.get("task_description", "")
        result_json = json.dumps(result, default=str)
        if exit_code != 0:
            asyncio.create_task(store_failure(
                code=code,
                execution_result_json=result_json,
                task_description=task_desc,
                language=language,
            ))
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

        return {
            "execution_result": json.dumps(result, default=str),
            "execution_exit_code": exit_code,
            "execution_lint_passed": lint_passed,
            "execution_security_passed": security_passed,
            "execution_sandbox_pod": pod_name,
            "current_node": node_name,
            "next_node": next_node,
            "iteration_count": new_iteration,
            "node_traces": [trace],
        }

    except Exception as e:
        latency = (time.monotonic() - start) * 1000
        logger.exception("executor_error")
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
        }

    finally:
        if not used_warm_pool:
            asyncio.create_task(_cleanup_sandbox(run_id, namespace))
