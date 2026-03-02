# Unix Domain Socket (UDS) Setup

Planner talks to vLLM models via Unix domain sockets when co-located on the same GPU node. This avoids OVN/cluster network traffic and reduces latency.

**Note:** OpenShift managed clusters typically block hostPath volumes. The base manifests use HTTP over ClusterIP. UDS is only available when hostPath is allowed (e.g. via custom SCC or self-managed cluster).

## Architecture

```
Node (GPU)
├── synesis-supervisor-critic-predictor
│   ├── vllm-supervisor-critic (port 8080)
│   └── uds-proxy (socat) → listens on /var/lib/synesis/vllm-sockets/supervisor.sock → forwards to 127.0.0.1:8080
├── synesis-executor-predictor
│   ├── vllm-executor (port 8080)
│   └── uds-proxy (socat) → listens on /var/lib/synesis/vllm-sockets/executor.sock → forwards to 127.0.0.1:8080
└── synesis-planner
    └── connects via UDS to supervisor.sock and executor.sock (no IP/OVN)
```

**LangChain** uses `httpx.HTTPTransport(uds=path)` when `*_MODEL_UDS` is set. All nodes (supervisor, planner, critic, advisor, worker) use the socket for model calls.

## Prerequisites

1. **hostPath volume**: All three deployments mount `/var/lib/synesis/vllm-sockets` from the host. Pod Security "restricted" disallows hostPath; namespaces use `pod-security.kubernetes.io/enforce: baseline` to allow it.

2. **Same node**: Planner has `nodeSelector: nvidia.com/gpu.product: NVIDIA-L40S` and tolerations so it schedules on the GPU node with the models.

3. **securityContext**: All containers set `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `runAsNonRoot: true`, and `seccompProfile.type: RuntimeDefault` for PodSecurity compliance.

## Enabling UDS

UDS is enabled by default in the base manifests. The planner deployment sets:

- `SYNESIS_SUPERVISOR_MODEL_UDS=/var/lib/synesis/vllm-sockets/supervisor.sock`
- `SYNESIS_PLANNER_MODEL_UDS=/var/lib/synesis/vllm-sockets/supervisor.sock`
- `SYNESIS_CRITIC_MODEL_UDS=/var/lib/synesis/vllm-sockets/supervisor.sock`
- `SYNESIS_ADVISOR_MODEL_UDS=/var/lib/synesis/vllm-sockets/supervisor.sock`
- `SYNESIS_EXECUTOR_MODEL_UDS=/var/lib/synesis/vllm-sockets/executor.sock`

When `*_MODEL_UDS` is set, the planner uses the Unix socket; when empty, it falls back to HTTP (e.g. for local dev without hostPath).

## OpenShift SCC (if hostPath is blocked)

If the planner or model pods fail to start with hostPath permission errors:

```bash
# Create SCC allowing hostPath for synesis namespaces
oc adm policy add-scc-to-user hostpath -z default -n synesis-planner
oc adm policy add-scc-to-user hostpath -z default -n synesis-models
```

Or create a custom SCC that allows only the required hostPath path.

## Fallback to HTTP

To disable UDS (e.g. for CPU-only dev), remove or empty the `*_MODEL_UDS` env vars and set `*_MODEL_URL` back to the ClusterIP service URLs. The planner will use HTTP over the cluster network.

## Related

- [BLACKWELL_ARCHITECTURE.md](BLACKWELL_ARCHITECTURE.md) — Planner–vLLM co-location rationale
- [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md) — GPU node layout
