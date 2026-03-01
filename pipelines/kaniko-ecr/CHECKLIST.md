# Kaniko-ECR Pipeline Checklist

Avoid trial-and-error by verifying these **before** running the pipeline.

## 1. Image Build

```bash
# Must use linux/amd64 for OpenShift/ROSA (x86_64 nodes)
./pipelines/kaniko-ecr/build.sh
# Or: podman build --platform linux/amd64 -f pipelines/kaniko-ecr/Containerfile -t ${ECR_URI}:kaniko-ecr pipelines/kaniko-ecr/
# Verify: podman run --rm ${ECR_URI}:kaniko-ecr /usr/local/bin/kaniko-executor version
```

## 2. AWS Credentials

**Option A: IRSA** (preferred; no keys in cluster)
- Pipeline SA annotated with `eks.amazonaws.com/role-arn`
- IAM role has: `ecr:GetAuthorizationToken`, `ecr:*` on your repo

**Option B: Secret** (pipeline uses this, NOT laptop STS)
```bash
# Mint fresh creds and push to cluster (when existing secret expired):
export DS_PROJECT=<ds-project>
./scripts/mint-ecr-credentials.sh   # uses current SSO; run after aws sso login

# Or assume role (12h validity):
export ROLE_ARN=arn:aws:iam::ACCOUNT:role/your-ecr-role
./scripts/mint-ecr-credentials.sh

# IAM user keys (don't expire) — create once:
oc create secret generic aws-ecr-credentials -n <ds-project> \
  --from-literal=AWS_ACCESS_KEY_ID=AKIA... \
  --from-literal=AWS_SECRET_ACCESS_KEY=yyy
```
- IAM user needs ECR push policy (see pipelines/README.md)

## 3. Environment

| Item | Check |
|------|-------|
| `ECR_URI` | Set at compile/run (e.g. `660...amazonaws.com/byron-ai-registry`) |
| `KFP_TOKEN` | `oc whoami -t` or `export KFP_TOKEN=$(oc whoami -t)` |
| `hf-hub-secret` | Optional; for gated HuggingFace models |
| Pipeline project | Secret in same namespace as pipeline runs |

## 4. Known Constraints

| Constraint | Why |
|------------|-----|
| **linux/amd64** | ROSA nodes are x86_64; Apple Silicon builds arm64 by default |
| **imagePullPolicy: Always** | Rebuilds use same tag; cache would serve stale image |
| **/kaniko exists, chmod 777** | Kaniko expects it; restricted pods can't chown |
| **DOCKER_CONFIG=/tmp/.docker-kaniko** | Pipeline pods often have no writable $HOME |
| **Kaniko from official image** | GitHub no longer publishes executor binary |

## 5. Kaniko SCC and securityContext

KFP/DSPA rejects `securityContext` in pipeline specs (`unknown field "securityContext"`). We rely on **--ignore-path** (see ecr-login-and-kaniko-modelcar.sh) to skip newgidmap/newuidmap instead. The SCC (bootstrap applies it) is for future use if KFP adds support.

## 6. OOM / Memory

Kaniko multi-stage builds hold layer state in memory. For large models (35B), use **manager-split** pipeline: download to PVC first, then Kaniko does copy-only build. Much lower memory. Create PVC, rebuild kaniko-ecr, run `./scripts/run-pipelines.sh manager-split`.

## 7. If It Still Fails

1. **ECR 403 (reuse blob / PutImage)** → Auth or permissions. Verify aws-ecr-credentials secret has valid keys; IAM needs `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`. If using IRSA, role policy must allow push. Re-auth on laptop doesn't help — the *pod* uses cluster credentials.
2. **exec format error** → Rebuild with `--platform linux/amd64`
3. **Permission denied (mkdir ~/.docker)** → Fixed; we use /tmp
4. **Unable to locate credentials** → Create aws-ecr-credentials secret or fix IRSA
5. **chown /tmp/kaniko: operation not permitted** → Use default /kaniko (no --kaniko-dir)
6. **404 / "Not" from kaniko-executor** → Rebuild; we now copy from gcr.io/kaniko-project/executor

## 8. Test Locally (optional)

```bash
# Verify image runs (no real build)
podman run --rm -e AWS_ACCESS_KEY_ID=x -e AWS_SECRET_ACCESS_KEY=y \
  ${ECR_URI}:kaniko-ecr sh -c "echo ok"
```
