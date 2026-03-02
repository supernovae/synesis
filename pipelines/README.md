# Synesis Pipelines

Download Manager and Executor models to PVC. **No OCI build/push.** Deployments mount the PVC and load directly from PV — faster than OCI pull on worker nodes (recommended by support).

## Pipelines

| Pipeline | Model | Steps | Runtime |
|----------|-------|-------|---------|
| **Manager** | Qwen3.5-35B-A3B | HF download → PVC | ~15–30 min |
| **Executor** | DeepSeek-R1-Distill-Qwen-32B INT4 | HF download (pre-quant) → PVC | ~10–20 min |

## Prerequisites

- OpenShift AI with Data Science Pipelines enabled
- `hf-hub-secret` in Data Science project (optional, for gated models)
- PVCs: `modelcar-build-pvc` (120Gi), `executor-build-pvc` (50Gi)
- **Same namespace** for PVCs, pipeline runs, and deployments

## Bootstrap (once)

Create PVCs (gp3-high = 16K IOPS, 1 GiB/s; apply StorageClass once as cluster-admin):

```bash
oc apply -f pipelines/manifests/storage-class-gp3-high.yaml   # cluster-admin, once
export NS=synesis-models   # or your DS project — must match pipeline + deployment
sed "s/NAMESPACE/$NS/" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -
sed "s/NAMESPACE/$NS/" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -
```

To **recreate PVCs** (e.g. resize; data is lost):

```bash
oc delete pvc modelcar-build-pvc executor-build-pvc -n $NS --ignore-not-found
# Then rerun the sed | oc apply commands above
```

## Invoke Pipelines

```bash
export KFP_HOST=https://<pipelines-route>

./scripts/run-pipelines.sh manager              # Manager: download to PVC
./scripts/run-pipelines.sh manager --validate   # 0.5B model — fast validation
./scripts/run-pipelines.sh executor             # Executor: download INT4 to PVC
./scripts/run-pipelines.sh all                 # Both
```

Requires kfp (`uv add kfp` or `pip install kfp`) and `oc` logged in. Python components use **uv**.

## Deploy

After download completes, run `./scripts/deploy.sh dev` to apply all model deployments (supervisor-critic + executor) in the same namespace as the PVCs. Or apply manually:

```bash
oc apply -n $NS -f base/model-serving/deployment-vllm-supervisor-critic.yaml
oc apply -n $NS -f base/model-serving/deployment-vllm-executor.yaml
```

## Files

- `manager_modelcar_pipeline.py` — Manager: download to PVC at /data/models
- `nvfp4_executor_pipeline.py` — Executor: download to PVC at /data/executor-model
- `model-pvc-download/` — Pipeline container (uv + hf_hub); bootstrap pushes to ECR when ECR_URI set
