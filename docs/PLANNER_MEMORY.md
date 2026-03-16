# Planner Memory and OOM Debugging

Notes on why planner memory can balloon for a single user, instrumentation added to debug it, and an audit of the graph for crash loops and overload.

---

## Why memory can balloon (single user)

- **State size per request**: Each run carries `evidence_packets` (merged by query/section_id but can grow over critic→router loops), `node_traces` (append-only per node run), `tool_refs`, `messages`, `execution_plan`, and `generated_code`. Long prompts, many deliverables, or multiple critic iterations increase state size.
- **Streaming accumulator**: The SSE generator keeps `accumulated_state` and builds content (and optionally reasoning buffers) for the whole stream. Large responses increase in-process memory for the duration of the request.
- **Conversation memory**: L1 in-memory store (`conversation_memory`) holds history per scope; `memory_max_turns_per_user` and `memory_max_users` cap size but long chats still use more.
- **Checkpointer**: With Redis checkpointer, full state is in Redis per thread; with in-memory checkpointer (e.g. dev), state is in process.
- **No per-request state cap**: There are no hard limits on `evidence_packets` length or `node_traces` length; only reducer semantics (merge/dedupe) and `max_iterations` / oscillation termination bound the number of graph steps.

---

## Instrumentation

- **Logs**
  - `request_start`: At the beginning of each `/v1/chat/completions` request we log `request_memory_sample` with `label=request_start`, `rss_mib`, and `cgroup_mib`.
  - `request_end`: When the request finishes (stream or non-stream, success or error) we log `request_memory_sample` with `label=request_end`, `rss_mib`, `cgroup_mib`, and when state is available: `state_evidence_packets`, `state_node_traces`, `state_messages`.
  - Use these to correlate memory growth with long runs, high iteration count, or large state sizes.

- **Prometheus**
  - `synesis_planner_memory_rss_mib`: Gauge of process RSS in MiB, updated at request end. Use for OOM correlation and trend (e.g. `avg_over_time(synesis_planner_memory_rss_mib[5m])`).
  - `synesis_planner_memory_cgroup_mib`: Gauge of cgroup memory usage when available (e.g. in Kubernetes). Exposed on `GET /metrics`.

- **Startup**
  - `startup_memory_checkpoint` and `graph_init_memory` (in graph.py) log RSS at startup and after graph compile for baseline comparison.

---

## Graph audit: crash loops and overload

- **Retry / iteration caps**
  - `max_iterations` (default 3) caps critic→writer/router loops; at `iteration >= max_iter` we route to `final_scrubber`, so we do not loop indefinitely.
  - `oscillation_threshold` (default 0.7): when `detect_oscillation(state).total_score` exceeds it, we force-route to `final_scrubber` instead of writer/router, terminating the retry loop.

- **Node timeouts**
  - Each node is wrapped with `with_timeout(timeout_seconds)`. On `TimeoutError` the node returns a structured error state and routes to `respond`; the process does not retry the node or crash. `asyncio.CancelledError` is re-raised (task cancellation).

- **Node exceptions**
  - Planner and executor catch exceptions and return error state (e.g. `next_node: "respond"`, `error: str(e)`); they do not re-raise, so no uncaught exception crash loop.
  - Router and other nodes are not audited here line-by-line but follow the same pattern: return state updates; timeouts hand off to respond.

- **Planner fallback**
  - After 2 consecutive planner errors, the planner node produces a minimal fallback plan and proceeds to the writer so the graph does not loop router→planner indefinitely.

- **Conclusion**
  - No unbounded retry loop: iteration and oscillation are capped; timeouts and node error handling route to respond. OOM risk is from **single-request memory usage** (large state, long stream, big prompts) rather than from repeated failing steps. Use the new memory instrumentation to identify which requests or state shapes drive RSS up before OOMKill.

---

## References

- Planner request handling: `base/planner/app/main.py` — `_sample_memory_and_log`, `_get_rss_mib`, `_get_cgroup_mib`
- Metrics: `base/planner/app/api_metrics.py` — `record_memory_after_request`, `synesis_planner_memory_*`
- Graph routing and caps: `base/planner/app/graph.py` — `route_after_critic`, `with_timeout`; `base/planner/app/config.py` — `max_iterations`, `oscillation_threshold`
- State reducers: `base/planner/app/reducers.py` — `_merge_evidence_packets`; `base/planner/app/state.py` — GraphState
