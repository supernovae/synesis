# Yarn KPI Alert Pack

Use this pack to monitor staff-coder behavior uplift outcomes from `request_trajectory_v1` telemetry.

## Scope

- Table: `yarn_session_events`
- Event filter: `event_kind = 'request_trajectory_v1'`
- Time window default: last 24h (adjust to 6h/72h as needed)

## KPI Queries

## 1) Completion gate blocked rate

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  AVG(
    CASE
      WHEN COALESCE((metadata_json->'verification'->>'completion_gate_blocked')::boolean, false)
      THEN 1.0 ELSE 0.0
    END
  ) AS completion_gate_blocked_rate
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: `> 0.15` sustained for 2 buckets
- critical: `> 0.25` sustained for 2 buckets

## 2) Pre-finalize critic block rate

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  AVG(
    CASE
      WHEN COALESCE((metadata_json->'verification'->>'critic_blocked')::boolean, false)
      THEN 1.0 ELSE 0.0
    END
  ) AS critic_block_rate
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: `> 0.10`
- critical: `> 0.20`

## 3) First-pass verify rate

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  AVG(
    CASE
      WHEN COALESCE((metadata_json->'verification'->>'first_pass_verify_ok')::boolean, false)
      THEN 1.0 ELSE 0.0
    END
  ) AS first_pass_verify_rate
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: drops by `>= 10%` relative to prior 7-day baseline
- critical: drops by `>= 20%`

## 4) Structured parser coverage

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  AVG(COALESCE((metadata_json->'verification'->>'structured_error_coverage')::float, 0)) AS structured_error_coverage
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: below `0.50`
- critical: below `0.35`

## 5) Blind retry rate

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  AVG(
    CASE
      WHEN COALESCE((metadata_json->'tools'->>'blind_retry_count')::int, 0) > 0
      THEN 1.0 ELSE 0.0
    END
  ) AS blind_retry_rate
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: `> 0.12`
- critical: `> 0.20`

## 6) Patch ratio

```sql
SELECT
  date_trunc('hour', created_at) AS hour_bucket,
  CASE
    WHEN SUM(COALESCE((metadata_json->'edits'->>'patch_ops_count')::int, 0)
      + COALESCE((metadata_json->'edits'->>'whole_write_ops_count')::int, 0)) = 0
    THEN 0
    ELSE
      SUM(COALESCE((metadata_json->'edits'->>'patch_ops_count')::int, 0))::float
      / SUM(
        COALESCE((metadata_json->'edits'->>'patch_ops_count')::int, 0)
        + COALESCE((metadata_json->'edits'->>'whole_write_ops_count')::int, 0)
      )::float
  END AS patch_ratio
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

Alert suggestion:
- warn: `< 0.60` for micro/repo buckets
- critical: `< 0.45`

## Data quality checks

Run before acting on KPI movement:

```sql
SELECT
  COUNT(*) AS total_rows,
  SUM(CASE WHEN metadata_json->'verification' ? 'structured_error_coverage' THEN 1 ELSE 0 END) AS has_coverage,
  SUM(CASE WHEN metadata_json->'verification' ? 'completion_gate_blocked' THEN 1 ELSE 0 END) AS has_gate_flag,
  SUM(CASE WHEN metadata_json->'verification' ? 'critic_blocked' THEN 1 ELSE 0 END) AS has_critic_flag
FROM yarn_session_events
WHERE event_kind = 'request_trajectory_v1'
  AND created_at >= now() - interval '24 hours';
```

If null/missing rates spike, hold policy changes until ingestion is healthy again.
