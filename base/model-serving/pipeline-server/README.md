# Pipeline Server (DSPA) with S3

DataSciencePipelinesApplication manifests for OpenShift AI. Use your existing S3 bucket — **no access key/secret in the UI** when using IRSA.

## IRSA (recommended)

Pipeline SA uses IAM role for S3. No keys needed.

```bash
export DS_PROJECT=your-data-science-project
export S3_BUCKET=byron-ai-d8a35264-rhoai-data
export AWS_REGION=us-east-1

./scripts/create-pipeline-server.sh
```

**Prerequisite:** IRSA for the pipeline ServiceAccount with S3 permissions on the bucket.

## With static credentials

If IRSA isn't set up:

```bash
export DS_PROJECT=your-data-science-project
export S3_BUCKET=byron-ai-d8a35264-rhoai-data
export USE_S3_CREDENTIALS=true
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

./scripts/create-pipeline-server.sh
```

## Files

| File | Purpose |
|------|---------|
| `dspa-s3.yaml` | IRSA mode (no credentials) |
| `dspa-s3-with-credentials.yaml` | Static keys from secret |
