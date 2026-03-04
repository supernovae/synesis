# Synesis Pipelines

Download Manager and Executor models to PVC. **No OCI build/push.** Deployments mount the PVC and load directly from PV — faster than OCI pull on worker nodes (recommended by support).

## Namespace: synesis-models only

**Pipelines, PVCs, and model deployments must all use `synesis-models`.** The scripts force pipeline runs into `synesis-models` so they write to the same PVCs that deployments mount. Do not use a separate Data Science project for model pipelines.

## Pipelines

| Pipeline | Model | Steps | Runtime |
|----------|-------|-------|---------|
| **Manager** | Qwen2.5-32B-Instruct-AWQ | HF download → PVC | ~10–20 min |
| **Executor** | DeepSeek-R1-Distill-Qwen-32B FP8 | Clean PVC → HF download → PVC | ~10–20 min |

## Prerequisites

- OpenShift AI with Data Science Pipelines (DSPA) — KFP host discovered from `synesis` or `synesis-models`
- `hf-hub-secret` in **synesis-models** (optional, for gated models)
- PVCs in **synesis-models**: `modelcar-build-pvc` (120Gi), `executor-build-pvc` (50Gi, FP8 ~33GB)

**If runs still land in synesis:** DSPA executes workloads in its own namespace. Move DSPA to synesis-models, or create a new DSPA in synesis-models for model pipelines. The `run-pipelines.sh` script exports `DS_PROJECT=synesis-models` and the KFP client requests that namespace; the server may override this if DSPA is namespace-scoped.

## Bootstrap (once)

Create PVCs (gp3-high = 16K IOPS, 1 GiB/s; apply StorageClass once as cluster-admin):

```bash
oc apply -f pipelines/manifests/storage-class-gp3-high.yaml   # cluster-admin, once
export NS=synesis-models   # or your DS project — must match pipeline + deployment
sed "s/NAMESPACE/$NS/" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -
sed "s/NAMESPACE/$NS/" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -
```

To **clean old model before switching** (e.g. Qwen3.5 → Qwen2.5):

```bash
./scripts/cleanup-model-pvc.sh              # modelcar-build-pvc (manager)
./scripts/cleanup-model-pvc.sh executor-build-pvc   # executor model
# Then re-download: ./scripts/run-pipelines.sh manager
```

To **recreate PVCs** (e.g. resize; data is lost):

```bash
oc delete pvc modelcar-build-pvc executor-build-pvc -n synesis-models --ignore-not-found
# Then rerun the sed | oc apply commands above
```

## Cleaning up old PVCs (migration)

If you have model PVCs in another namespace (e.g. `synesis`), delete them after migrating to synesis-models:

```bash
# Delete old model PVCs from synesis (keep mariadb-dspa for DSPA)
oc delete pvc modelcar-build-pvc executor-build-pvc -n synesis --ignore-not-found
```

Then re-run pipelines in synesis-models so models land in the correct PVCs.

## Invoke Pipelines

```bash
export KFP_HOST=https://<pipelines-route>

./scripts/run-pipelines.sh manager              # Manager: download to PVC
./scripts/run-pipelines.sh manager --validate   # 0.5B model — fast validation
./scripts/run-pipelines.sh executor             # Executor: clean PVC + download FP8
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
- `executor_pipeline.py` — Executor: clean PVC + download FP8 model to /data/executor-model
- `model-pvc-download/` — Pipeline container (uv + hf_hub); bootstrap pushes to ECR when ECR_URI set
