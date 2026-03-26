# Synesis Yarn TS

Node 22 TypeScript orchestration service prototype for replacing Python Yarn.

## Design Highlights

- Vercel AI SDK Core (`ai`) as direct dependency.
- `customProvider` mapping for Synesis tiers to admin-owned provider/model assignments.
- Zod-validated API contracts.
- Sawtooth context manager with consolidation and log masking.
- Repeat-loop hard pivot guard.

## Run Locally

```bash
npm install
npm run dev
```

The service listens on `0.0.0.0:8000` by default.

## Important Environment Variables

- `SYNESIS_YARN_ADMIN_API_URL`
- `SYNESIS_INTERNAL_SERVICE_TOKEN`
- `SYNESIS_YARN_DEFAULT_TIER`
- `SYNESIS_YARN_TIER_POLL_INTERVAL`
- `SYNESIS_YARN_OPENAI_COMPAT_BASE_URL`
- `SYNESIS_YARN_OPENAI_COMPAT_API_KEY`

## Current Scope

This is the first implementation pass focused on:

- protocol skeleton,
- provider tier polling and resolution,
- sawtooth core primitives,
- safety middleware hooks.

Advanced parity features (full MCP parity, persistence parity, and full streaming/tool lifecycle parity) are targeted in subsequent phases.
