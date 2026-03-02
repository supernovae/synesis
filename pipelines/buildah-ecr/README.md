# Buildah-ECR: Red Hat stack for ModelCar builds

Buildah + AWS CLI for building OCI ModelCar images and pushing to ECR. Red Hat stack; 10GB layer splitting for universal registry compatibility.

## Features

- **Red Hat native**: UBI9 + Buildah + AWS CLI
- **Logical layering**: Metadata (config, tokenizer) in one layer; model shards ~20GB per layer
- **ECR compliant**: Stays under 50GB layer limit; parallel pull benefits on deploy
- **IRSA auth**: Uses `aws ecr get-login-password` for ECR credentials

## Build

```bash
export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
./pipelines/buildah-ecr/build.sh
```

## Prerequisites

- Buildah SCC applied and granted to pipeline service account:
  ```bash
  oc apply -f pipelines/manifests/buildah-scc.yaml
  oc adm policy add-scc-to-user buildah-capabilities -z pipeline-runner-dspa -n <DS_PROJECT>
  ```

## Used by

- Manager pipeline: `ecr-login-and-buildah-modelcar-pvc.sh` (download → build+push → ECR, PVC cleanup)
- Executor pipeline: `ecr-login-and-buildah.sh`
