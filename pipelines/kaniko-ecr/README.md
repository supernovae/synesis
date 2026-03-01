# kaniko-ecr

Container image for building and pushing ModelCar images to ECR from OpenShift AI pipelines. Includes aws-cli (for IRSA → ECR auth) and Kaniko.

Used by `nvfp4_executor_pipeline.py` (Executor) and `manager_modelcar_pipeline.py` (Manager). Must be built from this repo and pushed to your ECR before running pipelines.

## Build and Push

From the **repo root**:

```bash
export ECR_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/your-repo"
podman build -f pipelines/kaniko-ecr/Containerfile -t ${ECR_URI}/kaniko-ecr:latest pipelines/kaniko-ecr/
podman push ${ECR_URI}/kaniko-ecr:latest
```

Or run the build script:

```bash
./pipelines/kaniko-ecr/build.sh
```

Set `ECR_URI` before running (see script for default).

## Files

| File | Purpose |
|------|---------|
| `Containerfile` | Main image (aws-cli + Kaniko + wrapper scripts) |
| `Containerfile.modelcar` | ModelCar for NVFP4 output (context = quantized dir) |
| `modelcar-src/` | ModelCar for Manager (download-from-HF during build) |
| `ecr-login-and-kaniko.sh` | IRSA → Kaniko (NVFP4 / pre-built model dir) |
| `ecr-login-and-kaniko-modelcar.sh` | IRSA → Kaniko (Manager: HF download during build) |
| `build.sh` | Build and push helper script |
