# Admin archive storage

Synesis Admin can archive high-volume operational records before deleting them from the Admin database. Current archive actions cover:

- Coder session history from **Coder -> Sessions**.
- Trace activity records from the tracing activity log.

Archives are written as gzip-compressed JSONL objects to S3 or an S3-compatible blob store. The first JSONL record is a manifest, followed by typed data records. This format is intended for later replay, analysis, and training workflows without keeping all historical rows in Postgres.

## Required configuration

Set these environment variables on the Admin API deployment:

| Variable | Required | Notes |
|----------|----------|-------|
| `SYNESIS_ADMIN_ARCHIVE_S3_BUCKET` | Yes | Bucket/container for Admin archives. If unset, archive requests fail with `400` and no rows are deleted. |
| `SYNESIS_ADMIN_ARCHIVE_S3_PREFIX` | No | Object prefix. Defaults to `admin-archives`. |
| `SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL` | No | S3-compatible endpoint URL for non-AWS stores such as MinIO, Ceph RGW, or other object stores. Leave empty for AWS S3. |
| `AWS_REGION` | Usually | AWS SDK region. Defaults in the base manifest to `us-east-1`. |

Credentials are resolved by `boto3` using the normal AWS provider chain. In OpenShift/Kubernetes, prefer IRSA, workload identity, or mounted secret-backed credentials over static values in Git.

## Permissions

The Admin API identity needs object-write access to the configured bucket and prefix:

- `s3:PutObject`
- `s3:AbortMultipartUpload` if your compatible store or SDK path uses multipart uploads

Read access is not required for the current UI archive/delete flow, but grant `s3:GetObject` to the replay or analysis job that will consume archived records.

## Object layout

Archive objects are written under date-partitioned paths:

```text
<prefix>/yarn/sessions/YYYY/MM/DD/<uuid>.jsonl.gz
<prefix>/traces/YYYY/MM/DD/<uuid>.jsonl.gz
```

With the default prefix, examples are:

```text
admin-archives/yarn/sessions/2026/05/01/8dd6b3c9-....jsonl.gz
admin-archives/traces/2026/05/01/9b564f29-....jsonl.gz
```

## Operator behavior

- **Archive** writes records to object storage and leaves database rows in place.
- **Archive + delete** writes records first, then deletes rows only after the archive write succeeds.
- **Dry run** returns counts and does not write objects or delete rows.
- If `SYNESIS_ADMIN_ARCHIVE_S3_BUCKET` is empty or the object write fails, delete-after-archive actions do not remove database rows.

For cleanup operations, keep using dry run first to confirm the selected count and scope. The UI defaults age-based cleanup to 90 days.

